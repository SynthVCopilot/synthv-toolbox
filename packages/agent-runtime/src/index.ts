import { CredentialRouter, createCredentialMetadata, type CredentialMetadata, type ProviderAdapterHost, type ProviderRequest, type ProviderRequestContext, type ProviderResponse, type ProviderStreamEvent } from "@model-auth/core";
import { fileURLToPath } from "node:url";
import {
  AGENT_RUN_ID_MAX_LENGTH,
  AGENT_RUN_PROGRESS_EVENT,
  DEFAULT_AGENT_EFFORT,
  HOST_API_VERSION,
  HOST_HELLO_METHOD,
  PROTOCOL_VERSION_RANGE,
  encodeJsonl,
  estimateAgentRunBudget,
  isHostApiCompatible,
  negotiateProtocolVersion,
  parseJsonl,
  validateAgentRunBudget,
  validateAgentRunOutcome,
  type AgentEffortProfile,
  type AgentRunBudget,
  type AgentRunOutcome,
  type AgentSessionSendResult,
  type ApiVersion,
  type CapabilityDescriptor,
  type HostHello,
  type JsonValue,
  type PluginManifest,
  type PluginPermission,
  pluginPermissionLevel,
  type RpcNotification,
  type RpcRequest,
  type RpcResponseFailure,
  type RpcResponseSuccess,
  type RuntimeHello,
  validatePluginManifest,
} from "@synthv-toolbox/runtime-protocol";
import {
  buildOutcome,
  createCompletionGuardRegistry,
  createTaskLoopExtension,
  createTaskLoopState,
  effortProfileFor,
  resetRun,
  runTaskLoop,
  TASK_LOOP_TOOL_NAMES,
  type AgentToolDetails,
  type PiExtensionApi,
  type PiToolDefinition,
  type PiToolResult,
  type TaskLoopPendingInput,
} from "./task-loop.js";
import { createRunProgress, type AgentRunView } from "./progress.js";

export type { AgentToolDetails, PiExtensionApi, PiToolDefinition, PiToolResult };
export type { AgentRunView } from "./progress.js";
export { TASK_LOOP_TOOL_NAMES };

export const AGENT_RUNTIME_ID = "synthv-toolbox.agent-runtime";

export const AGENT_RUNTIME_CAPABILITIES: CapabilityDescriptor[] = [
  { id: "agent.sessions", version: "1.0", operations: ["initialize", "send", "close", "cancel"] },
  { id: "host.capabilities", version: "1.0", operations: ["invoke"] },
  { id: "runtime.plugins", version: "1.0", operations: ["discover", "invoke"] },
  { id: "agent.progress", version: "1.0", operations: ["session.progress"] },
];

export interface PiSession {
  /** runId is stamped on every progress notification for this run; runState() exposes the same value. */
  prompt(input: string, budget: AgentRunBudget, report: (view: AgentRunView) => void, runId: string): Promise<{ message: string; outcome: AgentRunOutcome }>;
  cancel(): Promise<boolean>;
  dispose(): void | Promise<void>;
  readonly running: boolean;
}

export interface PiSessionFactory {
  create(input: { sessionId: string; cwd?: string; systemPrompt?: string; model?: PiModelSelection; outcome?: AgentRunOutcome }): Promise<PiSession>;
}

/** Registers a check the completion tool consults; a non-null return is the reason it fails. */
export interface AgentSessionGuards {
  completion(check: () => string | null): void;
}

/** Whether this session currently has a run in flight, and that run's id. */
export type AgentRunStateAccessor = () => { active: boolean; runId: string | null };

export interface PiModelSelection {
  providerId: string;
  modelId: string;
  apiKey: string;
  credentialId?: string;
}

interface HostModelCredential extends PiModelSelection { id: string; authMethod: "api-key" | "oauth"; }

export interface HostCapabilityTransport {
  request(method: string, params: JsonValue): Promise<JsonValue>;
}

export interface PluginBackendContext {
  readonly plugin: PluginManifest;
  invokeHost(permission: PluginPermission, capability: string, operation: string, params: JsonValue): Promise<JsonValue>;
}

export interface PluginBackendModule {
  default?: PiExtensionFactory;
  activate?(context: PluginBackendContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
  invoke?(context: PluginBackendContext, method: string, params: JsonValue): JsonValue | Promise<JsonValue>;
}

export interface LoadedPluginBackend {
  manifest: PluginManifest;
  entryPath: string;
  piExtensionPath?: string;
  deactivate(): Promise<void>;
  invoke?(method: string, params: JsonValue): Promise<JsonValue>;
}

export interface ModuleLoader {
  (url: URL): Promise<unknown>;
}

export interface PluginDiscovery {
  discover(root: string, enabledPluginIds: readonly string[]): Promise<PluginManifest[]>;
  invoke(pluginId: string, method: string, params: JsonValue): Promise<PluginInvocationResult>;
  extensionPaths(): readonly string[];
}

export type PluginInvocationResult =
  | { kind: "handled"; result: JsonValue }
  | { kind: "not-found" }
  | { kind: "unsupported" };

export type PiExtensionFactory = (pi: unknown) => void | Promise<void>;

export interface PiResourceLoader {
  reload(): Promise<void>;
}

export interface PiSettingsManager {
  applyOverrides(overrides: { compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number } }): void;
}

export interface PiInlineExtension {
  name: string;
  factory: (pi: PiExtensionApi) => void | Promise<void>;
}

export interface PiAgentSession {
  prompt(input: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  setThinkingLevel(level: string): void;
  /** Drops any steering/follow-up messages queued through sendMessage, so a message queued just before cancel never starts a new turn. */
  clearQueue(): { steering: unknown[]; followUp: unknown[] };
  /** Fires after extensions for every raw agent event; returns an unsubscribe function. */
  subscribe(listener: (event: unknown) => void): () => void;
}

export interface PiSdk {
  getAgentDir(): string;
  DefaultResourceLoader: new (options: {
    cwd: string;
    agentDir: string;
    additionalExtensionPaths: string[];
    extensionFactories?: PiInlineExtension[];
    settingsManager?: PiSettingsManager;
    systemPrompt?: string;
  }) => PiResourceLoader;
  ModelRuntime: { create(options: { refreshOnCreate: false }): Promise<{ setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>; getModel(providerId: string, modelId: string): unknown }> };
  SettingsManager: { create(cwd: string, agentDir?: string): PiSettingsManager };
  SessionManager: { inMemory(cwd: string): unknown; create(cwd: string): unknown };
  createAgentSession(options: {
    cwd: string;
    noTools: "builtin";
    resourceLoader: PiResourceLoader;
    settingsManager?: PiSettingsManager;
    modelRuntime?: unknown;
    model?: unknown;
    sessionManager?: unknown;
  }): Promise<{ session: PiAgentSession }>;
}

export class ModelAuthGateway {
  readonly router: CredentialRouter;

  constructor(credentials: readonly CredentialMetadata[], private readonly adapters: ReadonlyMap<string, ProviderAdapterHost>) {
    this.router = new CredentialRouter(credentials);
  }

  async request(providerId: string, request: ProviderRequest, context: ProviderRequestContext = {}): Promise<ModelAuthResult<ProviderResponse>> {
    const candidate = this.router.candidates({ providerId, modelId: request.modelId })[0];
    const adapter = this.adapters.get(providerId);
    if (!candidate) return unsupported(`No eligible credential for ${providerId}/${request.modelId}.`);
    if (!adapter?.request) return unsupported(`Provider ${providerId} does not expose request through the current adapter.`);

    try {
      const response = await adapter.request(candidate.id, request, context);
      this.router.reportSuccess(candidate.id);
      return { kind: "ok", value: response };
    } catch (error) {
      this.router.reportError(candidate.id, toRouteError(error));
      throw error;
    }
  }

  async stream(providerId: string, request: ProviderRequest, context: ProviderRequestContext = {}): Promise<ModelAuthResult<AsyncIterable<ProviderStreamEvent>>> {
    const candidate = this.router.candidates({ providerId, modelId: request.modelId })[0];
    const adapter = this.adapters.get(providerId);
    if (!candidate) return unsupported(`No eligible credential for ${providerId}/${request.modelId}.`);
    if (!adapter?.stream) return unsupported(`Provider ${providerId} does not expose streaming through the current adapter.`);
    return { kind: "ok", value: this.reportStream(candidate.id, adapter.stream(candidate.id, request, context)) };
  }

  private async *reportStream(credentialId: string, stream: AsyncIterable<ProviderStreamEvent>): AsyncIterable<ProviderStreamEvent> {
    try {
      for await (const event of stream) yield event;
      this.router.reportSuccess(credentialId);
    } catch (error) {
      this.router.reportError(credentialId, toRouteError(error));
      throw error;
    }
  }
}

export type ModelAuthResult<T> = { kind: "ok"; value: T } | { kind: "unsupported"; reason: string };

export interface PiSessionFactoryOptions {
  extensionPaths?: () => readonly string[];
  extensions?: (session: { sessionId: string; guards: AgentSessionGuards; runState: AgentRunStateAccessor }) => readonly PiInlineExtension[];
  loadSdk?: () => Promise<PiSdk>;
  /** false (the default) keeps transcripts in memory; true persists them under the Pi agent directory. Read once per session creation. */
  persistTranscripts?: () => boolean;
}

export function createPiSessionFactory(options: PiSessionFactoryOptions = {}): PiSessionFactory {
  const loadSdk = options.loadSdk ?? loadPiSdk;
  return {
    async create(input) {
      const sdk = await loadSdk();
      const cwd = input.cwd ?? process.cwd();
      const settingsManager = sdk.SettingsManager.create(cwd, sdk.getAgentDir());
      const seededPlan = input.outcome && input.outcome.status !== "completed" ? input.outcome.plan : null;
      const pendingInput = pendingInputFrom(input.outcome);
      const state = createTaskLoopState(seededPlan, estimateAgentRunBudget(DEFAULT_AGENT_EFFORT, []), pendingInput);
      let running = false;
      let currentRunId: string | null = null;
      let currentProjector: ReturnType<typeof createRunProgress> | null = null;
      const completionGuards = createCompletionGuardRegistry();
      const guards: AgentSessionGuards = { completion: completionGuards.register };
      // False once cancel() has been requested, even while abort() is still winding down, so deliver() queues instead of steering.
      const runState: AgentRunStateAccessor = () => ({ active: running && !state.cancelled, runId: currentRunId });
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir: sdk.getAgentDir(),
        additionalExtensionPaths: [...(options.extensionPaths?.() ?? [])],
        extensionFactories: [createTaskLoopExtension(state, completionGuards.run), ...(options.extensions?.({ sessionId: input.sessionId, guards, runState }) ?? [])],
        settingsManager,
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      });
      await resourceLoader.reload();
      if (!input.model) throw new Error("A host-selected model is required to create a Pi session.");
      const modelRuntime = await sdk.ModelRuntime.create({ refreshOnCreate: false });
      await modelRuntime.setRuntimeApiKey(input.model.providerId, input.model.apiKey);
      const model = modelRuntime.getModel(input.model.providerId, input.model.modelId);
      if (!model) throw new Error(`Pi does not support ${input.model.providerId}/${input.model.modelId}.`);
      const contextWindow = getContextWindow(model);
      // Omitting sessionDir lets Pi resolve its own default under the agent dir (sessions/<encoded-cwd>/);
      // passing agentDir there would write transcripts flat into the agent dir root instead.
      const sessionManager = options.persistTranscripts?.() ? sdk.SessionManager.create(cwd) : sdk.SessionManager.inMemory(cwd);
      const result = await sdk.createAgentSession({
        cwd,
        noTools: "builtin",
        resourceLoader,
        settingsManager,
        modelRuntime,
        model,
        sessionManager,
      });
      const unsubscribe = result.session.subscribe((event) => currentProjector?.handle(event));
      return {
        prompt: async (text, budget, report = () => {}, runId) => {
          if (running) throw new Error("A run is already in progress for this session.");
          running = true;
          currentRunId = runId;
          resetRun(state, budget);
          const projector = createRunProgress(state, report);
          currentProjector = projector;
          projector.start();
          try {
            applyEffortProfile(result.session, settingsManager, effortProfileFor(budget.level), contextWindow);
            const { status } = await runTaskLoop(state, effortProfileFor(budget.level), text, (round) => {
              projector.round();
              return result.session.prompt(round);
            });
            const outcome = buildOutcome(state, status);
            if (status === "completed") state.plan = null;
            const validated = validateAgentRunOutcome(outcome);
            if (!validated) throw new Error("Produced an invalid run outcome.");
            const message = state.lastAssistantText || validated.summary || "";
            return { message, outcome: validated };
          } finally {
            projector.end();
            currentProjector = null;
            running = false;
            currentRunId = null;
          }
        },
        cancel: async () => {
          if (!running) return false;
          // Order matters: flip cancelled before anything else can steer a queued resolution into a new turn.
          state.cancelled = true;
          currentProjector?.cancelling();
          result.session.clearQueue();
          await result.session.abort();
          return true;
        },
        dispose: () => { unsubscribe(); return result.session.dispose(); },
        get running() { return running; },
      };
    },
  };
}

function pendingInputFrom(outcome: AgentRunOutcome | undefined): TaskLoopPendingInput | null {
  if (!outcome || outcome.status !== "needs_input") return null;
  return { question: outcome.summary, missing: outcome.missing };
}

function getContextWindow(model: unknown): number {
  const contextWindow = isRecord(model) ? model.contextWindow : undefined;
  return typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : 200_000;
}

/** Applies the level's thinking level and compaction overrides for this run's prompt(); see AGENT_EFFORT_PROFILES. */
function applyEffortProfile(session: PiAgentSession, settingsManager: PiSettingsManager, profile: AgentEffortProfile, contextWindow: number): void {
  session.setThinkingLevel(profile.thinking);
  const reserveTokens = profile.compactionTrigger === null ? 16_384 : Math.max(16_384, Math.round(contextWindow * (1 - profile.compactionTrigger)));
  const keepRecentTokens = Math.min(profile.keepRecentTokens, Math.floor((contextWindow - reserveTokens) / 2));
  settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens, keepRecentTokens } });
}

export class AgentRuntimeWorker {
  private negotiatedVersion: ApiVersion | undefined;
  private readonly sessions = new Map<string, { session: PiSession; signature: string }>();

  constructor(
    private readonly sessionsFactory: PiSessionFactory = createPiSessionFactory(),
    private readonly hostCapabilities?: HostCapabilityTransport,
    private readonly pluginDiscovery?: PluginDiscovery,
    private readonly notify: (notification: RpcNotification) => void = () => {},
  ) {}

  async handleJsonl(line: string): Promise<string[]> {
    const message = parseJsonl(line);
    if (message.kind !== "request") return [];
    return [encodeJsonl(await this.handleRequest(message))];
  }

  async invokeHost(permission: PluginPermission, capability: string, operation: string, params: JsonValue): Promise<JsonValue> {
    if (!this.hostCapabilities) throw new Error("Host capability transport is unavailable.");
    return this.hostCapabilities.request("host.capability.invoke", { permission, capability, operation, params });
  }

  async dispose(): Promise<void> {
    const activeSessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(activeSessions.map(async ({ session }) => { await session.dispose(); }));
  }

  private async handleRequest(request: RpcRequest): Promise<RpcResponseSuccess | RpcResponseFailure> {
    try {
      if (request.method === HOST_HELLO_METHOD) return this.handleHostHello(request);
      if (!this.negotiatedVersion) return this.failure(request, "protocol.not-negotiated", "host.hello must complete before session requests.");
      if (request.protocolVersion !== this.negotiatedVersion) return this.failure(request, "protocol.version-mismatch", "The request uses an unnegotiated protocol version.");
      if (request.method === "session.initialize") return await this.initializeSession(request);
      if (request.method === "session.send") return await this.sendToSession(request);
      if (request.method === "session.cancel") return await this.cancelSession(request);
      if (request.method === "session.close") return await this.closeSession(request);
      if (request.method === "runtime.plugins.discover") return await this.discoverPlugins(request);
      if (request.method === "runtime.plugin.invoke") return await this.invokePlugin(request);
      return this.failure(request, "method.not-found", `Unsupported runtime method: ${request.method}`);
    } catch (error) {
      return this.failure(request, "runtime.error", error instanceof Error ? error.message : "Agent runtime failed.");
    }
  }

  private handleHostHello(request: RpcRequest): RpcResponseSuccess | RpcResponseFailure {
    const hostHello = parseHostHello(request.params);
    if (!hostHello) return this.failure(request, "protocol.invalid-hello", "host.hello requires hostId, protocol and capabilities.");
    const version = negotiateProtocolVersion(hostHello.protocol, PROTOCOL_VERSION_RANGE);
    if (!version) return this.failure(request, "protocol.incompatible", "The host and runtime have no common protocol version.");
    this.negotiatedVersion = version;
    const hello: RuntimeHello = {
      runtimeId: AGENT_RUNTIME_ID,
      protocol: PROTOCOL_VERSION_RANGE,
      capabilities: AGENT_RUNTIME_CAPABILITIES,
    };
    return this.success(request, hello as unknown as JsonValue);
  }

  private async initializeSession(request: RpcRequest): Promise<RpcResponseSuccess | RpcResponseFailure> {
    const params = readSessionParams(request.params, false);
    if (!params) return this.failure(request, "session.invalid", "session.initialize requires sessionId and an optional cwd.");
    let outcome: AgentRunOutcome | undefined;
    if (params.outcome !== undefined) {
      outcome = validateAgentRunOutcome(params.outcome);
      if (!outcome) return this.failure(request, "session.invalid", "session.initialize outcome is invalid.");
    }
    const model = await this.hostModelSelection();
    const signature = JSON.stringify([params.cwd ?? "", params.systemPrompt ?? "", model.providerId, model.modelId, model.credentialId ?? ""]);
    const existing = this.sessions.get(params.sessionId);
    if (existing?.signature === signature) return this.success(request, { sessionId: params.sessionId, reused: true });
    if (existing?.session.running) return this.failure(request, "session.busy", "The session has a run in progress; wait for it to finish or cancel it first.");
    if (existing) await existing.session.dispose();
    const session = await this.sessionsFactory.create({ sessionId: params.sessionId, cwd: params.cwd, systemPrompt: params.systemPrompt, model, ...(outcome ? { outcome } : {}) });
    this.sessions.set(params.sessionId, { session, signature });
    return this.success(request, { sessionId: params.sessionId });
  }

  private async sendToSession(request: RpcRequest): Promise<RpcResponseSuccess | RpcResponseFailure> {
    const params = readSessionParams(request.params, true);
    if (!params) return this.failure(request, "session.invalid", "session.send requires sessionId and input.");
    const runId = params.runId;
    if (!isValidRunId(runId)) return this.failure(request, "session.invalid", `session.send requires a non-empty runId of at most ${AGENT_RUN_ID_MAX_LENGTH} characters.`);
    const record = this.sessions.get(params.sessionId);
    if (!record) return this.failure(request, "session.not-found", "The session is not initialized.");
    let budget: AgentRunBudget;
    if (params.budget !== undefined) {
      const validated = validateAgentRunBudget(params.budget);
      if (!validated) return this.failure(request, "session.invalid", "session.send budget is invalid.");
      budget = validated;
    } else {
      budget = estimateAgentRunBudget(DEFAULT_AGENT_EFFORT, []);
    }
    const sessionId = params.sessionId;
    const protocolVersion = this.negotiatedVersion ?? request.protocolVersion;
    const report = (view: AgentRunView): void => {
      const notification: RpcNotification = { kind: "notification", protocolVersion, event: AGENT_RUN_PROGRESS_EVENT, params: { sessionId, runId, ...view } as unknown as JsonValue };
      this.safeNotify(notification);
    };
    const { message, outcome } = await record.session.prompt(params.input, budget, report, runId);
    const result: AgentSessionSendResult = { sessionId: params.sessionId, accepted: true, message, outcome };
    return this.success(request, result as unknown as JsonValue);
  }

  private safeNotify(notification: RpcNotification): void {
    try {
      this.notify(notification);
    } catch {
      // A misbehaving notification sink must never fail the run.
    }
  }

  private async cancelSession(request: RpcRequest): Promise<RpcResponseSuccess | RpcResponseFailure> {
    const params = readSessionParams(request.params, false);
    if (!params) return this.failure(request, "session.invalid", "session.cancel requires sessionId.");
    const record = this.sessions.get(params.sessionId);
    if (!record) return this.success(request, { sessionId: params.sessionId, cancelled: false });
    const cancelled = await record.session.cancel();
    return this.success(request, { sessionId: params.sessionId, cancelled });
  }

  private async hostModelSelection(): Promise<PiModelSelection> {
    if (!this.hostCapabilities) throw new Error("Host model capability is unavailable.");
    const value = await this.hostCapabilities.request("host.model.resolve", {});
    if (!isRecord(value) || typeof value.providerId !== "string" || typeof value.modelId !== "string" || !Array.isArray(value.credentials)
      || !value.providerId || !value.modelId) {
      throw new Error("Host returned an invalid model selection.");
    }
    const credentials = (value.credentials as unknown[]).filter(isHostModelCredential);
    if (!credentials.length) throw new Error("No eligible credential is available for the selected model.");
    const adapter: ProviderAdapterHost = {
      authorize: async () => { throw new Error("Authentication is managed by the native host."); },
      remove: async () => {},
      request: async (credentialId) => {
        const credential = credentials.find((item) => item.id === credentialId);
        if (!credential) throw new Error("The routed credential is no longer available.");
        return { output: credential };
      },
    };
    const gateway = new ModelAuthGateway(
      credentials.map((credential) => createCredentialMetadata({
        id: credential.id,
        providerId: credential.providerId,
        authMethod: credential.authMethod,
        modelIds: [credential.modelId],
      })),
      new Map([[value.providerId, adapter]]),
    );
    const routed = await gateway.request(value.providerId, { modelId: value.modelId, input: null });
    if (routed.kind !== "ok" || !isHostModelCredential(routed.value.output)) throw new Error("The selected model is unsupported.");
    const selected = routed.value.output;
    return { providerId: selected.providerId, modelId: selected.modelId, apiKey: selected.apiKey, credentialId: selected.id };
  }

  private async closeSession(request: RpcRequest): Promise<RpcResponseSuccess | RpcResponseFailure> {
    const params = readSessionParams(request.params, false);
    if (!params) return this.failure(request, "session.invalid", "session.close requires sessionId.");
    const record = this.sessions.get(params.sessionId);
    if (!record) return this.failure(request, "session.not-found", "The session is not initialized.");
    await record.session.dispose();
    this.sessions.delete(params.sessionId);
    return this.success(request, { sessionId: params.sessionId, closed: true });
  }

  private async discoverPlugins(request: RpcRequest): Promise<RpcResponseSuccess | RpcResponseFailure> {
    if (!this.pluginDiscovery) return this.failure(request, "plugins.unsupported", "Plugin discovery is unavailable in this runtime.");
    if (!isRecord(request.params) || typeof request.params.root !== "string" || request.params.root.length === 0
      || !Array.isArray(request.params.enabledPluginIds) || !request.params.enabledPluginIds.every((id) => typeof id === "string" && id.length > 0)) {
      return this.failure(request, "plugins.invalid-root", "runtime.plugins.discover requires a plugin root path and enabled plugin ids.");
    }
    const plugins = await this.pluginDiscovery.discover(request.params.root, request.params.enabledPluginIds as string[]);
    return this.success(request, { plugins: plugins as unknown as JsonValue });
  }

  private async invokePlugin(request: RpcRequest): Promise<RpcResponseSuccess | RpcResponseFailure> {
    if (!this.pluginDiscovery) return this.failure(request, "plugins.unsupported", "Plugin invocation is unavailable in this runtime.");
    if (!isRecord(request.params) || typeof request.params.pluginId !== "string" || request.params.pluginId.length === 0
      || typeof request.params.method !== "string" || request.params.method.length === 0 || !isJsonValue(request.params.params)) {
      return this.failure(request, "plugins.invalid-invoke", "runtime.plugin.invoke requires pluginId, method and params.");
    }
    const invocation = await this.pluginDiscovery.invoke(request.params.pluginId, request.params.method, request.params.params);
    if (invocation.kind === "not-found") return this.failure(request, "plugins.not-found", "The plugin is not loaded.");
    if (invocation.kind === "unsupported") return this.failure(request, "plugins.invoke-unsupported", "The plugin does not expose invoke.");
    return this.success(request, invocation.result);
  }

  private success(request: RpcRequest, result: JsonValue): RpcResponseSuccess {
    return { kind: "response", id: request.id, protocolVersion: this.negotiatedVersion ?? request.protocolVersion, ok: true, result };
  }

  private failure(request: RpcRequest, code: string, message: string): RpcResponseFailure {
    return { kind: "response", id: request.id, protocolVersion: this.negotiatedVersion ?? request.protocolVersion, ok: false, error: { code, message } };
  }
}

export async function loadPluginBackends(
  pluginRoot: string,
  manifests: readonly unknown[],
  host: HostCapabilityTransport,
  loadModule: ModuleLoader = (url) => import(url.href),
): Promise<LoadedPluginBackend[]> {
  const loaded: LoadedPluginBackend[] = [];
  for (const source of manifests) {
    const manifest = validatePluginManifest(source);
    if (!manifest || !isHostApiCompatible(manifest, HOST_API_VERSION) || !manifest.backend) continue;
    const moduleUrl = pluginModuleUrl(pluginRoot, manifest.id, manifest.backend.entry);
    const module = await loadModule(moduleUrl) as PluginBackendModule;
    const context: PluginBackendContext = {
      plugin: manifest,
      invokeHost: async (permission, capability, operation, params) => {
        const permissionLevel = pluginPermissionLevel(manifest, permission);
        if (permissionLevel === "none") throw new Error(`Plugin ${manifest.id} has not declared ${permission}.`);
        return host.request("host.capability.invoke", { pluginId: manifest.id, permission, permissionLevel, capability, operation, params });
      },
    };
    await module.activate?.(context);
    const entryPath = fileURLToPath(moduleUrl);
    loaded.push({
      manifest,
      entryPath,
      ...(typeof module.default === "function" ? { piExtensionPath: entryPath } : {}),
      deactivate: async () => { await module.deactivate?.(); },
      ...(typeof module.invoke === "function" ? { invoke: async (method, params) => module.invoke!(context, method, params) } : {}),
    });
  }
  return loaded;
}

function pluginModuleUrl(pluginRoot: string, pluginId: string, entry: string): URL {
  const root = new URL(pluginRoot.endsWith("/") ? pluginRoot : `${pluginRoot}/`, "file:///");
  return new URL(`${pluginId}/${entry}`, root);
}

function parseHostHello(value: JsonValue): HostHello | undefined {
  if (!isRecord(value) || typeof value.hostId !== "string" || !isVersionRange(value.protocol) || !Array.isArray(value.capabilities)) return undefined;
  const capabilities: unknown[] = value.capabilities;
  if (!capabilities.every(isCapabilityDescriptor)) return undefined;
  return { hostId: value.hostId, protocol: value.protocol, capabilities };
}

function readSessionParams(value: JsonValue, requiresInput: boolean): { sessionId: string; cwd?: string; systemPrompt?: string; input: string; outcome?: JsonValue; budget?: JsonValue; runId?: JsonValue } | undefined {
  if (!isRecord(value) || typeof value.sessionId !== "string" || value.sessionId.length === 0) return undefined;
  if (value.cwd !== undefined && typeof value.cwd !== "string") return undefined;
  if (value.systemPrompt !== undefined && (typeof value.systemPrompt !== "string" || value.systemPrompt.length === 0)) return undefined;
  if (requiresInput && (typeof value.input !== "string" || value.input.length === 0)) return undefined;
  return {
    sessionId: value.sessionId,
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(typeof value.systemPrompt === "string" ? { systemPrompt: value.systemPrompt } : {}),
    input: typeof value.input === "string" ? value.input : "",
    ...(value.outcome !== undefined ? { outcome: value.outcome } : {}),
    ...(value.budget !== undefined ? { budget: value.budget } : {}),
    ...(value.runId !== undefined ? { runId: value.runId } : {}),
  };
}

function isValidRunId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= AGENT_RUN_ID_MAX_LENGTH;
}

function isCapabilityDescriptor(value: unknown): value is CapabilityDescriptor {
  return isRecord(value) && typeof value.id === "string" && typeof value.version === "string" && Array.isArray(value.operations)
    && value.operations.every((operation) => typeof operation === "string");
}

function isVersionRange(value: unknown): value is { min: ApiVersion; max: ApiVersion } {
  return isRecord(value) && typeof value.min === "string" && typeof value.max === "string";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

async function loadPiSdk(): Promise<PiSdk> {
  return await import("@earendil-works/pi-coding-agent") as unknown as PiSdk;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupported<T>(reason: string): ModelAuthResult<T> {
  return { kind: "unsupported", reason };
}

function toRouteError(error: unknown): { kind: "http"; status: number } | { kind: "transport" } {
  if (isRecord(error) && typeof error.status === "number") return { kind: "http", status: error.status };
  return { kind: "transport" };
}

function isHostModelCredential(value: unknown): value is HostModelCredential {
  return isRecord(value) && typeof value.id === "string" && typeof value.providerId === "string" && typeof value.modelId === "string"
    && typeof value.apiKey === "string" && (value.authMethod === "api-key" || value.authMethod === "oauth")
    && value.id.length > 0 && value.providerId.length > 0 && value.modelId.length > 0 && value.apiKey.length > 0;
}
