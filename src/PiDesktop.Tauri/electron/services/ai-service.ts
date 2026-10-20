import { CredentialRouter, createCredentialMetadata } from "@model-auth/core";
import { createLocalCredentialStore, type CredentialStore } from "./local-credential-store.js";
import { dirname } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { AgentRuntimeWorker } from "@synthv-toolbox/agent-runtime";
import type { PiCredential, PiCredentialStore, PiModelSelection } from "@synthv-toolbox/agent-runtime";
import {
  AGENT_EFFORT_LEVELS,
  AGENT_INPUT_MAX_LENGTH,
  DEFAULT_AGENT_EFFORT,
  estimateAgentRunBudget,
  validateAgentRunOutcome,
  AGENT_SESSION_HISTORY_MAX_MESSAGES,
  AGENT_SESSION_HISTORY_MAX_TEXT_LENGTH,
  type AgentSessionHistoryMessage,
  type AgentEffortLevel,
  type AgentRunBudget,
  type AgentRunOutcome,
  type AgentUsageSample,
} from "@synthv-toolbox/runtime-protocol";

export type AiProviderId = "anthropic" | "openai-codex" | "workbuddy" | "traecode";
export type AiLoadStrategy = "round-robin" | "weighted-round-robin" | "failover";
export type CredentialKind = "api-key" | "oauth";

export interface MetadataFilePort {
  read(path: string): Promise<string | undefined>;
  write(path: string, value: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface AgentRuntimePort {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface AgentApprovalCancellationPort {
  cancelConversation(conversationId: string): void;
}

export interface ProviderCatalogPort {
  models(provider: AiProviderId, force: boolean): Promise<string[]>;
  opencode(force: boolean): Promise<Record<string, unknown>>;
}

export interface ProviderUsagePort {
  query(provider: AiProviderId, credentialIds: readonly string[]): Promise<{ accounts: Array<{ credentialId: string; [key: string]: unknown }> }>;
}

export interface AuthorizationResult {
  id?: string;
  label: string;
  secret: string;
  models?: string[];
  expiresAt?: number;
}

export interface ProviderAuthorizer {
  authorize(provider: AiProviderId, signal: AbortSignal): Promise<AuthorizationResult>;
}

export interface StoredCredential {
  id: string;
  provider: AiProviderId;
  kind: CredentialKind;
  label: string;
  models: string[];
  enabled: boolean;
  weight: number;
  createdAt: string;
  expiresAt?: number;
  sealed: string;
  extend?: Record<string, unknown>;
}

export interface ProviderSettings {
  model: string;
  oauthEnabled: boolean;
  strategy: AiLoadStrategy;
}

export interface HostModelCredential {
  id: string;
  providerId: string;
  modelId: string;
  authMethod: CredentialKind;
  apiKey: string;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  outcome?: AgentRunOutcome;
}

export interface ConversationSnapshot {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
}

interface AiServiceMetadata {
  version: 1;
  activeProvider: AiProviderId;
  providers: Record<AiProviderId, ProviderSettings>;
  credentials: StoredCredential[];
  conversations: ConversationSnapshot[];
}

export interface AiServiceOptions {
  metadataPath: string;
  credentials?: CredentialStore;
  runtime: AgentRuntimePort;
  catalog: ProviderCatalogPort;
  approvals: AgentApprovalCancellationPort;
  usage?: ProviderUsagePort;
  authorizer?: ProviderAuthorizer;
  files?: MetadataFilePort;
  now?: () => Date;
  id?: () => string;
  /** Base agent prompt; a changed value recreates the Pi session, so it can carry the active integrations. */
  systemPrompt?: () => string;
  /** False in toolbox-only mode, which promises no model requests; checked before every run. */
  agentAllowed?: () => boolean;
}

const providers: readonly AiProviderId[] = ["anthropic", "openai-codex", "workbuddy", "traecode"];
const defaultModels: Record<AiProviderId, string> = {
  anthropic: ["cla", "ude-sonnet-4-6"].join(""),
  "openai-codex": ["g", "pt-5.6-terra"].join(""),
  workbuddy: "glm-5.2",
  traecode: "",
};

export const nodeMetadataFiles: MetadataFilePort = {
  async read(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  },
  async write(path, value) {
    await writeFile(path, value, { encoding: "utf8", mode: 0o600 });
  },
  rename,
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
};

export function agentRuntimePort(worker: Pick<AgentRuntimeWorker, "handleJsonl">): AgentRuntimePort {
  let sequence = 0;
  let negotiated = false;
  return {
    async request(method, params) {
      if (!negotiated) {
        await worker.handleJsonl(JSON.stringify({ kind: "request", id: "electron-ai-hello", protocolVersion: "1.0", method: "host.hello", params: { hostId: "electron-ai", protocol: { min: "1.0", max: "1.0" }, capabilities: [] } }));
        negotiated = true;
      }
      const lines = await worker.handleJsonl(JSON.stringify({ kind: "request", id: `electron-ai-${++sequence}`, protocolVersion: "1.0", method, params }));
      const response = JSON.parse(lines[0] ?? "{}") as { ok?: boolean; result?: Record<string, unknown>; error?: { message?: string } };
      if (!response.ok) throw new Error(response.error?.message ?? "Agent Runtime request failed.");
      return response.result ?? {};
    },
  };
}

interface ActiveRun {
  runId: string;
  cancelRequested: boolean;
  sendIssued: boolean;
  /** Await acknowledgements before persisting so accepted steers retain their submission order. */
  steers: Array<Promise<ConversationMessage>>;
}

/** Stores encrypted credential material locally and delegates model requests to the shared Agent Runtime. */
export class AiService {
  private readonly files: MetadataFilePort;
  private readonly credentials: CredentialStore;
  private persistence: Promise<void> = Promise.resolve();
  private readonly credentialWrites = new Map<string, Promise<unknown>>();
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly operations = new Map<string, AbortController>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private metadata?: AiServiceMetadata;

  constructor(private readonly options: AiServiceOptions) {
    this.files = options.files ?? nodeMetadataFiles;
    this.credentials = options.credentials ?? createLocalCredentialStore(dirname(options.metadataPath));
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? (() => crypto.randomUUID());
  }

  async ai_provider_state(forceCatalog = false): Promise<Record<string, unknown>> {
    const metadata = await this.load();
    const readable = new Set<string>();
    await Promise.all(metadata.credentials.map(async credential => {
      try { await this.credentials.unseal(credential.sealed); readable.add(credential.id); } catch {}
    }));
    const providersState = await Promise.all(providers.map(async (provider) => {
      const settings = metadata.providers[provider];
      const credentials = metadata.credentials.filter((credential) => credential.provider === provider);
      const models = await this.options.catalog.models(provider, forceCatalog);
      const oauth = credentials.filter((credential) => credential.kind === "oauth");
      const apiKeys = credentials.filter((credential) => credential.kind === "api-key");
      return {
        id: provider,
        displayName: providerDisplayName(provider),
        description: `${providerDisplayName(provider)} model access`,
        active: metadata.activeProvider === provider,
        model: settings.model,
        oauthEnabled: settings.oauthEnabled,
        loadStrategy: settings.strategy,
        models,
        oauthModels: models,
        apiKeyModels: models,
        connected: credentials.some(credential => credential.enabled && readable.has(credential.id)),
        healthyAccounts: oauth.filter(credential => credential.enabled && readable.has(credential.id)).length,
        totalAccounts: oauth.length,
        accounts: oauth.map((credential) => ({ id: credential.id, label: credential.label, expiresAt: credential.expiresAt ?? 0, authorized: readable.has(credential.id), healthy: readable.has(credential.id) && credential.enabled, enabled: credential.enabled, weight: credential.weight, extend: credential.extend })),
        apiKeys: apiKeys.map((credential) => ({ id: credential.id, label: credential.label, models: credential.models, healthy: readable.has(credential.id) && credential.enabled, enabled: credential.enabled, weight: credential.weight, extend: credential.extend, cooldownUntilUtc: null, createdAtUtc: credential.createdAt })),
        authMethods: ["oauth", "api-key"],
        available: true,
        unavailableReason: credentials.some(credential => credential.enabled && !readable.has(credential.id)) ? "Local login data cannot be read. Sign in again to replace this credential." : null,
      };
    }));
    this.createCredentialRouter(metadata);
    return { activeProvider: metadata.activeProvider, legacyConfigured: false, providers: providersState, catalogSource: "models-dev", catalogGeneratedAt: this.now().getTime(), catalogError: null };
  }

  async resolveModelSelection(): Promise<{ providerId: string; modelId: string; credentials: HostModelCredential[] }> {
    const metadata = await this.load();
    const providerId = metadata.activeProvider;
    const modelId = metadata.providers[providerId].model;
    if (!modelId) throw new Error("No model is selected.");
    const router = this.createCredentialRouter(metadata);
    const candidates = router.candidates({ providerId, modelId });
    if (!candidates.length) throw new Error(`No eligible credential is configured for ${providerId}/${modelId}.`);
    const credentials: HostModelCredential[] = [];
    for (const candidate of candidates) {
      const stored = metadata.credentials.find((credential) => credential.id === candidate.id);
      if (!stored) continue;
      let apiKey: string;
      try {
        const decrypted = await this.credentials.unseal(stored.sealed);
        if (stored.kind === "oauth") {
          const credential = JSON.parse(decrypted) as { access?: unknown; accessToken?: unknown };
          const access = credential.access ?? credential.accessToken;
          if (typeof access !== "string" || !access) continue;
          apiKey = access;
        } else {
          apiKey = decrypted;
        }
      } catch {
        continue;
      }
      credentials.push({ id: stored.id, providerId, modelId, authMethod: stored.kind, apiKey });
    }
    if (!credentials.length) throw new Error(`No readable local credential is configured for ${providerId}/${modelId}. Sign in again.`);
    return { providerId, modelId, credentials };
  }

  modelCredentialStore(model: PiModelSelection): PiCredentialStore {
    if (!model.credentialId) throw new Error("A host-selected credential is required.");
    const id = model.credentialId, provider = model.providerId;
    const stored = async () => {
      const metadata = await this.load();
      const credential = metadata.credentials.find(item => item.id === id && item.provider === provider && item.enabled);
      if (!credential) throw new Error("The selected account was removed or disabled.");
      return credential;
    };
    const read = async (): Promise<PiCredential> => {
      const credential = await stored(), secret = await this.credentials.unseal(credential.sealed);
      if (credential.kind === "api-key") return { type: "api_key", key: secret };
      const oauth = JSON.parse(secret);
      if (!oauth || typeof oauth.access !== "string" || typeof oauth.refresh !== "string" || typeof oauth.expires !== "number") throw new Error("The OAuth login is incomplete. Sign in again.");
      return { ...oauth, type: "oauth" };
    };
    return {
      read: async (providerId, options) => { options?.signal?.throwIfAborted(); return providerId === provider ? read() : undefined; },
      list: async options => { options?.signal?.throwIfAborted(); return [{ providerId: provider, type: (await stored()).kind === "oauth" ? "oauth" : "api_key" }]; },
      modify: async (providerId, update, options) => {
        if (providerId !== provider) throw new Error("Cannot update another provider's credentials.");
        const operation = (this.credentialWrites.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
          options?.signal?.throwIfAborted();
          const before = (await stored()).sealed, current = await read(), next = await update(current);
          options?.signal?.throwIfAborted();
          if (!next || JSON.stringify(next) === JSON.stringify(current)) return current;
          const sealed = await this.credentials.seal(next.type === "oauth" ? JSON.stringify(next) : next.key);
          const credential = await stored();
          if (credential.sealed !== before) throw new Error("The account changed during token refresh; retry with the current login.");
          if (next.type !== current.type) throw new Error("Credential refresh cannot change authentication method.");
          credential.sealed = sealed;
          if (next.type === "oauth") credential.expiresAt = next.expires;
          await this.persist();
          return next;
        });
        const tail = operation.catch(() => {}); this.credentialWrites.set(id, tail);
        void tail.then(() => { if (this.credentialWrites.get(id) === tail) this.credentialWrites.delete(id); });
        return operation;
      },
      delete: async () => { throw new Error("Remove accounts through Toolbox settings."); },
    };
  }

  async authorize_ai_provider(provider: AiProviderId, operationId = this.id()): Promise<Record<string, unknown>> {
    if (!this.options.authorizer) throw new Error("OAuth authorization is not configured.");
    const controller = new AbortController();
    this.operations.set(operationId, controller);
    try {
      const authorized = await this.options.authorizer.authorize(provider, controller.signal);
      if (controller.signal.aborted) throw new Error("Authorization cancelled.");
      const credential = await this.storeCredential({
        id: authorized.id ?? `${provider}:${this.id()}`,
        provider,
        kind: "oauth",
        label: authorized.label,
        secret: authorized.secret,
        models: authorized.models ?? await this.options.catalog.models(provider, false),
        expiresAt: authorized.expiresAt,
      });
      const metadata = await this.load();
      metadata.activeProvider = provider;
      await this.persist();
      return { credential: publicCredential(credential), state: await this.ai_provider_state(false) };
    } finally {
      this.operations.delete(operationId);
    }
  }

  cancel_ai_authorization(operationId: string): void {
    this.operations.get(operationId)?.abort();
  }

  async add_ai_api_key(provider: AiProviderId, label: string, apiKey: string, models?: string[]): Promise<Record<string, unknown>> {
    if (!apiKey.trim()) throw new Error("API key is required.");
    const credential = await this.storeCredential({
      id: this.id(),
      provider,
      kind: "api-key",
      label: sanitizeLabel(label, apiKey),
      secret: apiKey,
      models: models ?? await this.options.catalog.models(provider, false),
    });
    return { credential: publicCredential(credential), state: await this.ai_provider_state(false) };
  }

  async remove_ai_api_key(provider: AiProviderId, credentialId: string): Promise<Record<string, unknown>> {
    return this.removeCredential(provider, credentialId, "api-key");
  }

  async update_ai_api_key(provider: AiProviderId, credentialId: string, input: { label?: string; apiKey?: string; models?: string[] }): Promise<Record<string, unknown>> {
    const metadata = await this.load();
    const credential = metadata.credentials.find((item) => item.provider === provider && item.id === credentialId && item.kind === "api-key");
    if (!credential) throw new Error("API key credential was not found.");
    let sealed: string | undefined;
    if (input.apiKey !== undefined) {
      if (!input.apiKey.trim()) throw new Error("API key is required.");
      sealed = await this.credentials.seal(input.apiKey);
    }
    if (input.label !== undefined) credential.label = sanitizeLabel(input.label, input.apiKey ?? "");
    if (input.models !== undefined) credential.models = [...new Set(input.models)].sort();
    if (sealed !== undefined) credential.sealed = sealed;
    await this.persist();
    return this.ai_provider_state(false);
  }

  async remove_ai_provider_account(provider: AiProviderId, credentialId: string): Promise<Record<string, unknown>> {
    return this.removeCredential(provider, credentialId, "oauth");
  }

  async update_ai_credential(provider: AiProviderId, credentialId: string, enabled: boolean, weight?: number, label?: string, extend?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (weight !== undefined && (!Number.isInteger(weight) || weight < 1 || weight > 100)) throw new Error("Credential weight must be between 1 and 100.");
    const metadata = await this.load();
    const credential = metadata.credentials.find((item) => item.provider === provider && item.id === credentialId);
    if (!credential) throw new Error("Credential was not found.");
    credential.enabled = enabled;
    if (label !== undefined && (!label.trim() || label.trim().length > 80)) throw new Error("Credential label must contain 1 to 80 characters.");
    if (extend && Object.values(extend).some(value => value !== null && !["string", "number", "boolean"].includes(typeof value))) throw new Error("Credential metadata must contain scalar values.");
    if (weight !== undefined) credential.weight = weight;
    if (label !== undefined) credential.label = label.trim();
    if (extend !== undefined) credential.extend = extend;
    await this.persist();
    return this.ai_provider_state(false);
  }

  async reorder_ai_credentials(provider: AiProviderId, method: string, credentialIds: string[]): Promise<Record<string, unknown>> {
    if (method !== "oauth" && method !== "api-key") throw new Error("Invalid authentication method.");
    const metadata = await this.load();
    const matches = (item: StoredCredential) => item.provider === provider && item.kind === method;
    const group = metadata.credentials.filter(matches);
    if (group.length !== credentialIds.length || new Set(credentialIds).size !== group.length || credentialIds.some(id => !group.some(item => item.id === id))) throw new Error("Credential order must include every credential exactly once.");
    const ordered = new Map(credentialIds.map((id, index) => [id, index]));
    group.sort((left, right) => ordered.get(left.id)! - ordered.get(right.id)!);
    let index = 0;
    metadata.credentials = metadata.credentials.map(item => matches(item) ? group[index++]! : item);
    await this.persist();
    return this.ai_provider_state(false);
  }

  async update_ai_provider(provider: AiProviderId, oauthEnabled: boolean): Promise<Record<string, unknown>> {
    const metadata = await this.load();
    metadata.providers[provider].oauthEnabled = oauthEnabled;
    await this.persist();
    return this.ai_provider_state(false);
  }

  async update_ai_provider_strategy(provider: AiProviderId, strategy: AiLoadStrategy): Promise<Record<string, unknown>> {
    if (!isStrategy(strategy)) throw new Error("Invalid provider strategy.");
    const metadata = await this.load();
    metadata.providers[provider].strategy = strategy;
    await this.persist();
    return this.ai_provider_state(false);
  }

  async select_ai_provider(provider: AiProviderId, model: string): Promise<Record<string, unknown>> {
    const selected = model.trim();
    if (!selected) throw new Error("Model is required.");
    const models = await this.options.catalog.models(provider, false);
    if (!models.includes(selected)) throw new Error("Selected model is not available for this provider.");
    const metadata = await this.load();
    metadata.activeProvider = provider;
    metadata.providers[provider].model = selected;
    await this.persist();
    return this.ai_provider_state(false);
  }

  async ai_provider_usage(): Promise<Record<string, unknown>> {
    const metadata = await this.load();
    const accounts: Array<Record<string, unknown>> = [];
    for (const provider of providers) {
      const credentials = metadata.credentials.filter(item => item.provider === provider && item.kind === "oauth");
      const queried = this.options.usage ? await this.options.usage.query(provider, credentials.filter(item => item.enabled).map(item => item.id)) : { accounts: [] };
      for (const credential of credentials) {
        accounts.push({ provider, channel: "oauth", credentialId: credential.id, label: credential.label, usage: queried.accounts.find(item => item.credentialId === credential.id) ?? null });
      }
    }
    return { queriedAt: this.now().toISOString(), accounts };
  }

  async opencode_provider_catalog(force = false): Promise<Record<string, unknown>> {
    return this.options.catalog.opencode(force);
  }

  async new_conversation(): Promise<ConversationSnapshot> {
    const metadata = await this.load();
    const now = this.now().toISOString();
    const conversation = { id: this.id(), title: "New conversation", createdAt: now, updatedAt: now, messages: [] };
    metadata.conversations.push(conversation);
    await this.persist();
    return cloneConversation(conversation);
  }

  async list_conversations(): Promise<Array<Pick<ConversationSnapshot, "id" | "title" | "updatedAt"> & { messageCount: number }>> {
    const metadata = await this.load();
    return metadata.conversations
      .map((item) => ({ id: item.id, title: item.title, updatedAt: item.updatedAt, messageCount: item.messages.length }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async open_conversation(id: string): Promise<ConversationSnapshot> {
    const conversation = (await this.load()).conversations.find((item) => item.id === id);
    if (!conversation) throw new Error("Conversation was not found.");
    return cloneConversation(conversation);
  }

  async send_message(conversationId: string, input: string, options: { cwd?: string; effort?: AgentEffortLevel; runId?: string } = {}): Promise<ConversationMessage[]> {
    const text = input.trim();
    if (!text) throw new Error("Message is required.");
    if (text.length > AGENT_INPUT_MAX_LENGTH) throw new Error("Message exceeds the 32,000 character limit.");
    if (this.activeRuns.has(conversationId)) throw new Error("A run is already in progress.");
    if (this.options.agentAllowed && !this.options.agentAllowed()) throw new Error("The internal agent is only available in AI mode. Switch the toolbox to AI mode in Settings first.");
    const effort = options.effort ?? DEFAULT_AGENT_EFFORT;
    const active: ActiveRun = { runId: options.runId ?? this.id(), cancelRequested: false, sendIssued: false, steers: [] };
    this.activeRuns.set(conversationId, active);
    try {
      const metadata = await this.load();
      const conversation = metadata.conversations.find((item) => item.id === conversationId);
      if (!conversation) throw new Error("Conversation was not found.");
      const seedOutcome = latestOutcome(conversation);
      const systemPrompt = this.options.systemPrompt?.();
      const history = sessionHistory(conversation.messages);
      await this.options.runtime.request("session.initialize", { sessionId: conversation.id, ...(options.cwd ? { cwd: options.cwd } : {}), ...(systemPrompt ? { systemPrompt } : {}), ...(seedOutcome ? { outcome: seedOutcome } : {}), ...(history.length ? { history } : {}) });
      const { assistant, outcome } = active.cancelRequested
        ? { assistant: "", outcome: cancelledOutcome(effort, this.agentUsageSamples()) }
        : await this.runSend(conversation.id, text, effort, active);
      const steers = await Promise.allSettled(active.steers);
      const now = this.now().toISOString();
      const messages: ConversationMessage[] = [
        { role: "user", content: text, createdAt: now },
        ...steers.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
        { role: "assistant", content: assistant, createdAt: now, outcome },
      ];
      conversation.messages.push(...messages);
      conversation.updatedAt = now;
      if (conversation.title === "New conversation") conversation.title = text.slice(0, 28);
      await this.persist();
      return messages.map((message) => ({ ...message }));
    } finally {
      this.activeRuns.delete(conversationId);
    }
  }

  private async runSend(sessionId: string, text: string, effort: AgentEffortLevel, active: ActiveRun): Promise<{ assistant: string; outcome: AgentRunOutcome }> {
    active.sendIssued = true;
    const budget = estimateAgentRunBudget(effort, this.agentUsageSamples());
    const response = await this.options.runtime.request("session.send", { sessionId, input: text, runId: active.runId, budget });
    const outcome = validateAgentRunOutcome(response.outcome);
    if (!outcome) throw new Error("Agent Runtime returned an invalid run outcome.");
    const assistant = (typeof response.message === "string" ? response.message.trim() : "") || outcome.summary;
    return { assistant, outcome };
  }

  /** Delivers a message to the conversation's in-flight run; rejects when no run has reached the runtime. */
  async steer_agent_run(conversationId: string, input: string): Promise<ConversationMessage> {
    const text = input.trim();
    if (!text) throw new Error("Message is required.");
    if (text.length > AGENT_INPUT_MAX_LENGTH) throw new Error("Message exceeds the 32,000 character limit.");
    const active = this.activeRuns.get(conversationId);
    if (!active?.sendIssued || active.cancelRequested) throw new Error("No agent run is in progress.");
    const pending: Promise<ConversationMessage> = this.options.runtime.request("session.steer", { sessionId: conversationId, runId: active.runId, input: text })
      .then(() => ({ role: "user", content: text, createdAt: this.now().toISOString() }));
    active.steers.push(pending);
    return { ...await pending };
  }

  /** Stops every run in progress (chat, toolbox_agent tasks, Cover phases); used when the app leaves AI mode. */
  async cancel_all_agent_runs(): Promise<string[]> {
    const conversations = [...this.activeRuns.keys()];
    await Promise.allSettled(conversations.map(conversationId => this.cancel_agent_run(conversationId)));
    return conversations;
  }

  async cancel_agent_run(conversationId: string): Promise<void> {
    const active = this.activeRuns.get(conversationId);
    if (active && !active.sendIssued) {
      active.cancelRequested = true;
      this.options.approvals.cancelConversation(conversationId);
      return;
    }
    // Cancel the run first so deliver() sees runState().active === false and queues rather than steers.
    await this.options.runtime.request("session.cancel", { sessionId: conversationId });
    this.options.approvals.cancelConversation(conversationId);
  }

  agentUsageSamples(): AgentUsageSample[] {
    if (!this.metadata) throw new Error("AI metadata has not been loaded yet.");
    const finished = this.metadata.conversations
      .flatMap((conversation) => conversation.messages)
      .filter((message): message is ConversationMessage & { outcome: AgentRunOutcome } => message.role === "assistant" && message.outcome !== undefined)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const samples: AgentUsageSample[] = [];
    for (const message of finished) {
      const { status, budget } = message.outcome;
      if (status === "incomplete" || status === "cancelled" || status === "error") continue;
      samples.push({ level: budget.level, turns: budget.turns, tokens: budget.tokens, censored: status === "budget_exhausted" });
    }
    return samples;
  }

  async agent_budgets(): Promise<Record<AgentEffortLevel, AgentRunBudget>> {
    await this.load();
    const samples = this.agentUsageSamples();
    return Object.fromEntries(AGENT_EFFORT_LEVELS.map((level) => [level, estimateAgentRunBudget(level, samples)])) as Record<AgentEffortLevel, AgentRunBudget>;
  }

  private async removeCredential(provider: AiProviderId, credentialId: string, kind: CredentialKind): Promise<Record<string, unknown>> {
    const metadata = await this.load();
    const index = metadata.credentials.findIndex((item) => item.provider === provider && item.id === credentialId && item.kind === kind);
    if (index < 0) throw new Error("Credential was not found.");
    metadata.credentials.splice(index, 1);
    await this.persist();
    return this.ai_provider_state(false);
  }

  private async storeCredential(input: Omit<StoredCredential, "enabled" | "weight" | "createdAt" | "sealed"> & { secret: string }): Promise<StoredCredential> {
    const metadata = await this.load();
    const existing = metadata.credentials.findIndex((item) => item.id === input.id);
    const credential: StoredCredential = {
      id: input.id,
      provider: input.provider,
      kind: input.kind,
      label: input.label,
      models: [...new Set(input.models)].sort(),
      enabled: true,
      weight: 1,
      createdAt: this.now().toISOString(),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      sealed: await this.credentials.seal(input.secret),
    };
    if (existing >= 0) metadata.credentials.splice(existing, 1, credential);
    else metadata.credentials.push(credential);
    await this.persist();
    return credential;
  }

  private async load(): Promise<AiServiceMetadata> {
    if (this.metadata) return this.metadata;
    const raw = await this.files.read(this.options.metadataPath);
    this.metadata = raw ? parseMetadata(raw) : createMetadata();
    return this.metadata;
  }

  private persist(): Promise<void> {
    const write = async () => {
      const metadata = await this.load();
      const target = this.options.metadataPath;
      const temporary = `${target}.${this.id()}.tmp`;
      await this.files.mkdir(dirname(target));
      await this.files.write(temporary, `${JSON.stringify(metadata)}\n`);
      await this.files.rename(temporary, target);
    };
    const pending = this.persistence.then(write, write);
    this.persistence = pending.catch(() => {});
    return pending;
  }

  private createCredentialRouter(metadata: AiServiceMetadata): CredentialRouter {
    return new CredentialRouter(metadata.credentials.map((credential) => createCredentialMetadata({
      id: credential.id,
      providerId: credential.provider,
      authMethod: credential.kind,
      enabled: credential.enabled,
      modelIds: credential.models,
      extend: { label: credential.label },
    })));
  }
}

function createMetadata(): AiServiceMetadata {
  return {
    version: 1,
    activeProvider: "anthropic",
    providers: Object.fromEntries(providers.map((provider) => [provider, { model: defaultModels[provider], oauthEnabled: true, strategy: "round-robin" }])) as AiServiceMetadata["providers"],
    credentials: [],
    conversations: [],
  };
}

function parseMetadata(raw: string): AiServiceMetadata {
  const value = JSON.parse(raw) as Partial<AiServiceMetadata>;
  if (value.version !== 1 || !isProvider(value.activeProvider) || !Array.isArray(value.credentials) || !Array.isArray(value.conversations) || !value.providers) {
    throw new Error("AI metadata is invalid.");
  }
  for (const conversation of value.conversations) {
    for (const message of conversation.messages) {
      if (message.role === "assistant" && message.outcome !== undefined && !validateAgentRunOutcome(message.outcome)) delete message.outcome;
    }
  }
  return value as AiServiceMetadata;
}

function cancelledOutcome(effort: AgentEffortLevel, samples: AgentUsageSample[]): AgentRunOutcome {
  const budget = estimateAgentRunBudget(effort, samples);
  return { status: "cancelled", summary: "", evidence: [], missing: [], plan: null, budget: { ...budget, turns: 0, tokens: 0, uncachedInputTokens: 0, cacheReadTokens: 0 } };
}

/** Characters of earlier turns replayed into a recreated session; older turns are dropped first. */
const SESSION_HISTORY_BUDGET = 60_000;
/** No single turn may take more than this, so one long reply cannot crowd out every turn before it. */
const SESSION_HISTORY_TURN_LIMIT = 20_000;
const TRUNCATED = "\n[… shortened]";

/** The most recent turns that fit the budget, oldest first, for a session the runtime has to create again. */
function sessionHistory(messages: readonly ConversationMessage[]): AgentSessionHistoryMessage[] {
  const history: AgentSessionHistoryMessage[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0 && history.length < AGENT_SESSION_HISTORY_MAX_MESSAGES; index--) {
    const limit = Math.min(SESSION_HISTORY_TURN_LIMIT, SESSION_HISTORY_BUDGET - used);
    if (limit <= TRUNCATED.length) break;
    const content = messages[index].content;
    if (!content.trim()) continue;
    const text = content.length > limit ? `${content.slice(0, limit - TRUNCATED.length)}${TRUNCATED}` : content;
    used += text.length;
    history.unshift({ role: messages[index].role, text });
  }
  return history;
}

function latestOutcome(conversation: ConversationSnapshot): AgentRunOutcome | undefined {
  for (let index = conversation.messages.length - 1; index >= 0; index--) {
    const message = conversation.messages[index];
    if (message.role === "assistant" && message.outcome) return message.outcome;
  }
  return undefined;
}

function publicCredential(credential: StoredCredential): Omit<StoredCredential, "sealed"> {
  const { sealed: _, ...publicValue } = credential;
  return publicValue;
}

function cloneConversation(conversation: ConversationSnapshot): ConversationSnapshot {
  return { ...conversation, messages: conversation.messages.map((message) => ({ ...message })) };
}

function sanitizeLabel(label: string, secret: string): string {
  const value = label.trim().replace(/\s+/g, " ").slice(0, 80);
  return value && !value.includes(secret) ? value : "API Key";
}

function isProvider(value: unknown): value is AiProviderId {
  return typeof value === "string" && providers.includes(value as AiProviderId);
}

function providerDisplayName(provider: AiProviderId): string {
  return provider === "openai-codex" ? "OpenAI Codex" : provider === "workbuddy" ? "WorkBuddy" : provider === "traecode" ? "Trae" : "Anthropic";
}

function isStrategy(value: string): value is AiLoadStrategy {
  return value === "round-robin" || value === "weighted-round-robin" || value === "failover";
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}
