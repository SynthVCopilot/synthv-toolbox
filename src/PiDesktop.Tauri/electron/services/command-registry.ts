import type { JsonValue } from "../../../../packages/runtime-protocol/src/index.js";
import type { ElectronRuntimeHost } from "./runtime-host.js";

export type EventSink = (event: string, payload: JsonValue) => void;
export type CommandHandler = (params: Record<string, unknown>) => Promise<JsonValue>;

export const ELECTRON_MIGRATED_COMMANDS = [
  "bootstrap", "list_installed_plugins", "install_agent_plugin", "uninstall_agent_plugin",
  "set_agent_plugin_enabled", "set_agent_plugin_internal_functions_enabled",
  "set_agent_plugin_advanced_functions_enabled", "agent_session_initialize",
  "agent_session_send", "agent_session_close", "get_http_api_status", "configure_http_api",
] as const;

export const ELECTRON_UNMIGRATED_COMMAND_AREAS = [
  "SynthV profiles, bridge, and application lifecycle",
  "AI account management and renderer conversations",
  "audio, media, lyrics, tuning, project, and workflow operations",
  "MCP server configuration and remaining settings",
] as const;

export class ElectronCommandRegistry {
  private readonly handlers = new Map<string, CommandHandler>();
  constructor(private readonly host: ElectronRuntimeHost, private readonly emit: EventSink = () => {}) { this.registerCore(); }

  async invoke(command: string, params: Record<string, unknown> = {}): Promise<JsonValue> {
    if (typeof command !== "string" || !command.trim()) throw new Error("command must be a non-empty string.");
    if (!isObject(params)) throw new Error("Command parameters must be an object.");
    const handler = this.handlers.get(command);
    if (!handler) throw new Error(`Electron command is not implemented: ${command}`);
    const result = await handler(params);
    this.emit("electron-command-completed", { command });
    return result;
  }

  private registerCore(): void {
    this.handlers.set("bootstrap", async () => ({ settings: await this.host.load(), plugins: await this.host.contributions() }));
    this.handlers.set("list_installed_plugins", async () => this.host.contributions());
    this.handlers.set("install_agent_plugin", async p => this.host.installPlugin(stringParam(p, "sourcePath")));
    this.handlers.set("uninstall_agent_plugin", async p => { await this.host.uninstallPlugin(stringParam(p, "pluginId")); return null; });
    this.handlers.set("set_agent_plugin_enabled", async p => this.host.setPluginEnabled(stringParam(p, "pluginId"), boolParam(p, "enabled")));
    this.handlers.set("set_agent_plugin_internal_functions_enabled", async p => this.host.setPluginGrant(stringParam(p, "pluginId"), "internal", boolParam(p, "enabled")));
    this.handlers.set("set_agent_plugin_advanced_functions_enabled", async p => this.host.setPluginGrant(stringParam(p, "pluginId"), "advanced", boolParam(p, "enabled")));
    this.handlers.set("agent_session_initialize", async p => this.host.initializeAgentSession(stringParam(p, "sessionId"), optionalStringParam(p, "cwd"), optionalStringParam(p, "systemPrompt")));
    this.handlers.set("agent_session_send", async p => this.host.sendAgentMessage(stringParam(p, "sessionId"), stringParam(p, "input")));
    this.handlers.set("agent_session_close", async p => this.host.closeAgentSession(stringParam(p, "sessionId")));
    this.handlers.set("get_http_api_status", async () => this.host.httpMcpStatus());
    this.handlers.set("configure_http_api", async p => {
      const current = this.host.settingsSnapshot();
      await this.host.configure({ ...current, httpApiEnabled: boolParam(p, "enabled"), httpAgentEnabled: boolParam(p, "agentEnabled"), mcpInternalFunctionsEnabled: boolParam(p, "internalFunctionsEnabled"), mcpAdvancedFunctionsEnabled: boolParam(p, "advancedFunctionsEnabled"), httpApiPort: portParam(p, "port") });
      return this.host.httpMcpStatus();
    });
  }
}

function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function stringParam(params: Record<string, unknown>, key: string): string { const value = params[key]; if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string.`); return value; }
function optionalStringParam(params: Record<string, unknown>, key: string): string | undefined { return params[key] === undefined ? undefined : stringParam(params, key); }
function boolParam(params: Record<string, unknown>, key: string): boolean { if (typeof params[key] !== "boolean") throw new Error(`${key} must be a boolean.`); return params[key] as boolean; }
function portParam(params: Record<string, unknown>, key: string): number { const value = params[key]; if (typeof value !== "number" || !Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${key} must be a TCP port between 1024 and 65535.`); return value; }
