import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  mcpInternalFunctionsEnabled: boolean;
  mcpAdvancedFunctionsEnabled: boolean;
}

export interface PluginState {
  enabled: boolean;
  internalFunctionsEnabled: boolean;
  advancedFunctionsEnabled: boolean;
}

export interface HostCapabilityInvoker {
  invoke(permission: "host.internal" | "host.advanced", capability: string, operation: string, params: JsonValue): Promise<JsonValue>;
}

const defaultSettings = (): RuntimeHostSettings => ({ mcpInternalFunctionsEnabled: false, mcpAdvancedFunctionsEnabled: false });

export class ElectronRuntimeHost {
  private settings = defaultSettings();
  readonly runtime: AgentRuntimeWorker;

  constructor(
    private readonly root: string,
    private readonly hostCapabilities: HostCapabilityInvoker,
    sessionFactory?: PiSessionFactory,
  ) {
    this.runtime = new AgentRuntimeWorker(sessionFactory, {
      request: async (_method, value) => {
        const request = value as { permission?: PluginPermission; capability?: string; operation?: string; params?: JsonValue };
        if (request.permission !== "host.internal" && request.permission !== "host.advanced") throw new Error("Unsupported plugin host permission.");
        await this.assertPluginPermission(request.permission);
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

  private async assertPluginPermission(permission: "host.internal" | "host.advanced"): Promise<void> {
    const enabled = permission === "host.internal" ? this.settings.mcpInternalFunctionsEnabled : this.settings.mcpAdvancedFunctionsEnabled;
    if (!enabled) throw new Error("Privileged host capability is disabled.");
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
    try { return (await import("node:fs/promises")).readdir(this.pluginsRoot()); } catch { return []; }
  }
  private async readManifest(directory: string): Promise<PluginManifest> {
    const manifest = validatePluginManifest(JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8")));
    if (!manifest) throw new Error("Invalid plugin manifest.");
    return manifest;
  }
}

function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
