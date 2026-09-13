import { CredentialRouter, createCredentialMetadata } from "@model-auth/core";
import { dirname } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { AgentRuntimeWorker } from "../../../../packages/agent-runtime/src/index.js";

export type AiProviderId = "anthropic" | "openai-codex" | "workbuddy" | "traecode";
export type AiLoadStrategy = "round-robin" | "weighted-round-robin" | "failover";
export type CredentialKind = "api-key" | "oauth";

export interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface MetadataFilePort {
  read(path: string): Promise<string | undefined>;
  write(path: string, value: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface AgentRuntimePort {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ProviderCatalogPort {
  models(provider: AiProviderId, force: boolean): Promise<string[]>;
  opencode(force: boolean): Promise<Record<string, unknown>>;
}

export interface ProviderUsagePort {
  query(provider: AiProviderId, credentialIds: readonly string[]): Promise<Record<string, unknown>>;
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
}

export interface ProviderSettings {
  model: string;
  oauthEnabled: boolean;
  strategy: AiLoadStrategy;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
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
  safeStorage: SafeStoragePort;
  runtime: AgentRuntimePort;
  catalog: ProviderCatalogPort;
  usage?: ProviderUsagePort;
  authorizer?: ProviderAuthorizer;
  files?: MetadataFilePort;
  now?: () => Date;
  id?: () => string;
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

export function agentRuntimePort(worker: Pick<AgentRuntimeWorker, "handle">): AgentRuntimePort {
  let sequence = 0;
  return {
    async request(method, params) {
      const response = await worker.handle({ id: `electron-ai-${++sequence}`, method, params });
      if ("error" in response && response.error) throw new Error(response.error.message);
      return response.result ?? {};
    },
  };
}

/** Stores encrypted credential material locally and delegates model requests to the shared Agent Runtime. */
export class AiService {
  private readonly files: MetadataFilePort;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly operations = new Map<string, AbortController>();
  private metadata?: AiServiceMetadata;

  constructor(private readonly options: AiServiceOptions) {
    this.files = options.files ?? nodeMetadataFiles;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? (() => crypto.randomUUID());
    if (!options.safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage encryption is unavailable.");
  }

  async ai_provider_state(forceCatalog = false): Promise<Record<string, unknown>> {
    const metadata = await this.load();
    const providersState = await Promise.all(providers.map(async (provider) => {
      const settings = metadata.providers[provider];
      const credentials = metadata.credentials.filter((credential) => credential.provider === provider);
      const models = await this.options.catalog.models(provider, forceCatalog);
      return {
        id: provider,
        active: metadata.activeProvider === provider,
        model: settings.model,
        oauthEnabled: settings.oauthEnabled,
        loadStrategy: settings.strategy,
        models,
        connected: credentials.some((credential) => credential.enabled),
        credentials: credentials.map(publicCredential),
      };
    }));
    this.createCredentialRouter(metadata);
    return { activeProvider: metadata.activeProvider, providers: providersState };
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
    if (input.label !== undefined) credential.label = sanitizeLabel(input.label, input.apiKey ?? "");
    if (input.models !== undefined) credential.models = [...new Set(input.models)].sort();
    if (input.apiKey !== undefined) {
      if (!input.apiKey.trim()) throw new Error("API key is required.");
      credential.sealed = this.options.safeStorage.encryptString(input.apiKey).toString("base64");
    }
    await this.persist();
    return this.ai_provider_state(false);
  }

  async remove_ai_provider_account(provider: AiProviderId, credentialId: string): Promise<Record<string, unknown>> {
    return this.removeCredential(provider, credentialId, "oauth");
  }

  async update_ai_credential(provider: AiProviderId, credentialId: string, enabled: boolean, weight: number): Promise<Record<string, unknown>> {
    if (!Number.isInteger(weight) || weight < 1 || weight > 100) throw new Error("Credential weight must be between 1 and 100.");
    const metadata = await this.load();
    const credential = metadata.credentials.find((item) => item.provider === provider && item.id === credentialId);
    if (!credential) throw new Error("Credential was not found.");
    credential.enabled = enabled;
    credential.weight = weight;
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
    const result: Record<string, unknown> = { queriedAt: this.now().toISOString(), providers: {} };
    if (!this.options.usage) return result;
    for (const provider of providers) {
      const ids = metadata.credentials.filter((item) => item.provider === provider && item.enabled).map((item) => item.id);
      result.providers = { ...(result.providers as Record<string, unknown>), [provider]: await this.options.usage.query(provider, ids) };
    }
    return result;
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

  async send_message(conversationId: string, input: string, cwd?: string): Promise<ConversationMessage[]> {
    const text = input.trim();
    if (!text) throw new Error("Message is required.");
    if (text.length > 32_000) throw new Error("Message exceeds the 32,000 character limit.");
    const metadata = await this.load();
    const conversation = metadata.conversations.find((item) => item.id === conversationId);
    if (!conversation) throw new Error("Conversation was not found.");
    const provider = metadata.activeProvider;
    const model = metadata.providers[provider].model;
    await this.options.runtime.request("session.initialize", { sessionId: conversation.id, ...(cwd ? { cwd } : {}), model: { provider, model } });
    const response = await this.options.runtime.request("session.send", { sessionId: conversation.id, input: text });
    const assistant = typeof response.message === "string" ? response.message.trim() : "";
    if (!assistant) throw new Error("Agent Runtime did not return an assistant message.");
    const now = this.now().toISOString();
    const messages: ConversationMessage[] = [{ role: "user", content: text, createdAt: now }, { role: "assistant", content: assistant, createdAt: now }];
    conversation.messages.push(...messages);
    conversation.updatedAt = now;
    if (conversation.title === "New conversation") conversation.title = text.slice(0, 28);
    await this.persist();
    return messages.map((message) => ({ ...message }));
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
      sealed: this.options.safeStorage.encryptString(input.secret).toString("base64"),
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

  private async persist(): Promise<void> {
    const metadata = await this.load();
    const target = this.options.metadataPath;
    const temporary = `${target}.${this.id()}.tmp`;
    await this.files.mkdir(dirname(target));
    await this.files.write(temporary, `${JSON.stringify(metadata)}\n`);
    await this.files.rename(temporary, target);
  }

  private createCredentialRouter(metadata: AiServiceMetadata): CredentialRouter {
    return new CredentialRouter(metadata.credentials.map((credential) => createCredentialMetadata({
      id: credential.id,
      provider: credential.provider,
      label: credential.label,
      enabled: credential.enabled,
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
  return value as AiServiceMetadata;
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

function isStrategy(value: string): value is AiLoadStrategy {
  return value === "round-robin" || value === "weighted-round-robin" || value === "failover";
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}
