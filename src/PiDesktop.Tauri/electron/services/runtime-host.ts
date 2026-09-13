import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentRuntimeWorker, type PiSessionFactory } from "../../../../packages/agent-runtime/src/index.js";
import {
  pluginPermissionLevel,
  validatePluginManifest,
  type JsonValue,
  type PluginManifest,
  type PluginPermission,
} from "../../../../packages/runtime-protocol/src/index.js";

export interface RuntimeHostSettings {
  pluginInternalFunctionsEnabled: boolean;
  pluginAdvancedFunctionsEnabled: boolean;
  mcpInternalFunctionsEnabled: boolean;
  mcpAdvancedFunctionsEnabled: boolean;
  httpApiEnabled: boolean;
  httpAgentEnabled: boolean;
  httpApiPort: number;
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
});

export class ElectronRuntimeHost {
  private settings = defaultSettings();
  private requestId = 0;
  private runtimeNegotiated = false;
  readonly runtime: AgentRuntimeWorker;

  constructor(
    private readonly root: string,
    private readonly hostCapabilities: HostCapabilityInvoker,
    sessionFactory?: PiSessionFactory,
  ) {
    this.runtime = new AgentRuntimeWorker(sessionFactory, {
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
    });
  }

  async load(): Promise<RuntimeHostSettings> {
    try {
      this.settings = { ...defaultSettings(), ...JSON.parse(await readFile(this.settingsPath(), "utf8")) };
    } catch {
      this.settings = defaultSettings();
    }
    return this.settings;
  }

  async configure(next: RuntimeHostSettings): Promise<void> {
    this.settings = { ...next };
    await mkdir(this.root, { recursive: true });
    const temporary = `${this.settingsPath()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.settings), "utf8");
    await rename(temporary, this.settingsPath());
  }

  settingsSnapshot(): RuntimeHostSettings { return { ...this.settings }; }

  async httpMcpStatus(): Promise<JsonValue> {
    const tools = await this.mcpTools();
    return {
      enabled: this.settings.httpApiEnabled,
      agentEnabled: this.settings.httpAgentEnabled,
      internalFunctionsEnabled: this.settings.mcpInternalFunctionsEnabled,
      advancedFunctionsEnabled: this.settings.mcpAdvancedFunctionsEnabled,
      running: false,
      port: this.settings.httpApiPort,
      endpoint: null,
      agentEndpoint: null,
      lastError: null,
      tools,
    };
  }

  async initializeAgentSession(sessionId: string, cwd?: string, systemPrompt?: string): Promise<JsonValue> {
    const params: Record<string, JsonValue> = { sessionId };
    if (cwd !== undefined) params.cwd = cwd;
    if (systemPrompt !== undefined) params.systemPrompt = systemPrompt;
    return this.runtimeRequest("session.initialize", params);
  }

  async sendAgentMessage(sessionId: string, input: string): Promise<JsonValue> {
    return this.runtimeRequest("session.send", { sessionId, input });
  }

  async closeAgentSession(sessionId: string): Promise<JsonValue> {
    return this.runtimeRequest("session.close", { sessionId });
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
    const manifest = await this.readManifest(join(this.pluginsRoot(), id));
    const permission = kind === "internal" ? "host.internal" : "host.advanced";
    if (enabled && pluginPermissionLevel(manifest, permission) === "none") throw new Error("Plugin did not declare this permission.");
    const state = await this.readPluginState(id);
    if (kind === "internal") state.internalFunctionsEnabled = enabled;
    else state.advancedFunctionsEnabled = enabled;
    await this.writePluginState(id, state);
    return state;
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<PluginState> {
    const state = await this.readPluginState(id);
    state.enabled = enabled;
    await this.writePluginState(id, state);
    return state;
  }

  async uninstallPlugin(id: string): Promise<void> { await rm(join(this.pluginsRoot(), id), { recursive: true, force: false }); }

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
      throw new Error("MCP privileged tool requires capability, operation, and object params.");
    }
    return this.hostCapabilities.invoke(permission, args.capability, args.operation, args.params as JsonValue);
  }

  private async assertPluginPermission(id: string, permission: "host.internal" | "host.advanced"): Promise<void> {
    const manifest = await this.readManifest(join(this.pluginsRoot(), id));
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
