import { CredentialRouter, createCredentialMetadata, type CredentialMetadata, type ProviderAdapterHost, type ProviderRequest, type ProviderRequestContext, type ProviderResponse, type ProviderStreamEvent } from "@model-auth/core";
import { fileURLToPath } from "node:url";
import {
  HOST_API_VERSION,
  HOST_HELLO_METHOD,
  PROTOCOL_VERSION_RANGE,
  encodeJsonl,
  isHostApiCompatible,
  negotiateProtocolVersion,
  parseJsonl,
  type ApiVersion,
  type CapabilityDescriptor,
  type HostHello,
  type JsonValue,
  type PluginManifest,
  type PluginPermission,
  type RpcRequest,
  type RpcResponseFailure,
  type RpcResponseSuccess,
  type RuntimeHello,
  validatePluginManifest,
} from "@synthv-toolbox/runtime-protocol";

export const AGENT_RUNTIME_ID = "synthv-toolbox.agent-runtime";

export const AGENT_RUNTIME_CAPABILITIES: CapabilityDescriptor[] = [
  { id: "agent.sessions", version: "1.0", operations: ["initialize", "send", "close"] },
  { id: "host.capabilities", version: "1.0", operations: ["invoke"] },
  { id: "runtime.plugins", version: "1.0", operations: ["discover", "invoke"] },
];

export interface PiSession {
  prompt(input: string): Promise<string>;
  dispose(): void | Promise<void>;
}

export interface PiSessionFactory {
  create(input: { sessionId: string; cwd?: string; systemPrompt?: string; model?: PiModelSelection }): Promise<PiSession>;
}

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
  discover(root: string): Promise<PluginManifest[]>;
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

export interface PiSdk {
  getAgentDir(): string;
  DefaultResourceLoader: new (options: { cwd: string; agentDir: string; additionalExtensionPaths: string[]; systemPrompt?: string }) => PiResourceLoader;
  ModelRuntime: { create(options: { refreshOnCreate: false }): Promise<{ setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>; getModel(providerId: string, modelId: string): unknown }> };
  createAgentSession(options: { cwd: string; noTools: "builtin"; resourceLoader: PiResourceLoader; modelRuntime?: unknown; model?: unknown }): Promise<{ session: { prompt(input: string): Promise<void>; dispose(): void | Promise<void>; agent?: { state?: { messages?: unknown[] } } } }>;
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

export function createPiSessionFactory(
  additionalExtensionPaths: () => readonly string[] = () => [],
  loadSdk: () => Promise<PiSdk> = loadPiSdk,
): PiSessionFactory {
  return {
    async create(input) {
      const sdk = await loadSdk();
      const cwd = input.cwd ?? process.cwd();
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir: sdk.getAgentDir(),
        additionalExtensionPaths: [...additionalExtensionPaths()],
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      });
      await resourceLoader.reload();
      if (!input.model) throw new Error("A host-selected model is required to create a Pi session.");
      const modelRuntime = await sdk.ModelRuntime.create({ refreshOnCreate: false });
      await modelRuntime.setRuntimeApiKey(input.model.providerId, input.model.apiKey);
      const model = modelRuntime.getModel(input.model.providerId, input.model.modelId);
      if (!model) throw new Error(`Pi does not support ${input.model.providerId}/${input.model.modelId}.`);
      const result = await sdk.createAgentSession({
        cwd,
        noTools: "builtin",
        resourceLoader,
        modelRuntime,
        model,
      });
      return {
        prompt: async (text) => {
          await result.session.prompt(text);
          return assistantText(result.session.agent?.state?.messages);
        },
        dispose: () => result.session.dispose(),
      };
    },
  };
}

export class AgentRuntimeWorker {
  private negotiatedVersion: ApiVersion | undefined;
  private readonly sessions = new Map<string, { session: PiSession; signature: string }>();

  constructor(
    private readonly sessionsFactory: PiSessionFactory = createPiSessionFactory(),
    private readonly hostCapabilities?: HostCapabilityTransport,
    private readonly pluginDiscovery?: PluginDiscovery,
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
    const model = await this.hostModelSelection();
    const signature = JSON.stringify([params.cwd ?? "", params.systemPrompt ?? "", model.providerId, model.modelId, model.credentialId ?? ""]);
    const existing = this.sessions.get(params.sessionId);
    if (existing?.signature === signature) return this.success(request, { sessionId: params.sessionId, reused: true });
    if (existing) await existing.session.dispose();
    const session = await this.sessionsFactory.create({ ...params, model });
    this.sessions.set(params.sessionId, { session, signature });
    return this.success(request, { sessionId: params.sessionId });
  }

  private async sendToSession(request: RpcRequest): Promise<RpcResponseSuccess | RpcResponseFailure> {
    const params = readSessionParams(request.params, true);
    if (!params) return this.failure(request, "session.invalid", "session.send requires sessionId and input.");
    const record = this.sessions.get(params.sessionId);
    if (!record) return this.failure(request, "session.not-found", "The session is not initialized.");
    const message = await record.session.prompt(params.input);
    return this.success(request, { sessionId: params.sessionId, accepted: true, message });
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
    if (!isRecord(request.params) || typeof request.params.root !== "string" || request.params.root.length === 0) {
      return this.failure(request, "plugins.invalid-root", "runtime.plugins.discover requires a plugin root path.");
    }
    const plugins = await this.pluginDiscovery.discover(request.params.root);
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
        if (!manifest.permissions.includes(permission)) throw new Error(`Plugin ${manifest.id} has not declared ${permission}.`);
        return host.request("host.capability.invoke", { pluginId: manifest.id, permission, capability, operation, params });
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

function readSessionParams(value: JsonValue, requiresInput: boolean): { sessionId: string; cwd?: string; systemPrompt?: string; input: string } | undefined {
  if (!isRecord(value) || typeof value.sessionId !== "string" || value.sessionId.length === 0) return undefined;
  if (value.cwd !== undefined && typeof value.cwd !== "string") return undefined;
  if (value.systemPrompt !== undefined && (typeof value.systemPrompt !== "string" || value.systemPrompt.length === 0)) return undefined;
  if (requiresInput && (typeof value.input !== "string" || value.input.length === 0)) return undefined;
  return { sessionId: value.sessionId, ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}), ...(typeof value.systemPrompt === "string" ? { systemPrompt: value.systemPrompt } : {}), input: typeof value.input === "string" ? value.input : "" };
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

function assistantText(messages: unknown[] | undefined): string {
  if (!messages) return "";
  for (const message of [...messages].reverse()) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    if (text) return text;
  }
  return "";
}

function isHostModelCredential(value: unknown): value is HostModelCredential {
  return isRecord(value) && typeof value.id === "string" && typeof value.providerId === "string" && typeof value.modelId === "string"
    && typeof value.apiKey === "string" && (value.authMethod === "api-key" || value.authMethod === "oauth")
    && value.id.length > 0 && value.providerId.length > 0 && value.modelId.length > 0 && value.apiKey.length > 0;
}
