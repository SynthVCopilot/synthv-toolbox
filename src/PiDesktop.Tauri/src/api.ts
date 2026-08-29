import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  AppMode,
  BootstrapState,
  ChatMessage,
  ComponentDownload,
  ConversationSnapshot,
  ConversationSummary,
  McpServerConfig,
  OperationResult,
  Sv2ProfilesState,
  SynthVInstallation,
  WorkflowResult,
} from "./types";

const preview = import.meta.env.DEV && !isTauri();
let previewMode: AppMode = "toolbox";
let previewOnboarding = false;
let previewConcurrentDisclaimerAccepted = false;
let previewDownloads: ComponentDownload[] = [];
let previewProfiles: Sv2ProfilesState = {
  supported: true,
  canonicalPath: "C:\\Users\\Demo\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2",
  vaultPath: "C:\\Users\\Demo\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2.toolbox-slots",
  activeSlotId: "11111111-1111-4111-8111-111111111111",
  canonicalRootExists: true,
  canImportCurrent: false,
  recoveryRequired: false,
  recoveryDetail: "",
  blockers: [
    { pid: 45036, name: "Microsoft Edge WebView2", reason: "正在使用当前 SV2 槽位文件" },
    { pid: 20348, name: "synthv-studio.exe", reason: "SV2 standalone 正在运行" },
  ],
  concurrentProvider: {
    available: true,
    name: "Sandboxie Classic",
    edition: "Classic",
    version: "5.73.2",
    installPath: "C:\\Program Files\\Sandboxie",
    detail: "隔离核心已就绪，可以为不同账号槽位运行相互独立的 SV2 实例。",
  },
  slots: [{
    id: "11111111-1111-4111-8111-111111111111",
    displayName: "主账号",
    username: "Producer",
    email: "producer@example.com",
    color: "#6D5CE7",
    createdAtUtc: new Date().toISOString(),
    lastActivatedAtUtc: new Date().toISOString(),
    isActive: true,
    sessionCached: true,
    dataPath: "C:\\Users\\Demo\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2",
    concurrent: {
      ready: true,
      boxName: "SV2TB111111111111411181111111",
      dataPath: "C:\\Users\\Demo\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2.toolbox-slots\\concurrent\\11111111-1111-4111-8111-111111111111\\box\\user\\current\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2",
      runningPids: [],
      detail: "隔离副本已准备；本地变化不会自动覆盖普通槽位。",
    },
  }, {
    id: "22222222-2222-4222-8222-222222222222",
    displayName: "备用账号",
    username: "Vocal Editor",
    email: "editor@example.com",
    color: "#3478C9",
    createdAtUtc: new Date().toISOString(),
    isActive: false,
    sessionCached: true,
    dataPath: "C:\\Users\\Demo\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2.toolbox-slots\\slots\\22222222-2222-4222-8222-222222222222",
    concurrent: {
      ready: false,
      boxName: "SV2TB222222222222422282222222",
      dataPath: "C:\\Users\\Demo\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2.toolbox-slots\\concurrent\\22222222-2222-4222-8222-222222222222\\box\\user\\current\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2",
      runningPids: [],
      detail: "尚未准备隔离副本。",
    },
  }],
};

const previewState = (): BootstrapState => ({
  onboardingCompleted: previewOnboarding,
  mode: previewMode,
  platform: "preview",
  appVersion: "0.1.0",
  configPath: "~/.SynthVcopilot/config.json",
  model: previewMode === "ai" ? { baseUrl: "https://api.anthropic.com", model: "", tokenConfigured: false } : undefined,
  scriptsPath: "/Library/Application Support/Dreamtonics/Synthesizer V Studio 2/scripts",
  bridgeBundled: true,
  bridgeConnected: false,
  installations: [{
    displayName: "Synthesizer V Studio 2",
    scriptsPath: "/Library/Application Support/Dreamtonics/Synthesizer V Studio 2/scripts",
    source: "macOS 用户脚本目录",
  }],
  components: [
    { id: "ffmpeg", displayName: "FFmpeg", description: "音视频转码与抽取；所有音频流程的基础。", audience: "AI 与人工", installed: true, installable: true, status: "已就绪" },
    { id: "pi-audio", displayName: "pi-audio 音频探针", description: "特征指纹、BPM、乐器与风格倾向。", audience: "AI 与人工", installed: false, installable: true, status: "可通过 aria2 下载" },
    { id: "cvrs", displayName: "CVRS", description: "跨版本工程探测与安全参考轨。", audience: "AI 与人工", installed: true, installable: true, status: "已就绪" },
  ],
  downloads: previewDownloads,
  mcpServers: previewMode === "ai" ? [{ id: "demo", name: "Demo tools", command: "node", args: ["server.mjs"], enabled: true }] : [],
  concurrentDisclaimerAccepted: previewConcurrentDisclaimerAccepted,
});

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!preview) return invoke<T>(command, args);
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (command === "complete_onboarding" || command === "set_mode") {
    previewMode = args?.mode as AppMode;
    previewOnboarding = true;
  }
  if (command === "bootstrap" || command === "complete_onboarding" || command === "set_mode" || command.endsWith("settings") || command.endsWith("server") || command === "save_scripts_path" || command === "delete_mcp_server") {
    return previewState() as T;
  }
  if (command === "scan_synthv") return previewState().installations as T;
  if (command === "sv2_profile_state") return previewProfiles as T;
  if (command === "import_current_sv2_profile" || command === "create_sv2_profile") {
    const id = crypto.randomUUID();
    previewProfiles.slots.push({
      id,
      displayName: String(args?.displayName ?? "新账号"),
      username: "",
      email: "",
      color: "#3478C9",
      createdAtUtc: new Date().toISOString(),
      isActive: false,
      sessionCached: false,
      dataPath: `${previewProfiles.vaultPath}\\slots\\${id}`,
      concurrent: {
        ready: false,
        boxName: `SV2TB${id.replaceAll("-", "").slice(0, 24)}`,
        dataPath: `${previewProfiles.vaultPath}\\concurrent\\${id}\\box\\user\\current\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2`,
        runningPids: [],
        detail: "尚未准备隔离副本。",
      },
    });
    previewProfiles.canImportCurrent = false;
    return previewProfiles as T;
  }
  if (command === "rename_sv2_profile") {
    const slot = previewProfiles.slots.find((item) => item.id === args?.slotId);
    if (slot) slot.displayName = String(args?.displayName ?? slot.displayName);
    return previewProfiles as T;
  }
  if (command === "update_sv2_profile_identity") {
    const slot = previewProfiles.slots.find((item) => item.id === args?.slotId);
    if (slot) {
      slot.username = String(args?.username ?? "");
      slot.email = String(args?.email ?? "");
    }
    return previewProfiles as T;
  }
  if (command === "activate_sv2_profile") {
    previewProfiles.activeSlotId = String(args?.slotId ?? "");
    previewProfiles.slots.forEach((slot) => { slot.isActive = slot.id === previewProfiles.activeSlotId; });
    return previewProfiles as T;
  }
  if (command === "launch_sv2_profile" || command === "force_launch_sv2_profile") {
    previewProfiles.activeSlotId = String(args?.slotId ?? "");
    previewProfiles.slots.forEach((slot) => { slot.isActive = slot.id === previewProfiles.activeSlotId; });
    if (command === "force_launch_sv2_profile") previewProfiles.blockers = [];
    return {
      succeeded: true,
      summary: command === "force_launch_sv2_profile" ? "已结束占用进程、切换槽位并启动 SV2。" : "已切换槽位并启动 SV2。",
      detail: "预览模式",
    } as T;
  }
  if (command === "prepare_sv2_concurrent_profile") {
    const slot = previewProfiles.slots.find((item) => item.id === args?.slotId);
    if (slot) {
      slot.concurrent.ready = true;
      slot.concurrent.detail = "隔离副本已准备；本地变化不会自动覆盖普通槽位。";
    }
    return previewProfiles as T;
  }
  if (command === "accept_sv2_concurrent_disclaimer") {
    previewConcurrentDisclaimerAccepted = true;
    return previewState() as T;
  }
  if (command === "queue_component_install") {
    const componentId = String(args?.id ?? "");
    if (!previewDownloads.some((item) => item.componentId === componentId)) {
      previewDownloads.push({
        id: crypto.randomUUID(),
        componentId,
        displayName: componentId,
        status: "downloading",
        progress: 38,
        detail: "aria2 正在下载固定版本组件。",
        updatedAt: new Date().toISOString(),
      });
    }
    return previewDownloads as T;
  }
  if (command === "component_downloads") return previewDownloads as T;
  if (command === "list_conversations") return [] as T;
  if (command === "new_conversation") return { id: "preview", title: "新对话", messages: [] } as T;
  if (command === "open_conversation") return { id: "preview", title: "预览对话", messages: [] } as T;
  if (command === "send_message") return [{ role: "assistant", content: "这是本地视觉预览回复。" }] as T;
  if (command.startsWith("run_") || command === "add_project_reference") return {
    kind: command.replace(/^run_/, "").replaceAll("_", "-"),
    summary: "预览工作流已完成。",
    outputPath: command === "run_game_to_midi" ? "~/.SynthVcopilot/output/game-vocal.mid" : undefined,
    data: { preview: true, command, parameters: args ?? {} },
  } as T;
  if (command === "review_workflow") return "结论：结果结构完整。\n风险：预览模式未执行真实组件。\n建议参数：发布构建中按实际素材复核。" as T;
  return { succeeded: true, summary: "预览操作已完成。", detail: "" } as T;
}

export const api = {
  bootstrap: () => call<BootstrapState>("bootstrap"),
  completeOnboarding: (mode: AppMode) => call<BootstrapState>("complete_onboarding", { mode }),
  setMode: (mode: AppMode) => call<BootstrapState>("set_mode", { mode }),
  saveModel: (baseUrl: string, model: string, token?: string) =>
    call<BootstrapState>("save_model_settings", { baseUrl, model, token: token || null }),
  scanSynthV: () => call<SynthVInstallation[]>("scan_synthv"),
  sv2ProfileState: () => call<Sv2ProfilesState>("sv2_profile_state"),
  importCurrentSv2Profile: (displayName: string) =>
    call<Sv2ProfilesState>("import_current_sv2_profile", { displayName }),
  createSv2Profile: (displayName: string) =>
    call<Sv2ProfilesState>("create_sv2_profile", { displayName }),
  renameSv2Profile: (slotId: string, displayName: string) =>
    call<Sv2ProfilesState>("rename_sv2_profile", { slotId, displayName }),
  updateSv2ProfileIdentity: (slotId: string, username: string, email: string) =>
    call<Sv2ProfilesState>("update_sv2_profile_identity", { slotId, username, email }),
  activateSv2Profile: (slotId: string) =>
    call<Sv2ProfilesState>("activate_sv2_profile", { slotId }),
  launchSv2Profile: (slotId: string, projectPath?: string) =>
    call<OperationResult>("launch_sv2_profile", { slotId, projectPath: projectPath || null }),
  forceLaunchSv2Profile: (slotId: string, projectPath?: string) =>
    call<OperationResult>("force_launch_sv2_profile", { slotId, projectPath: projectPath || null }),
  openSv2ProfileFolder: (slotId: string) =>
    call<OperationResult>("open_sv2_profile_folder", { slotId }),
  prepareSv2ConcurrentProfile: (slotId: string) =>
    call<Sv2ProfilesState>("prepare_sv2_concurrent_profile", { slotId }),
  launchSv2ConcurrentProfile: (slotId: string, projectPath?: string) =>
    call<OperationResult>("launch_sv2_concurrent_profile", { slotId, projectPath: projectPath || null }),
  acceptSv2ConcurrentDisclaimer: () =>
    call<BootstrapState>("accept_sv2_concurrent_disclaimer"),
  openSv2ConcurrentFolder: (slotId: string) =>
    call<OperationResult>("open_sv2_concurrent_folder", { slotId }),
  saveScriptsPath: (scriptsPath: string) => call<BootstrapState>("save_scripts_path", { scriptsPath }),
  installBridge: (scriptsPath: string) => call<OperationResult>("install_bridge", { scriptsPath }),
  diagnoseBridge: (scriptsPath: string) => call<OperationResult>("diagnose_bridge", { scriptsPath }),
  connectBridge: () => call<OperationResult>("connect_bridge"),
  componentDownloads: () => call<ComponentDownload[]>("component_downloads"),
  queueComponentInstall: (id: string) => call<ComponentDownload[]>("queue_component_install", { id }),
  runAudioProbe: (audioPath: string, advanced: boolean) =>
    call<WorkflowResult>("run_audio_probe", { audioPath, advanced }),
  runGameToMidi: (vocalPath: string, instrumentalPath: string, outputName: string, tolerance: number, advanced: boolean) =>
    call<WorkflowResult>("run_game_to_midi", { vocalPath, instrumentalPath, outputName, tolerance, advanced }),
  runProjectProbe: (projectPath: string) =>
    call<WorkflowResult>("run_project_probe", { projectPath }),
  addProjectReference: (projectPath: string, audioPath: string, trackName: string, beginSeconds: number, outputName: string) =>
    call<WorkflowResult>("add_project_reference", { projectPath, audioPath, trackName, beginSeconds, outputName }),
  reviewWorkflow: (kind: string, data: Record<string, unknown>) =>
    call<string>("review_workflow", { kind, data }),
  listConversations: () => call<ConversationSummary[]>("list_conversations"),
  newConversation: () => call<ConversationSnapshot>("new_conversation"),
  openConversation: (id: string) => call<ConversationSnapshot>("open_conversation", { id }),
  sendMessage: (input: string) => call<ChatMessage[]>("send_message", { input }),
  saveMcpServer: (server: McpServerConfig) => call<BootstrapState>("save_mcp_server", { server }),
  deleteMcpServer: (id: string) => call<BootstrapState>("delete_mcp_server", { id }),
  testMcpServer: (id: string) => call<OperationResult>("test_mcp_server", { id }),
};
