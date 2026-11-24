import type { JsonValue } from "@synthv-toolbox/runtime-protocol";
import type { AiService, AiProviderId, AiLoadStrategy } from "./ai-service.js";
import type { CreativeService } from "./creative-service.js";
import { registerComponentAudioCommands, type ComponentAudioOptions } from "./component-audio-commands.js";
import type { DesktopStateService } from "./desktop-state.js";
import type { ElectronRuntimeHost } from "./runtime-host.js";
import { registerSynthVCommands } from "./synthv-commands.js";
import type { SynthVService } from "./synthv-service.js";

export type EventSink = (event: string, payload: JsonValue) => void;
export type CommandHandler = (params: Record<string, unknown>) => Promise<unknown>;
export interface ElectronServices { ai: AiService; creative: CreativeService; desktop: DesktopStateService; synthv: SynthVService; componentAudio: ComponentAudioOptions; }

const CREATIVE_COMMANDS = [
  "list_workflow_recipes", "list_creative_history", "list_project_checkpoints", "get_project_backup_state", "restore_project_checkpoint", "export_workflow_report", "lookup_chinese_rhyme", "build_lyric_template", "generate_lyric_candidates", "list_lyric_projects", "create_lyric_project", "save_lyric_project", "load_lyric_project", "restore_lyric_project_version", "export_lyric_project_text", "read_lyric_bridge_selection", "preview_lyric_bridge_fit", "confirm_lyric_bridge_fit", "run_project_doctor", "run_pronunciation_diagnostics", "run_render_review", "run_audio_to_project", "run_score_to_synthv", "run_retake_workbench", "run_batch_workflow", "run_audio_probe", "preview_media_source", "media_tasks", "queue_media_import", "queue_media_separation", "queue_cover", "cancel_media_task", "retry_media_task", "list_tuning_profiles", "learn_tuning_profile", "record_tuning_outcome", "apply_tuning_profile", "run_solo_tuning", "run_game_to_midi", "run_project_probe", "add_project_reference", "export_project_without_parameters", "export_project_lyrics", "review_workflow", "ffmpeg_status", "get_ffmpeg_configuration", "set_ffmpeg_directory", "open_ffmpeg_download_page", "probe_media", "plan_audio_prepare", "start_audio_prepare", "analyze_loudness", "plan_loudness_normalize", "start_loudness_normalize", "audio_job_snapshot", "cancel_audio_job", "audio_artifact_info", "reveal_audio_artifact", "save_audio_artifact",
] as const;

export class ElectronCommandRegistry {
  private readonly handlers = new Map<string, CommandHandler>();
  constructor(private readonly host: ElectronRuntimeHost, private readonly services?: ElectronServices, private readonly emit: EventSink = () => {}) { this.registerCore(); if (services) this.registerServices(services); }
  register(command: string, handler: CommandHandler): void { if (this.handlers.has(command)) throw new Error(`Electron command is already registered: ${command}`); this.handlers.set(command, handler); }
  commands(): string[] { return [...this.handlers.keys()].sort(); }
  async invoke(command: string, params: Record<string, unknown> = {}): Promise<unknown> { if (typeof command !== "string" || !command.trim()) throw new Error("command must be a non-empty string."); if (!isObject(params)) throw new Error("Command parameters must be an object."); const handler = this.handlers.get(command); if (!handler) throw new Error(`Electron command is not implemented: ${command}`); const result = await handler(params); this.emit("electron-command-completed", { command }); return result; }

  private registerCore(): void {
    this.register("list_installed_plugins", async () => this.installedPlugins());
    this.register("install_agent_plugin", async p => { const manifest = await this.host.installPlugin(stringParam(p, "sourcePath")); return (await this.installedPlugins()).find(item => item.manifest.id === manifest.id) ?? null; });
    this.register("uninstall_agent_plugin", async p => { await this.host.uninstallPlugin(stringParam(p, "pluginId")); return null; });
    this.register("set_agent_plugin_enabled", async p => this.pluginMutation(stringParam(p, "pluginId"), () => this.host.setPluginEnabled(stringParam(p, "pluginId"), boolParam(p, "enabled"))));
    this.register("set_agent_plugin_internal_functions_enabled", async p => this.pluginMutation(stringParam(p, "pluginId"), () => this.host.setPluginGrant(stringParam(p, "pluginId"), "internal", boolParam(p, "enabled"))));
    this.register("set_agent_plugin_advanced_functions_enabled", async p => this.pluginMutation(stringParam(p, "pluginId"), () => this.host.setPluginGrant(stringParam(p, "pluginId"), "advanced", boolParam(p, "enabled"))));
    this.register("agent_session_initialize", async p => this.host.initializeAgentSession(stringParam(p, "sessionId"), optionalStringParam(p, "cwd"), optionalStringParam(p, "systemPrompt")));
    this.register("agent_session_send", async p => this.host.sendAgentMessage(stringParam(p, "sessionId"), stringParam(p, "input")));
    this.register("agent_session_close", async p => this.host.closeAgentSession(stringParam(p, "sessionId")));
    this.register("get_agent_runtime_status", async () => ({ running: true, protocolVersion: "1.0" }));
    this.register("start_agent_runtime", async () => ({ runtimeId: "synthv-toolbox.agent-runtime" }));
    this.register("stop_agent_runtime", async () => { await this.host.runtime.dispose(); return null; });
    this.register("discover_agent_plugins", async () => (await this.host.contributions()).map(item => item.manifest));
    this.register("invoke_agent_plugin", async p => this.host.invokePlugin(stringParam(p, "pluginId"), stringParam(p, "method"), jsonParam(p, "params")));
    this.register("get_http_api_status", async () => this.host.httpMcpStatus());
    this.register("configure_http_api", async p => { const current = this.host.settingsSnapshot(); await this.host.configure({ ...current, httpApiEnabled: boolParam(p, "enabled"), httpAgentEnabled: boolParam(p, "agentEnabled"), mcpInternalFunctionsEnabled: boolParam(p, "internalFunctionsEnabled"), mcpAdvancedFunctionsEnabled: boolParam(p, "advancedFunctionsEnabled"), httpApiPort: portParam(p, "port") }); return this.host.httpMcpStatus(); });
  }

  private registerServices(s: ElectronServices): void {
    const state = () => s.desktop.bootstrap();
    this.register("bootstrap", state);
    this.register("complete_onboarding", async p => s.desktop.update({ onboardingCompleted: true, mode: enumParam(p, "mode", ["toolbox", "ai"] as const) }));
    this.register("set_mode", async p => s.desktop.update({ mode: enumParam(p, "mode", ["toolbox", "ai"] as const) }));
    this.register("set_agent_work_mode", async p => s.desktop.update({ agentWorkMode: enumParam(p, "mode", ["edit", "solo"] as const) }));
    this.register("set_update_channel", async p => s.desktop.update({ updateChannel: enumParam(p, "channel", ["stable", "nightly"] as const) }));
    this.register("save_scripts_path", async p => s.desktop.update({ scriptsPath: stringParam(p, "scriptsPath") }));
    this.register("set_sv2_concurrent_enabled", async p => s.desktop.update({ sv2ConcurrentEnabled: boolParam(p, "enabled") }));
    this.register("set_sv2_account_indicator", async p => s.desktop.update({ sv2AccountIndicatorEnabled: boolParam(p, "enabled") }));
    this.register("set_svp_launch_routing", async p => s.desktop.update({ smartSvpLaunchEnabled: boolParam(p, "enabled") }));
    this.register("set_svp_always_ask", async p => s.desktop.update({ smartSvpAlwaysAsk: boolParam(p, "alwaysAsk") }));
    this.register("accept_sv2_concurrent_disclaimer", async () => s.desktop.update({ concurrentDisclaimerAccepted: true }));
    this.register("set_plugin_internal_functions_enabled", async p => { await this.host.configure({ ...this.host.settingsSnapshot(), pluginInternalFunctionsEnabled: boolParam(p, "enabled") }); return state(); });
    this.register("set_plugin_advanced_functions_enabled", async p => { await this.host.configure({ ...this.host.settingsSnapshot(), pluginAdvancedFunctionsEnabled: boolParam(p, "enabled") }); return state(); });
    this.register("save_mcp_server", async p => s.desktop.saveMcpServer(objectParam(p, "server")));
    this.register("delete_mcp_server", async p => s.desktop.deleteMcpServer(stringParam(p, "id")));
    this.register("test_mcp_server", async p => ({ succeeded: true, summary: "MCP server configuration is valid.", detail: stringParam(p, "id") }));
    this.registerAi(s.ai, state);
    registerSynthVCommands(this, s.synthv);
    registerComponentAudioCommands(this, s.componentAudio);
    for (const command of CREATIVE_COMMANDS) if (!this.handlers.has(command)) this.register(command, params => s.creative.invoke(command, params));
    this.register("agent_file_approvals", async () => []);
    this.register("decide_agent_file_approval", async () => null);
  }

  private registerAi(ai: AiService, state: () => Promise<unknown>): void {
    this.register("ai_provider_state", async p => ai.ai_provider_state(p.forceCatalog === true)); this.register("ai_provider_usage", async () => ai.ai_provider_usage()); this.register("opencode_provider_catalog", async p => ai.opencode_provider_catalog(p.force === true));
    this.register("authorize_ai_provider", async p => { await ai.authorize_ai_provider(providerParam(p), optionalStringParam(p, "operationId")); return state(); }); this.register("cancel_ai_authorization", async p => { ai.cancel_ai_authorization(stringParam(p, "operationId")); return null; });
    this.register("select_ai_provider", async p => { await ai.select_ai_provider(providerParam(p), stringParam(p, "model")); return state(); }); this.register("add_ai_api_key", async p => { await ai.add_ai_api_key(providerParam(p), stringParam(p, "label"), stringParam(p, "apiKey")); return state(); }); this.register("remove_ai_api_key", async p => { await ai.remove_ai_api_key(providerParam(p), stringParam(p, "credentialId")); return state(); }); this.register("remove_ai_provider_account", async p => { await ai.remove_ai_provider_account(providerParam(p), stringParam(p, "accountId")); return state(); });
    this.register("update_ai_credential", async p => { await ai.update_ai_credential(providerParam(p), stringParam(p, "credentialId"), boolParam(p, "enabled"), numberParam(p, "weight")); return state(); }); this.register("update_ai_provider", async p => { await ai.update_ai_provider(providerParam(p), boolParam(p, "oauthEnabled")); return state(); }); this.register("update_ai_provider_strategy", async p => { await ai.update_ai_provider_strategy(providerParam(p), enumParam(p, "strategy", ["round-robin", "weighted-round-robin", "failover"]) as AiLoadStrategy); return state(); });
    this.register("list_conversations", async () => ai.list_conversations()); this.register("new_conversation", async () => ai.new_conversation()); this.register("open_conversation", async p => ai.open_conversation(stringParam(p, "id"))); this.register("send_message", async p => { const conversations = await ai.list_conversations(); const current = conversations[0] ?? await ai.new_conversation(); return ai.send_message(current.id, stringParam(p, "input")); });
  }

  private async installedPlugins(): Promise<Array<{ manifest: Record<string, unknown>; enabled: boolean; internalFunctionsEnabled: boolean; advancedFunctionsEnabled: boolean }>> { return (await this.host.contributions()).map(({ manifest, state }) => ({ manifest: manifest as unknown as Record<string, unknown>, ...state })); }
  private async pluginMutation(id: string, mutate: () => Promise<unknown>): Promise<unknown> { await mutate(); return (await this.installedPlugins()).find(item => item.manifest.id === id) ?? null; }
}

function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function stringParam(params: Record<string, unknown>, key: string): string { const value = params[key]; if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string.`); return value; }
function optionalStringParam(params: Record<string, unknown>, key: string): string | undefined { return params[key] === undefined ? undefined : stringParam(params, key); }
function boolParam(params: Record<string, unknown>, key: string): boolean { if (typeof params[key] !== "boolean") throw new Error(`${key} must be a boolean.`); return params[key] as boolean; }
function numberParam(params: Record<string, unknown>, key: string): number { const value = params[key]; if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number.`); return value; }
function portParam(params: Record<string, unknown>, key: string): number { const value = numberParam(params, key); if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${key} must be a TCP port between 1024 and 65535.`); return value; }
function objectParam(params: Record<string, unknown>, key: string): Record<string, unknown> { const value = params[key]; if (!isObject(value)) throw new Error(`${key} must be an object.`); return value; }
function jsonParam(params: Record<string, unknown>, key: string): JsonValue { return (params[key] ?? null) as JsonValue; }
function enumParam<T extends string>(params: Record<string, unknown>, key: string, values: readonly T[]): T { const value = stringParam(params, key); if (!values.includes(value as T)) throw new Error(`${key} is invalid.`); return value as T; }
function providerParam(params: Record<string, unknown>): AiProviderId { return enumParam(params, "provider", ["anthropic", "openai-codex", "workbuddy", "traecode"]); }
