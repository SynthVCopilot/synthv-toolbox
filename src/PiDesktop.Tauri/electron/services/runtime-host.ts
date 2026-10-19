import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { AgentRuntimeWorker, type PiSessionFactory } from "@synthv-toolbox/agent-runtime";
import {
  AGENT_RUN_PROGRESS_EVENT,
  pluginPermissionLevel,
  validatePluginManifest,
  type AgentRunProgress,
  type JsonValue,
  type PluginManifest,
  type PluginPermission,
  type RpcNotification,
} from "@synthv-toolbox/runtime-protocol";
import { ClientError, MCP_SERVER_NAME, SUPPORTED_MCP_PROTOCOL_VERSIONS, type HttpMcpServer } from "./http-mcp-server.js";

export interface ElectronRuntimeHostOptions {
  sessionFactory?: PiSessionFactory;
  onAgentProgress?: (progress: AgentRunProgress) => void;
}

export interface RuntimeHostSettings {
  pluginInternalFunctionsEnabled: boolean;
  pluginAdvancedFunctionsEnabled: boolean;
  mcpInternalFunctionsEnabled: boolean;
  mcpAdvancedFunctionsEnabled: boolean;
  httpApiEnabled: boolean;
  httpAgentEnabled: boolean;
  httpApiPort: number;
  /** Bearer token for the local HTTP MCP and agent endpoints; generated on first load. */
  httpApiToken: string;
}

export interface PluginState {
  enabled: boolean;
  internalFunctionsEnabled: boolean;
  advancedFunctionsEnabled: boolean;
}

export interface HostCapabilityInvoker {
  invoke(permission: "host.internal" | "host.advanced", capability: string, operation: string, params: JsonValue): Promise<JsonValue>;
  resolveModel?(): Promise<JsonValue>;
}

const defaultSettings = (): RuntimeHostSettings => ({
  pluginInternalFunctionsEnabled: false,
  pluginAdvancedFunctionsEnabled: false,
  mcpInternalFunctionsEnabled: false,
  mcpAdvancedFunctionsEnabled: false,
  httpApiEnabled: false,
  httpAgentEnabled: false,
  httpApiPort: 17831,
  httpApiToken: "",
});
/** Same rule validatePluginManifest applies to manifest ids, so a valid id is always a single safe path segment. */
const pluginIdPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

export class ElectronRuntimeHost {
  private settings = defaultSettings();
  private requestId = 0;
  private runtimeNegotiated = false;
  readonly runtime: AgentRuntimeWorker;
  private httpServer?: HttpMcpServer;

  constructor(
    private readonly root: string,
    private readonly hostCapabilities: HostCapabilityInvoker,
    options: ElectronRuntimeHostOptions = {},
  ) {
    // The Pi SDK reads this at request time; the default 5-minute TTL expires between editing turns.
    process.env.PI_CACHE_RETENTION ??= "long";
    this.runtime = new AgentRuntimeWorker(
      options.sessionFactory,
      {
        request: async (method, value) => {
          if (method === "host.model.resolve") {
            if (!this.hostCapabilities.resolveModel) throw new Error("No model resolver is configured.");
            return this.hostCapabilities.resolveModel();
          }
          if (method !== "host.capability.invoke") throw new Error("Unsupported host runtime request.");
          const request = value as { pluginId?: string; permission?: PluginPermission; capability?: string; operation?: string; params?: JsonValue };
          if (request.permission !== "host.internal" && request.permission !== "host.advanced") throw new Error("Unsupported plugin host permission.");
          if (typeof request.pluginId !== "string") throw new Error("Plugin host requests require pluginId.");
          await this.assertPluginPermission(request.pluginId, request.permission);
          return this.hostCapabilities.invoke(request.permission, request.capability ?? "", request.operation ?? "", request.params ?? null);
        },
      },
      undefined,
      (notification: RpcNotification) => {
        if (notification.event !== AGENT_RUN_PROGRESS_EVENT || !options.onAgentProgress) return;
        options.onAgentProgress(notification.params as unknown as AgentRunProgress);
      },
    );
  }

  async load(): Promise<RuntimeHostSettings> {
    let readable = true;
    try {
      this.settings = { ...defaultSettings(), ...JSON.parse(await readFile(this.settingsPath(), "utf8")) };
    } catch (error) {
      // A locked or damaged file must not be overwritten with defaults just to store a token.
      readable = (error as NodeJS.ErrnoException).code === "ENOENT";
      this.settings = defaultSettings();
    }
    if (typeof this.settings.httpApiToken !== "string" || !this.settings.httpApiToken) {
      this.settings.httpApiToken = createApiToken();
      // An unsaved token still protects this session; MCP clients only need re-pairing after the next start.
      if (readable) await this.persist().catch((error) => console.error("Could not save the HTTP API token:", error));
    }
    return this.settings;
  }

  async configure(next: RuntimeHostSettings): Promise<void> {
    this.settings = { ...next, httpApiToken: next.httpApiToken || this.settings.httpApiToken || createApiToken() };
    await this.persist();
    await this.syncHttpServer();
  }

  async rotateHttpApiToken(): Promise<JsonValue> {
    const next = { ...this.settings, httpApiToken: createApiToken() };
    // The server switches first. Status reports the token from settings, so publishing it earlier would let the old
    // token keep working after a client has already been shown the new one.
    await this.syncHttpServer(next);
    this.settings = next;
    await this.persist();
    return this.httpMcpStatus();
  }

  async attachHttpServer(server: HttpMcpServer): Promise<void> { this.httpServer = server; await this.syncHttpServer(); }

  settingsSnapshot(): RuntimeHostSettings { return { ...this.settings }; }

  async httpMcpStatus(): Promise<JsonValue> {
    const tools = [...await this.mcpTools(), ...(this.settings.httpApiEnabled && this.settings.httpAgentEnabled ? ["toolbox_agent"] : [])];
    const server = this.httpServer?.status();
    return {
      enabled: this.settings.httpApiEnabled,
      agentEnabled: this.settings.httpAgentEnabled,
      internalFunctionsEnabled: this.settings.mcpInternalFunctionsEnabled,
      advancedFunctionsEnabled: this.settings.mcpAdvancedFunctionsEnabled,
      running: server?.running ?? false,
      port: this.settings.httpApiPort,
      endpoint: server?.endpoint ?? null,
      agentEndpoint: server?.agentEndpoint ?? null,
      lastError: server?.lastError ?? null,
      token: this.settings.httpApiToken,
      authRequired: true,
      serverName: server?.serverName ?? MCP_SERVER_NAME,
      protocolVersions: [...SUPPORTED_MCP_PROTOCOL_VERSIONS],
      tools,
    };
  }

  // start() keeps a running server whose config is unchanged, so open MCP sessions survive unrelated settings saves.
  private async syncHttpServer(settings = this.settings): Promise<void> { if (this.httpServer) await this.httpServer.start({ enabled: settings.httpApiEnabled, agentEnabled: settings.httpAgentEnabled, internalEnabled: settings.mcpInternalFunctionsEnabled, advancedEnabled: settings.mcpAdvancedFunctionsEnabled, port: settings.httpApiPort, token: settings.httpApiToken }); }

  /** The file holds the HTTP API bearer token, so it is created owner-only (rm first: writeFile keeps an existing file's mode). */
  private async persist(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const temporary = `${this.settingsPath()}.tmp`;
    await rm(temporary, { force: true });
    await writeFile(temporary, JSON.stringify(this.settings), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.settingsPath());
  }

  async invokePlugin(pluginId: string, method: string, params: JsonValue): Promise<JsonValue> {
    return this.runtimeRequest("runtime.plugin.invoke", { pluginId, method, params });
  }

  async installPlugin(source: string): Promise<PluginManifest> {
    const manifest = await this.readManifest(source);
    const destination = join(this.pluginsRoot(), manifest.id);
    await mkdir(this.pluginsRoot(), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
    await this.writePluginState(manifest.id, {
      enabled: !this.requiresGrant(manifest),
      internalFunctionsEnabled: false,
      advancedFunctionsEnabled: false,
    });
    return manifest;
  }

  async contributions(): Promise<Array<{ manifest: PluginManifest; state: PluginState }>> {
    const ids = await this.pluginIds();
    return Promise.all(ids.map(async (id) => {
      const manifest = await this.readManifest(join(this.pluginsRoot(), id));
      return { manifest, state: await this.readPluginState(id) };
    }));
  }

  async setPluginGrant(id: string, kind: "internal" | "advanced", enabled: boolean): Promise<PluginState> {
    const manifest = await this.readManifest(await this.installedPluginDirectory(id));
    const permission = kind === "internal" ? "host.internal" : "host.advanced";
    if (enabled && pluginPermissionLevel(manifest, permission) === "none") throw new Error("Plugin did not declare this permission.");
    const state = await this.readPluginState(id);
    if (kind === "internal") state.internalFunctionsEnabled = enabled;
    else state.advancedFunctionsEnabled = enabled;
    await this.writePluginState(id, state);
    return state;
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<PluginState> {
    await this.installedPluginDirectory(id);
    const state = await this.readPluginState(id);
    state.enabled = enabled;
    await this.writePluginState(id, state);
    return state;
  }

  async uninstallPlugin(id: string): Promise<void> { await rm(await this.installedPluginDirectory(id), { recursive: true, force: false }); }

  async mcpTools(): Promise<string[]> {
    return [
      ...(this.settings.mcpInternalFunctionsEnabled ? ["toolbox_internal"] : []),
      ...(this.settings.mcpAdvancedFunctionsEnabled ? ["toolbox_advanced"] : []),
    ];
  }

  async callMcpTool(name: string, argumentsValue: JsonValue): Promise<JsonValue> {
    const permission = name === "toolbox_internal" ? "host.internal" : name === "toolbox_advanced" ? "host.advanced" : undefined;
    if (!permission || !(await this.mcpTools()).includes(name)) throw new Error("MCP tool is unavailable.");
    if (!isObject(argumentsValue)) throw new Error("MCP privileged tool arguments must be an object.");
    const args = argumentsValue as { capability?: unknown; operation?: unknown; params?: unknown; permission?: unknown };
    if (typeof args.capability !== "string" || typeof args.operation !== "string" || !isObject(args.params) || "permission" in args) {
      throw new ClientError("MCP privileged tool requires capability, operation, and object params.");
    }
    return this.hostCapabilities.invoke(permission, args.capability, args.operation, args.params as JsonValue);
  }

  private async assertPluginPermission(id: string, permission: "host.internal" | "host.advanced"): Promise<void> {
    const manifest = await this.readManifest(await this.installedPluginDirectory(id));
    if (pluginPermissionLevel(manifest, permission) === "none") throw new Error("Plugin did not declare this permission.");
    const globalEnabled = permission === "host.internal" ? this.settings.pluginInternalFunctionsEnabled : this.settings.pluginAdvancedFunctionsEnabled;
    const state = await this.readPluginState(id);
    const granted = permission === "host.internal" ? state.internalFunctionsEnabled : state.advancedFunctionsEnabled;
    if (!globalEnabled || !granted || !state.enabled) throw new Error("Plugin privileged capability is not authorized.");
  }

  private requiresGrant(manifest: PluginManifest): boolean {
    return pluginPermissionLevel(manifest, "host.internal") === "required" || pluginPermissionLevel(manifest, "host.advanced") === "required";
  }

  private settingsPath(): string { return join(this.root, "runtime-settings.json"); }
  private pluginsRoot(): string { return join(this.root, "plugins"); }
  private statePath(id: string): string { return join(this.pluginsRoot(), id, ".runtime-state.json"); }
  private async readPluginState(id: string): Promise<PluginState> {
    try { return { enabled: true, internalFunctionsEnabled: false, advancedFunctionsEnabled: false, ...JSON.parse(await readFile(this.statePath(id), "utf8")) }; }
    catch { return { enabled: false, internalFunctionsEnabled: false, advancedFunctionsEnabled: false }; }
  }
  private async writePluginState(id: string, state: PluginState): Promise<void> { await writeFile(this.statePath(id), JSON.stringify(state), "utf8"); }
  private async pluginIds(): Promise<string[]> {
    try { return await readdir(this.pluginsRoot()); } catch { return []; }
  }
  /** Plugin ids arrive from renderer commands and plugin requests; only an installed plugin's own directory may be touched. */
  private async installedPluginDirectory(id: string): Promise<string> {
    const directory = resolve(this.pluginsRoot(), String(id));
    if (typeof id !== "string" || !pluginIdPattern.test(id) || relative(this.pluginsRoot(), directory) !== id) throw new Error("Plugin id is invalid.");
    if (!(await this.pluginIds()).includes(id)) throw new Error("Plugin is not installed.");
    return directory;
  }
  private async readManifest(directory: string): Promise<PluginManifest> {
    const manifest = validatePluginManifest(JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8")));
    if (!manifest) throw new Error("Invalid plugin manifest.");
    return manifest;
  }

  private async runtimeRequest(method: string, params: JsonValue): Promise<JsonValue> {
    if (!this.runtimeNegotiated) {
      const hello = await this.rawRuntimeRequest("host.hello", {
        hostId: "electron-main",
        protocol: { min: "1.0", max: "1.0" },
        capabilities: [],
      });
      if (!hello) throw new Error("Agent runtime negotiation failed.");
      this.runtimeNegotiated = true;
    }
    return this.rawRuntimeRequest(method, params);
  }

  private async rawRuntimeRequest(method: string, params: JsonValue): Promise<JsonValue> {
    const request = JSON.stringify({ kind: "request", id: `electron-${++this.requestId}`, protocolVersion: "1.0", method, params });
    const responses = await this.runtime.handleJsonl(request);
    if (responses.length !== 1) throw new Error("Agent runtime returned an invalid response count.");
    const response: unknown = JSON.parse(responses[0]);
    if (!isObject(response) || response.kind !== "response" || typeof response.ok !== "boolean") throw new Error("Agent runtime returned an invalid response.");
    if (!response.ok) throw new Error(isObject(response.error) && typeof response.error.message === "string" ? response.error.message : "Agent runtime request failed.");
    return response.result as JsonValue;
  }
}

function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function createApiToken(): string { return randomBytes(32).toString("base64url"); }
