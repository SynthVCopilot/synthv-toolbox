import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  AiProviderId,
  AgentWorkMode,
  AiProviderSummary,
  AppMode,
  AudioCaptureCapability,
  AudioCaptureTarget,
  BatchWorkflowResult,
  BootstrapState,
  ChatMessage,
  ChineseRhymeLookup,
  ComponentDownload,
  CoverTaskRequest,
  CreativeHistoryEntry,
  ConversationSnapshot,
  ConversationSummary,
  McpServerConfig,
  ModelSummary,
  OpenCodeCatalog,
  LyricCandidateRequest,
  LyricCandidateSet,
  LyricProject,
  LyricProjectSummary,
  LyricSectionRequest,
  MediaSourcePreview,
  MediaTaskSnapshot,
  OperationResult,
  ProjectCheckpoint,
  Sv2AccountProbe,
  Sv2AccountPrecheck,
  Sv2AccountUsageSnapshot,
  Sv2IsolationPreference,
  Sv2ProfilesState,
  Sv2SyncCategory,
  Sv2SyncCategoryId,
  Sv2SyncManifest,
  Sv2SyncResult,
  SvpLaunchMode,
  SvpRoutePlan,
  SynthVInstallation,
  SynthVProcess,
  SynthVShortcutProfile,
  TuningParameters,
  TuningProfile,
  ToolboxUpdateCheck,
  WorkflowRecipe,
  WorkflowResult,
  RhymeMatchMode,
} from "./types";

const preview = import.meta.env.DEV && !isTauri();
let previewMode: AppMode = "toolbox";
let previewAgentWorkMode: AgentWorkMode = "edit";
let previewOnboarding = false;
let previewConcurrentDisclaimerAccepted = false;
let previewSv2ConcurrentEnabled = true;
let previewSv2AccountIndicatorEnabled = false;
let previewSmartSvpLaunchEnabled = false;
let previewBridgeConnected = true;
let previewDownloads: ComponentDownload[] = [];
let previewMediaTasks: MediaTaskSnapshot[] = [];
let previewLyricProjects: LyricProject[] = [];
const previewManagedComponentIds = new Set(["pi-audio", "cvrs", "media-fetcher", "vocal-separation"]);
const previewInstalledManagedComponentIds = new Set(["cvrs"]);
let previewActiveAiProvider: AiProviderId = "anthropic";
let previewAiAccountSequence = 2;
let previewAiProviders: AiProviderSummary[] = [{
  id: "anthropic",
  displayName: "Claude 官方订阅",
  description: "通过浏览器授权 Claude 账号，并使用官方订阅提供的模型。",
  active: true,
  connected: true,
  healthyAccounts: 1,
  totalAccounts: 1,
  model: "claude-sonnet-4-6",
  models: [
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "claude-opus-4-8",
    "claude-opus-5",
  ],
  accounts: [{
    id: "preview-anthropic-1",
    label: "Claude official account",
    expiresAt: Date.now() + 55 * 60_000,
    authorized: true,
    healthy: true,
  }],
}, {
  id: "openai-codex",
  displayName: "Codex 官方订阅",
  description: "通过浏览器授权 ChatGPT 账号，并使用账号可用的 Codex 模型。",
  active: false,
  connected: false,
  healthyAccounts: 0,
  totalAccounts: 0,
  model: "gpt-5.6-terra",
  models: [
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
  ],
  accounts: [],
}];

function previewAiModel() {
  return {
    activeProvider: previewActiveAiProvider,
    legacyConfigured: false,
    providers: previewAiProviders.map((provider) => ({
      ...provider,
      accounts: provider.accounts.map((account) => ({ ...account })),
      models: [...provider.models],
    })),
  };
}

function previewAiProvider(providerId: unknown): AiProviderSummary | undefined {
  return previewAiProviders.find((provider) => provider.id === providerId);
}

function refreshPreviewAiProvider(provider: AiProviderSummary): void {
  provider.totalAccounts = provider.accounts.length;
  provider.healthyAccounts = provider.accounts.filter((account) => account.healthy).length;
  provider.connected = provider.accounts.some((account) => account.authorized);
}

function previewAccountProbe(overrides: Partial<Sv2AccountProbe> = {}): Sv2AccountProbe {
  return {
    sessionStatus: "missing",
    remoteUse: "unknown",
    authorizationStatus: "unknown",
    authorizedVoiceCount: 0,
    authorizedVoices: [],
    checkedAtUtc: new Date().toISOString(),
    detail: "当前没有可用于账号预检的登录缓存。",
    ...overrides,
  };
}

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
  concurrentDefaults: {
    appSettings: false,
    voiceLibraries: false,
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
    sessionProtection: {
      status: "monitoring",
      snapshotAvailable: true,
      detail: "本次启动的登录态已建立保护快照；SV2 退出后会自动检查是否被远端占用流程清除。",
    },
    concurrentSessionProtection: {
      status: "ready",
      snapshotAvailable: false,
      detail: "登录缓存存在；工具箱启动 SV2 时会先建立不透明保护快照。",
    },
    accountProbe: previewAccountProbe({
      sessionStatus: "inUse",
      detail: "登录缓存正在被本机 SV2 使用；账号服务占用状态仍未知。",
    }),
    concurrentAccountProbe: previewAccountProbe({
      sessionStatus: "ready",
      detail: "隔离副本中的缓存会话可读取；尚未取得账号服务占用或授权摘要。",
    }),
    voiceInventory: {
      status: "manual",
      manuallyConfirmedVoices: ["Mai 2", "SOLARIA"],
      verifiedAuthorizedVoiceCount: 0,
      detail: "已手工确认 2 个声库；这些记录只用于工程路由，不替代 Dreamtonics 官方授权预检。",
    },
    concurrent: {
      ready: true,
      boxName: "SV2TB111111111111411181111111",
      dataPath: "C:\\Users\\Demo\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2.toolbox-slots\\concurrent\\11111111-1111-4111-8111-111111111111\\box\\user\\current\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2",
      runningPids: [],
      detail: "隔离副本已准备；本地变化不会自动覆盖普通槽位。",
      content: {
        appSettings: "global",
        voiceLibraries: "off",
        effectiveAppSettings: true,
        effectiveVoiceLibraries: false,
      },
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
    sessionProtection: {
      status: "ready",
      snapshotAvailable: false,
      detail: "登录缓存存在；工具箱启动 SV2 时会先建立不透明保护快照。",
    },
    concurrentSessionProtection: {
      status: "ready",
      snapshotAvailable: false,
      detail: "登录缓存存在；工具箱启动 SV2 时会先建立不透明保护快照。",
    },
    accountProbe: previewAccountProbe({
      sessionStatus: "ready",
      remoteUse: "clear",
      authorizationStatus: "verified",
      authorizedVoiceCount: 2,
      authorizedVoices: ["Mai 2", "SOLARIA"],
      accountDisplayName: "Vocal Editor",
      accountEmail: "editor@example.com",
      detail: "官方服务已接受无踢出设备登录事件，并返回 2 个可匹配的官方声库授权。",
    }),
    concurrentAccountProbe: previewAccountProbe({
      sessionStatus: "ready",
      remoteUse: "clear",
      authorizationStatus: "verified",
      authorizedVoiceCount: 2,
      authorizedVoices: ["Mai 2", "SOLARIA"],
      detail: "官方服务已接受隔离副本的无踢出设备登录事件，并返回 2 个可匹配的官方声库授权。",
    }),
    voiceInventory: {
      status: "verified",
      manuallyConfirmedVoices: [],
      verifiedAuthorizedVoiceCount: 2,
      detail: "账号服务已返回 2 个官方声库授权。",
    },
    concurrent: {
      ready: true,
      boxName: "SV2TB222222222222422282222222",
      dataPath: "C:\\Users\\Demo\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2.toolbox-slots\\concurrent\\22222222-2222-4222-8222-222222222222\\box\\user\\current\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2",
      runningPids: [],
      detail: "隔离副本已准备；本地变化不会自动覆盖普通槽位。",
      content: {
        appSettings: "on",
        voiceLibraries: "global",
        effectiveAppSettings: true,
        effectiveVoiceLibraries: false,
      },
    },
  }],
};

const previewState = (): BootstrapState => ({
  onboardingCompleted: previewOnboarding,
  mode: previewMode,
  agentWorkMode: previewAgentWorkMode,
  platform: "preview",
  appVersion: "0.1.1",
  configPath: "~/.SynthVcopilot/config.json",
  settingsLoadError: undefined,
  model: previewMode === "ai" ? previewAiModel() : undefined,
  scriptsPath: "/Library/Application Support/Dreamtonics/Synthesizer V Studio 2/scripts",
  bridgeBundled: true,
  bridgeConnected: previewBridgeConnected,
  installations: [{
    displayName: "Synthesizer V Studio 2",
    scriptsPath: "/Library/Application Support/Dreamtonics/Synthesizer V Studio 2/scripts",
    source: "macOS 用户脚本目录",
  }],
  components: [
    { id: "ffmpeg", displayName: "FFmpeg", description: "音视频转码与抽取；所有音频流程的基础。", audience: "AI 与人工", installed: true, downloaded: false, installable: true, removable: false, status: "已就绪" },
    { id: "pi-audio", displayName: "pi-audio 音频探针", description: "特征指纹、BPM、乐器与风格倾向。", audience: "AI 与人工", installed: previewInstalledManagedComponentIds.has("pi-audio"), downloaded: false, installable: true, removable: previewInstalledManagedComponentIds.has("pi-audio"), status: previewInstalledManagedComponentIds.has("pi-audio") ? "已就绪" : "可通过 aria2 下载" },
    { id: "cvrs", displayName: "CVRS 工程工具", description: "工程探测、安全副本、无参导出与 LRC。", audience: "AI 与人工", installed: previewInstalledManagedComponentIds.has("cvrs"), downloaded: false, installable: true, removable: previewInstalledManagedComponentIds.has("cvrs"), status: previewInstalledManagedComponentIds.has("cvrs") ? "已就绪" : "可通过 aria2 下载" },
    { id: "media-fetcher", displayName: "媒体导入器", description: "固定版本 yt-dlp，用于显式 Bilibili/YouTube URL 导入。", audience: "AI 与人工", installed: previewInstalledManagedComponentIds.has("media-fetcher"), downloaded: false, installable: true, removable: previewInstalledManagedComponentIds.has("media-fetcher"), status: previewInstalledManagedComponentIds.has("media-fetcher") ? "已就绪" : "可通过 aria2 下载" },
    { id: "vocal-separation", displayName: "人声伴奏分离", description: "使用 Demucs htdemucs 把单个混音分成 vocals 与 inst。", audience: "AI 与人工", installed: previewInstalledManagedComponentIds.has("vocal-separation"), downloaded: false, installable: true, removable: previewInstalledManagedComponentIds.has("vocal-separation"), status: previewInstalledManagedComponentIds.has("vocal-separation") ? "已就绪" : "可安装本地运行环境" },
    { id: "sandboxie", displayName: "Sandboxie Plus 1.18.2", description: "SynthV Toolbox 并发隔离提供方；下载官方安装包后由用户交互安装。", audience: "Windows 并发隔离", installed: false, downloaded: false, installable: true, removable: false, status: "可通过 aria2 下载官方 x64 安装包" },
  ],
  downloads: previewDownloads,
  mcpServers: previewMode === "ai" ? [{ id: "demo", name: "Demo tools", command: "node", args: ["server.mjs"], enabled: true }] : [],
  concurrentDisclaimerAccepted: previewConcurrentDisclaimerAccepted,
  sv2ConcurrentEnabled: previewSv2ConcurrentEnabled,
  sv2AccountIndicatorEnabled: previewSv2AccountIndicatorEnabled,
  smartSvpLaunchEnabled: previewSmartSvpLaunchEnabled,
  svpAssociation: {
    supported: true,
    registered: previewSmartSvpLaunchEnabled,
    isDefault: false,
    detail: previewSmartSvpLaunchEnabled
      ? "已注册为 .svp 可选打开方式；请在 Windows 默认应用中选择 SynthV Toolbox。"
      : "智能启动默认关闭，不会改变当前 .svp 打开方式。",
  },
});

function previewAccountPrecheck(): Sv2AccountPrecheck {
  const slot = previewProfiles.slots.find((item) => item.isActive);
  const recoveryPending = slot?.sessionProtection.status === "recoveryPending"
    || slot?.concurrentSessionProtection.status === "recoveryPending";
  const probe = slot?.accountProbe ?? previewAccountProbe();
  const localUse = previewProfiles.blockers.length > 0 || Boolean(slot?.concurrent.runningPids.length);
  return {
    supported: true,
    checkedAtUtc: new Date().toISOString(),
    slotId: slot?.id,
    displayName: slot?.displayName ?? "",
    localUse,
    localProcesses: previewProfiles.blockers,
    concurrentPids: slot?.concurrent.runningPids ?? [],
    remoteUse: probe.remoteUse,
    sessionStatus: probe.sessionStatus,
    authorizationStatus: probe.authorizationStatus,
    authorizedVoiceCount: probe.authorizedVoiceCount,
    sessionCached: Boolean(slot?.sessionCached),
    recoveryPending,
    summary: localUse
      ? "当前账号正在本机使用。"
      : probe.remoteUse === "clear" && probe.sessionStatus === "ready"
        ? "官方服务已接受无踢出设备登录事件。"
        : probe.remoteUse === "detected"
          ? "账号服务报告当前账号正在使用。"
          : "当前账号的服务端占用状态未知。",
    detail: probe.detail,
  };
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!preview) return invoke<T>(command, args);
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (command === "complete_onboarding" || command === "set_mode") {
    previewMode = args?.mode as AppMode;
    previewOnboarding = true;
  }
  if (command === "set_svp_launch_routing") {
    previewSmartSvpLaunchEnabled = Boolean(args?.enabled);
    return previewState() as T;
  }
  if (command === "set_sv2_account_indicator") {
    const enabled = Boolean(args?.enabled);
    if (enabled && !previewSv2AccountIndicatorEnabled && !Boolean(args?.acknowledged)) {
      throw new Error("开启账号登录指示器前必须在风险说明弹窗中明确确认。");
    }
    previewSv2AccountIndicatorEnabled = enabled;
    return previewState() as T;
  }
  if (command === "open_svp_default_apps_settings") {
    return { succeeded: true, summary: "已打开 Windows 默认应用设置。", detail: "请为 .svp 选择 SynthV Toolbox。" } as T;
  }
  if (command === "authorize_ai_provider") {
    const provider = previewAiProvider(args?.provider);
    if (!provider) throw new Error("未知的 AI 提供商。");
    const accountNumber = previewAiAccountSequence++;
    provider.accounts.push({
      id: `preview-${provider.id}-${accountNumber}`,
      label: `${provider.id === "anthropic" ? "Claude" : "ChatGPT"} official account ${accountNumber}`,
      expiresAt: Date.now() + 55 * 60_000,
      authorized: true,
      healthy: true,
    });
    if (provider.id === "openai-codex" && !provider.models.includes("gpt-5.3-codex-spark")) {
      provider.models.push("gpt-5.3-codex-spark");
    }
    refreshPreviewAiProvider(provider);
    previewActiveAiProvider = provider.id;
    previewAiProviders = previewAiProviders.map((item) => ({
      ...item,
      active: item.id === provider.id,
    }));
    return previewState() as T;
  }
  if (command === "select_ai_provider") {
    const provider = previewAiProvider(args?.provider);
    const model = String(args?.model ?? "").trim();
    if (!provider) throw new Error("未知的 AI 提供商。");
    if (!provider.connected) throw new Error("请先通过浏览器授权此提供商。");
    if (!model || !provider.models.includes(model)) throw new Error("请选择此账号可用的模型。");
    previewActiveAiProvider = provider.id;
    previewAiProviders = previewAiProviders.map((item) => ({
      ...item,
      active: item.id === provider.id,
      model: item.id === provider.id ? model : item.model,
    }));
    return previewState() as T;
  }
  if (command === "remove_ai_provider_account") {
    const provider = previewAiProvider(args?.provider);
    const accountId = String(args?.accountId ?? "");
    if (!provider) throw new Error("未知的 AI 提供商。");
    provider.accounts = provider.accounts.filter((account) => account.id !== accountId);
    refreshPreviewAiProvider(provider);
    return previewState() as T;
  }
  if (command === "ai_provider_state") return previewAiModel() as T;
  if (command === "opencode_provider_catalog") return {
    generatedAt: Date.now(),
    providers: [
      { id: "anthropic", name: "Anthropic", modelCount: 12, package: "@ai-sdk/anthropic" },
      { id: "openai", name: "OpenAI", modelCount: 18, package: "@ai-sdk/openai" },
      { id: "google", name: "Google", modelCount: 15, package: "@ai-sdk/google" },
    ],
  } as T;
  if (command === "bootstrap" || command === "complete_onboarding" || command === "set_mode" || command.endsWith("settings") || command.endsWith("server") || command === "save_scripts_path" || command === "delete_mcp_server") {
    return previewState() as T;
  }
  if (command === "set_agent_work_mode") {
    previewAgentWorkMode = args?.mode === "solo" ? "solo" : "edit";
    return previewState() as T;
  }
  if (command === "scan_synthv") return previewState().installations as T;
  if (command === "connect_bridge") {
    previewBridgeConnected = true;
    return { succeeded: true, summary: "SynthV Bridge 已连接。", detail: "预览模式" } as T;
  }
  if (command === "list_synthv_processes") return [{ processId: 4201, name: "Synthesizer V Studio 2 Pro", command: "/Applications/Synthesizer V Studio 2 Pro.app/Contents/MacOS/synthv-studio" }] as T;
  if (command === "preview_media_source") return { sourceUrl: String(args?.source ?? ""), canonicalUrl: String(args?.source ?? ""), platform: "BiliBili", mediaId: "BV1Preview", title: "预览媒体", uploader: "预览作者", durationSeconds: 183.2, thumbnailUrl: null } as T;
  if (command === "synthv_shortcut_profile") return { bridgeStart: "F13", bridgeStop: "F14", projectSave: "⌘S", detail: "F13 触发 Bridge 启动或重连，F14 触发停止；Cover 保存使用标准快捷键。" } as T;
  if (command === "send_synthv_bridge_shortcut") return { succeeded: true, summary: `已向预览 SynthV 进程发送 ${String(args?.action === "stop" ? "F14" : "F13")}。`, detail: "预览模式" } as T;
  if (command === "auto_connect_synthv_bridge") {
    previewBridgeConnected = true;
    return { succeeded: true, summary: "已连接预览 SynthV Bridge。", detail: "F13 已触发。" } as T;
  }
  if (command === "audio_capture_capability") return {
    supported: true,
    backend: "wasapi-process-loopback",
    detail: "预览模式：仅捕获所选 SynthV 进程树。",
    maxClipSeconds: 30,
  } as T;
  if (command === "list_synthv_capture_targets") return [
    { processId: 20348, name: "Synthesizer V Studio 2 Pro.exe" },
  ] as T;
  if (command === "capture_synthv_clip") return {
    kind: "synthv-clip-capture",
    summary: "试听片段已捕获：5.00 秒，边界估计误差不超过约 24 ms。",
    outputPath: `~/.SynthVcopilot/output/ab-captures/preview-${String(args?.label ?? "clip")}.wav`,
    data: {
      outputPath: `~/.SynthVcopilot/output/ab-captures/preview-${String(args?.label ?? "clip")}.wav`,
      processId: Number(args?.processId ?? 20348), processName: "Synthesizer V Studio 2 Pro.exe",
      requestedStartSeconds: Number(args?.startSeconds ?? 10), requestedEndSeconds: Number(args?.endSeconds ?? 15),
      sampleRate: 48000, channels: 1, bitsPerSample: 16, frames: 240000, discontinuities: 0,
      boundaryUncertaintyMs: 24, sha256: "preview",
      metrics: { durationSeconds: 5, peakDbfs: -1.8, rmsDbfs: -15.2, clippedSampleRatio: 0, silentSampleRatio: 0.01, highFrequencyProxyDb: -24.3 },
    },
  } as T;
  if (command === "compare_synthv_clips") return {
    kind: "synthv-ab-compare",
    summary: "A/B 比较完成：细微变化，相似度 98.7%，自动对齐偏移 +18.0 ms。",
    data: {
      sampleRate: 48000, alignedLagMs: 18, overlapSeconds: 4.98, correlation: 0.984,
      deltaRmsDb: -25.4, loudnessDeltaDb: 0.7, peakDeltaDb: -0.2,
      clippingDeltaPercent: 0, highFrequencyDeltaDb: 0.8, similarityPercent: 98.7,
      classification: "subtle-change",
      baseline: { durationSeconds: 5, peakDbfs: -1.6, rmsDbfs: -15.8, clippedSampleRatio: 0, silentSampleRatio: 0.01, highFrequencyProxyDb: -25.1 },
      candidate: { durationSeconds: 5, peakDbfs: -1.8, rmsDbfs: -15.1, clippedSampleRatio: 0, silentSampleRatio: 0.01, highFrequencyProxyDb: -24.3 },
    },
  } as T;
  if (command === "check_toolbox_update") return {
    currentVersion: previewState().appVersion,
    latestVersion: "0.2.0",
    updateAvailable: true,
    releaseName: "SynthV Toolbox v0.2.0",
    releaseUrl: "https://github.com/SynthVCopilot/synthv-toolbox/releases/tag/v0.2.0",
    publishedAtUtc: new Date().toISOString(),
    releaseNotes: "## 更新内容\n\n- 新增更新检查工具\n- 修复若干问题",
    checkedAtUtc: new Date().toISOString(),
  } as T;
  if (command === "open_toolbox_releases") return {
    succeeded: true,
    summary: "已打开 SynthV Toolbox 官方发布页。",
    detail: "预览模式不会启动外部浏览器。",
  } as T;
  if (command === "sv2_profile_state") return previewProfiles as T;
  if (command === "sv2_account_usage_snapshot" || command === "sv2_account_usage_snapshot_for_slot") {
    if (!previewSv2AccountIndicatorEnabled) {
      throw new Error("账号登录指示器尚未开启；确认其敏感操作说明后才能执行登录预检。");
    }
    return { profiles: previewProfiles, precheck: previewAccountPrecheck() } as Sv2AccountUsageSnapshot as T;
  }
  if (command === "sv2_account_precheck") {
    return previewAccountPrecheck() as T;
  }
  if (command === "set_sv2_concurrent_enabled") {
    previewSv2ConcurrentEnabled = Boolean(args?.enabled);
    return previewState() as T;
  }
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
      sessionProtection: {
        status: "signInRequired",
        snapshotAvailable: false,
        detail: "当前没有登录缓存；首次登录完成后，后续工具箱启动会自动保护该会话。",
      },
      concurrentSessionProtection: {
        status: "signInRequired",
        snapshotAvailable: false,
        detail: "当前没有登录缓存；首次登录完成后，后续工具箱启动会自动保护该会话。",
      },
      accountProbe: previewAccountProbe(),
      concurrentAccountProbe: previewAccountProbe(),
      voiceInventory: {
        status: "unknown",
        manuallyConfirmedVoices: [],
        verifiedAuthorizedVoiceCount: 0,
        detail: "尚无官方账号授权结果或用户手工确认记录。",
      },
      concurrent: {
        ready: false,
        boxName: `SV2TB${id.replaceAll("-", "").slice(0, 24)}`,
        dataPath: `${previewProfiles.vaultPath}\\concurrent\\${id}\\box\\user\\current\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2`,
        runningPids: [],
        detail: "尚未准备隔离副本。",
        content: {
          appSettings: "global",
          voiceLibraries: "global",
          effectiveAppSettings: previewProfiles.concurrentDefaults.appSettings,
          effectiveVoiceLibraries: previewProfiles.concurrentDefaults.voiceLibraries,
        },
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
  if (command === "delete_sv2_profile") {
    const slotId = String(args?.slotId ?? "");
    const wasActive = previewProfiles.activeSlotId === slotId;
    previewProfiles.slots = previewProfiles.slots.filter((slot) => slot.id !== slotId);
    if (wasActive) {
      previewProfiles.activeSlotId = previewProfiles.slots[0]?.id;
      previewProfiles.slots.forEach((slot) => { slot.isActive = slot.id === previewProfiles.activeSlotId; });
    }
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
  if (command === "update_sv2_profile_voice_licenses") {
    const slot = previewProfiles.slots.find((item) => item.id === args?.slotId);
    if (slot) {
      const voices = ((args?.voices as string[] | undefined) ?? []).map((voice) => voice.trim()).filter(Boolean);
      slot.voiceInventory.manuallyConfirmedVoices = [...new Set(voices)];
      slot.voiceInventory.status = slot.voiceInventory.verifiedAuthorizedVoiceCount
        ? "verified"
        : voices.length ? "manual" : "unknown";
      slot.voiceInventory.detail = slot.voiceInventory.verifiedAuthorizedVoiceCount
        ? `账号服务已返回 ${slot.voiceInventory.verifiedAuthorizedVoiceCount} 个官方声库授权；另有 ${voices.length} 个手工确认条目。`
        : voices.length
          ? `已手工确认 ${voices.length} 个声库；这些记录只用于工程路由，不替代 Dreamtonics 官方授权预检。`
          : "尚无官方账号授权结果或用户手工确认记录。";
    }
    return previewProfiles as T;
  }
  if (command === "update_sv2_concurrent_defaults") {
    previewProfiles.concurrentDefaults = {
      appSettings: Boolean(args?.appSettings),
      voiceLibraries: Boolean(args?.voiceLibraries),
    };
    previewProfiles.slots.forEach((slot) => {
      slot.concurrent.content.effectiveAppSettings = slot.concurrent.content.appSettings === "global"
        ? previewProfiles.concurrentDefaults.appSettings
        : slot.concurrent.content.appSettings === "on";
      slot.concurrent.content.effectiveVoiceLibraries = slot.concurrent.content.voiceLibraries === "global"
        ? previewProfiles.concurrentDefaults.voiceLibraries
        : slot.concurrent.content.voiceLibraries === "on";
    });
    return previewProfiles as T;
  }
  if (command === "update_sv2_concurrent_content") {
    const slot = previewProfiles.slots.find((item) => item.id === args?.slotId);
    if (slot) {
      slot.concurrent.content.appSettings = args?.appSettings as Sv2IsolationPreference;
      slot.concurrent.content.voiceLibraries = args?.voiceLibraries as Sv2IsolationPreference;
      slot.concurrent.content.effectiveAppSettings = slot.concurrent.content.appSettings === "global"
        ? previewProfiles.concurrentDefaults.appSettings
        : slot.concurrent.content.appSettings === "on";
      slot.concurrent.content.effectiveVoiceLibraries = slot.concurrent.content.voiceLibraries === "global"
        ? previewProfiles.concurrentDefaults.voiceLibraries
        : slot.concurrent.content.voiceLibraries === "on";
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
  if (command === "preview_svp_route") {
    const projectPath = String(args?.projectPath ?? "C:\\Projects\\demo.svp");
    const requiredVoiceNames = ["Mai 2", "SOLARIA"];
    return {
      projectPath,
      requiredVoices: [
        { name: "Mai 2", version: 104, backendType: "sv2" },
        { name: "SOLARIA", version: 101, backendType: "sv2" },
      ],
      candidates: previewProfiles.slots.map((slot, index) => ({
        slotId: slot.id,
        displayName: slot.displayName,
        idle: index > 0,
        launchMode: index > 0 ? "concurrent" as const : undefined,
        remoteUse: (index > 0 ? slot.concurrentAccountProbe : slot.accountProbe).remoteUse,
        sessionStatus: (index > 0 ? slot.concurrentAccountProbe : slot.accountProbe).sessionStatus,
        authorizationSource: slot.voiceInventory.status === "verified" ? "session" as const : slot.voiceInventory.manuallyConfirmedVoices.length ? "manual" as const : "unknown" as const,
        matchedVoices: slot.voiceInventory.status === "verified"
          ? requiredVoiceNames
          : slot.voiceInventory.manuallyConfirmedVoices.filter((voice) => requiredVoiceNames.includes(voice)),
        missingOrUnknownVoices: slot.voiceInventory.status === "verified" || slot.voiceInventory.manuallyConfirmedVoices.length === requiredVoiceNames.length ? [] : requiredVoiceNames,
        exactAuthorizationMatch: slot.voiceInventory.status === "verified" || slot.voiceInventory.manuallyConfirmedVoices.length === requiredVoiceNames.length,
        reason: index > 0 ? "官方服务已接受无踢出设备登录事件，并匹配工程所需的 2 个官方声库授权。" : "账号当前正在本机使用，且服务端占用状态未知。",
      })),
      selectedSlotId: previewProfiles.slots[1]?.id,
      selectedLaunchMode: "concurrent",
      requiresConfirmation: false,
      summary: "将使用账号“备用账号”打开工程。",
      detail: "官方服务已接受无踢出设备登录事件，并匹配工程所需的官方声库授权。",
    } as SvpRoutePlan as T;
  }
  if (command === "launch_svp_route") {
    return { succeeded: true, summary: "已按所选账号打开 .svp 工程。", detail: "预览模式" } as T;
  }
  if (command === "queue_component_install") {
    const componentId = String(args?.id ?? "");
    const componentName = previewState().components.find((item) => item.id === componentId)?.displayName ?? componentId;
    if (!previewDownloads.some((item) => item.componentId === componentId)) {
      previewDownloads.push({
        id: crypto.randomUUID(),
        componentId,
        displayName: componentName,
        status: "queued",
        progress: 0,
        detail: "等待前面的下载任务完成。",
        updatedAt: new Date().toISOString(),
      });
    }
    return previewDownloads as T;
  }
  if (command === "component_downloads") return previewDownloads as T;
  if (command === "cancel_component_install") {
    const task = previewDownloads.find((item) => item.id === String(args?.taskId ?? ""));
    if (task?.status === "queued") {
      task.status = "cancelled";
      task.detail = "已在开始下载前取消。";
      task.updatedAt = new Date().toISOString();
    }
    return previewDownloads as T;
  }
  if (command === "retry_component_install") {
    const task = previewDownloads.find((item) => item.id === String(args?.taskId ?? ""));
    if (task && ["failed", "cancelled"].includes(task.status)) {
      task.status = "queued";
      task.progress = 0;
      task.detail = "等待前面的下载任务完成。";
      task.updatedAt = new Date().toISOString();
    }
    return previewDownloads as T;
  }
  if (command === "open_downloaded_component") return { succeeded: true, summary: "已打开 Sandboxie 安装包位置。", detail: "预览模式" } as T;
  if (command === "remove_local_component") {
    const componentId = String(args?.id ?? "");
    if (!previewManagedComponentIds.has(componentId)) {
      return { succeeded: false, summary: "该组件不由 SynthV Toolbox 管理。", detail: "预览模式不会删除系统或外部安装的组件。" } as T;
    }
    if (!previewInstalledManagedComponentIds.delete(componentId)) {
      return { succeeded: true, summary: "组件当前未安装。", detail: "预览状态中没有需要删除的工具箱运行环境或配置。" } as T;
    }
    return { succeeded: true, summary: "本地组件已删除。", detail: "已删除工具箱管理的运行环境与配置；输出文件保持不变。" } as T;
  }
  if (command === "list_workflow_recipes") return [
    { id: "project-doctor", title: "工程医生", description: "只读检查工程风险。", kind: "project-doctor", inputKind: "svp", supportsBatch: true, requiresBridge: false, requiresAi: false, defaultParameters: {} },
    { id: "pronunciation-check", title: "发音诊断", description: "检查歌词和音素风险。", kind: "pronunciation-check", inputKind: "svpOrText", supportsBatch: true, requiresBridge: false, requiresAi: false, defaultParameters: {} },
    { id: "render-quality-check", title: "渲染复检", description: "检查渲染交付风险。", kind: "render-quality-check", inputKind: "audio", supportsBatch: true, requiresBridge: false, requiresAi: false, defaultParameters: {} },
    { id: "lyric-template", title: "作词", description: "歌词草稿、歌曲结构与可选韵脚辅助。", kind: "lyric-template", inputKind: "lyrics", supportsBatch: false, requiresBridge: false, requiresAi: false, defaultParameters: { language: "zh-CN", rhymeMode: "family" } },
  ] as T;
  if (command === "list_creative_history" || command === "list_project_checkpoints") return [] as T;
  if (command === "create_project_checkpoint") return {
    id: crypto.randomUUID(), label: String(args?.label ?? "检查点"), sourcePath: String(args?.projectPath ?? ""),
    snapshotPath: "~/.SynthVcopilot/project-checkpoints/preview/project.svp", sourceSha256: "preview", sourceSize: 0, createdAtUtc: new Date().toISOString(),
  } as T;
  if (command === "restore_project_checkpoint") return { succeeded: true, summary: "检查点已恢复为新副本。", detail: "预览模式" } as T;
  if (command === "export_workflow_report") return {
    succeeded: true,
    summary: "工作流报告已导出。",
    detail: `预览路径：workflow-reports/preview-report.${args?.format === "json" ? "json" : "md"}`,
  } as T;
  if (command === "lookup_chinese_rhyme") {
    const query = String(args?.query ?? "ang");
    const characters = "昂盎邦帮膀榜傍磅蚌仓苍沧舱藏昌长常场厂唱倡畅肠偿尝当党档荡芳房防仿访放冈刚岗钢纲港杠光广逛杭航行巷慌黄皇凰恍晃荒江姜将浆疆讲奖匠康扛抗亢廊狼朗浪凉梁良两亮茫忙盲氓囊娘酿旁胖庞腔墙强抢枪襄湘乡香箱祥详响想向央扬杨洋阳仰养样张章彰樟涨掌仗丈帐障妆庄桩装壮状王望忘网往";
    return {
      language: "zh-CN",
      query,
      queryPinyin: /[\u3400-\u9fff]/u.test(query) ? ["guang"] : [],
      matchMode: (args?.matchMode as RhymeMatchMode | undefined) ?? "family",
      rhymeKeys: ["ang"],
      total: [...characters].length,
      characters: [...characters].map((character) => ({ character, pinyin: ["…ang"] })),
      coverageNote: "预览模式展示常用字子集；桌面后端会扫描内置拼音字典收录的全部 CJK 字符。",
    } as T;
  }
  if (command === "build_lyric_template") {
    const sections = (args?.sections as LyricSectionRequest[] | undefined) ?? [];
    const rhymeTargets = (args?.rhymeTargets as Record<string, string> | undefined) ?? {};
    const title = String(args?.title || "未命名歌曲");
    const built = sections.map((section) => ({
      ...section,
      lines: Array.from({ length: section.lineCount }, (_, index) => {
        const scheme = section.rhymeScheme || "-";
        const marker = scheme[index % scheme.length]?.toUpperCase() ?? "-";
        return { lineNumber: index + 1, rhymeLabel: marker === "-" ? null : marker, targetRhyme: rhymeTargets[marker] || null, placeholder: `${section.label} 第 ${index + 1} 句${marker === "-" ? "" : ` · ${marker} 韵`}` };
      }),
    }));
    const totalLines = sections.reduce((sum, section) => sum + section.lineCount, 0);
    return { kind: "lyric-template", summary: `已建立《${title}》的歌词结构：${sections.length} 个段落，共 ${totalLines} 行。`, data: { language: "zh-CN", title, totalLines, rhymeTargets, sections: built } } as T;
  }
  if (command === "list_lyric_projects") {
    const limit = Math.min(Math.max(Number(args?.limit ?? 50), 1), 200);
    return previewLyricProjects
      .map(({ id, title, revision, draft, updatedAtUtc }) => ({ id, title, revision, lineCount: draft.split(/\r?\n/).filter((line) => line.trim()).length, updatedAtUtc }))
      .sort((left, right) => right.updatedAtUtc.localeCompare(left.updatedAtUtc))
      .slice(0, limit) as T;
  }
  if (command === "create_lyric_project") {
    const now = new Date().toISOString();
    const project: LyricProject = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      title: String(args?.title ?? "").trim() || "未命名歌曲",
      draft: String(args?.draft ?? ""),
      rhymeTargets: { ...((args?.rhymeTargets as Record<string, string> | undefined) ?? {}) },
      sections: [...((args?.sections as LyricSectionRequest[] | undefined) ?? [])],
      revision: 1,
      createdAtUtc: now,
      updatedAtUtc: now,
    };
    previewLyricProjects = [project, ...previewLyricProjects];
    return project as T;
  }
  if (command === "save_lyric_project") {
    const id = String(args?.id ?? "");
    const index = previewLyricProjects.findIndex((project) => project.id === id);
    if (index < 0) throw new Error("找不到该歌词项目。");
    const existing = previewLyricProjects[index];
    const project: LyricProject = {
      ...existing,
      title: String(args?.title ?? "").trim() || "未命名歌曲",
      draft: String(args?.draft ?? ""),
      rhymeTargets: { ...((args?.rhymeTargets as Record<string, string> | undefined) ?? {}) },
      sections: [...((args?.sections as LyricSectionRequest[] | undefined) ?? [])],
      revision: existing.revision + 1,
      updatedAtUtc: new Date().toISOString(),
    };
    previewLyricProjects[index] = project;
    return project as T;
  }
  if (command === "load_lyric_project") {
    const project = previewLyricProjects.find((item) => item.id === String(args?.id ?? ""));
    if (!project) throw new Error("找不到该歌词项目。");
    return { ...project, rhymeTargets: { ...project.rhymeTargets }, sections: [...project.sections] } as T;
  }
  if (command === "generate_lyric_candidates") return {
    language: "zh-CN",
    brief: String((args?.request as LyricCandidateRequest | undefined)?.brief ?? ""),
    imagery: String((args?.request as LyricCandidateRequest | undefined)?.imagery ?? ""),
    sectionLabel: String((args?.request as LyricCandidateRequest | undefined)?.sectionLabel ?? "副歌"),
    targetRhyme: "ang",
    candidates: [
      { text: "旧月台还留着未熄的光", rhymeFoot: "光", rhymeMatched: true, note: "用月台承接离别，句尾落在 ang 韵。" },
      { text: "风把那封信吹回我身旁", rhymeFoot: "旁", rhymeMatched: true, note: "让旧信成为回望的动作线索。" },
      { text: "我把没说完的话装进行囊", rhymeFoot: "囊", rhymeMatched: true, note: "收束情绪，同时保留继续发展的空间。" },
      { text: "车窗外的故乡越来越长", rhymeFoot: "长", rhymeMatched: true, note: "用移动镜头扩大空间感。" },
    ],
  } as T;
  if (command === "sv2_sync_categories") return [
    { id: "userDictionaries", label: "用户词典", description: "仅同步用户词典文件；不包含账号或登录数据。", relativeRoots: ["dicts"] },
    { id: "scripts", label: "脚本", description: "同步用户安装或编写的脚本。", relativeRoots: ["scripts"] },
    { id: "presets", label: "预设", description: "同步用户预设子目录。", relativeRoots: ["presets"] },
    { id: "safeSettings", label: "安全设置", description: "仅同步明确允许的非账号设置子目录。", relativeRoots: ["settings/shortcuts", "settings/theme", "settings/ui"] },
  ] as T;
  if (command === "preview_sv2_selective_sync") return {
    version: 1, overwrite: Boolean(args?.overwrite), rootScope: "preview-root-scope", token: "preview-token",
    entries: [{ category: "userDictionaries", relativePath: "dicts/user.json", action: "copy", sourceSize: 128, sourceSha256: "preview" }],
  } as T;
  if (command === "execute_sv2_selective_sync") return { copied: 1, updated: 0, skipped: 0, conflicts: 0 } as T;
  if (command === "run_batch_workflow") return {
    recipeId: String(args?.recipeId ?? "project-doctor"), completed: (args?.inputPaths as unknown[] | undefined)?.length ?? 0, failed: 0,
    items: ((args?.inputPaths as string[] | undefined) ?? []).map((inputPath) => ({ inputPath, status: "completed", result: { kind: String(args?.recipeId ?? "batch"), summary: "预览批处理完成。", data: { preview: true } } })),
  } as T;
  if (command === "run_project_doctor" || command === "run_pronunciation_diagnostics") return {
    kind: command === "run_project_doctor" ? "project-doctor" : "pronunciation-check",
    summary: "预览诊断发现 1 个错误和 1 个警告。",
    data: {
      kind: command === "run_project_doctor" ? "project-doctor" : "pronunciation-check",
      ok: false,
      summary: "预览诊断发现 1 个错误和 1 个警告。",
      inspectedItems: 24,
      issues: [
        { code: "NOTE_TIMING_INVALID", severity: "error", message: "音符起点或时值无效。", location: "tracks[0].mainGroup.notes[3]", suggestion: "检查该音符的起止位置。" },
        { code: "LYRIC_EMPTY", severity: "warning", message: "音符歌词为空。", location: "tracks[0].mainGroup.notes[7]", suggestion: "补充歌词或确认这是有意的静音音符。" },
      ],
    },
  } as T;
  if (command === "queue_media_import") {
    const now = new Date().toISOString();
    const task: MediaTaskSnapshot = {
      id: crypto.randomUUID(),
      kind: "media-import",
      status: "queued",
      progress: 0,
      detail: "等待前面的媒体任务完成。",
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    previewMediaTasks.push(task);
    return task as T;
  }
  if (command === "queue_media_separation") {
    const now = new Date().toISOString();
    const task: MediaTaskSnapshot = {
      id: crypto.randomUUID(),
      kind: "source-separation",
      status: "queued",
      progress: 0,
      detail: "等待前面的媒体任务完成。",
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    previewMediaTasks.push(task);
    return task as T;
  }
  if (command === "queue_cover") {
    const now = new Date().toISOString();
    const task: MediaTaskSnapshot = {
      id: crypto.randomUUID(),
      kind: "cover",
      status: "queued",
      progress: 0,
      detail: "等待前面的媒体任务完成。",
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    previewMediaTasks.push(task);
    return task as T;
  }
  if (command === "list_tuning_profiles") return [] as T;
  if (command === "learn_tuning_profile" || command === "record_tuning_outcome") return {
    voiceName: String(args?.voiceName ?? "Preview Voice"),
    normalizedVoiceName: String(args?.voiceName ?? "preview voice").toLowerCase(),
    sourceSamples: 1,
    outcomeSamples: command === "record_tuning_outcome" ? 1 : 0,
    averageFeatures: { durationSec: 20, medianPitchMidi: 64, pitchRangeSemitones: 14, vibratoRateHz: 5.2, vibratoDepthCents: 42, dynamicRangeDb: 18, breathinessProxy: 0.2, brightnessHz: 2200, voicedRatio: 0.8 },
    parameters: { loudness: 0, tension: 0.1, breathiness: 0.04, gender: 0, toneShift: 0, vibratoStrength: 0.36 },
    updatedAtUtc: new Date().toISOString(),
  } as T;
  if (command === "apply_tuning_profile") return { kind: "learned-tuning-apply", summary: "已应用本地学习调声参数。", data: {} } as T;
  if (command === "media_tasks") return previewMediaTasks as T;
  if (command === "cancel_media_task") {
    const task = previewMediaTasks.find((item) => item.id === String(args?.taskId ?? ""));
    if (task && ["queued", "running", "cancelling"].includes(task.status)) {
      task.status = "cancelled";
      task.detail = "媒体进程树已终止，临时输出已清理。";
      task.updatedAt = new Date().toISOString();
    }
    return task as T;
  }
  if (command === "retry_media_task") {
    const task = previewMediaTasks.find((item) => item.id === String(args?.taskId ?? ""));
    if (task && ["failed", "cancelled"].includes(task.status)) {
      task.status = "queued";
      task.progress = 0;
      task.detail = "等待前面的媒体任务完成。";
      task.error = null;
      task.updatedAt = new Date().toISOString();
    }
    return task as T;
  }
  if (command === "run_render_review") return {
    kind: "render-quality-check",
    summary: "渲染复检通过，未发现交付阻断项。",
    data: {
      probe: { duration_sec: 183.2, bpm: 128, key_guess: "C#", peak_dbfs: -1.1, rms_dbfs: -14.8, clipped_sample_ratio: 0, silent_frame_ratio: 0.02 },
      report: { kind: "render-quality-check", ok: true, summary: "渲染复检通过。", inspectedItems: 8, issues: [] },
    },
  } as T;
  if (command === "list_conversations") return [] as T;
  if (command === "new_conversation") return { id: "preview", title: "新对话", messages: [] } as T;
  if (command === "open_conversation") return { id: "preview", title: "预览对话", messages: [] } as T;
  if (command === "send_message") return [{ role: "assistant", content: "这是本地视觉预览回复。" }] as T;
  if (command.startsWith("run_") || ["add_project_reference", "export_project_without_parameters", "export_project_lyrics"].includes(command)) return {
    kind: command.replace(/^run_/, "").replaceAll("_", "-"),
    summary: "预览工作流已完成。",
    outputPath: command === "run_game_to_midi" || command === "run_audio_to_project"
      ? `~/.SynthVcopilot/output/${String(args?.outputName ?? "audio_to_project.mid")}`
      : command === "export_project_without_parameters"
        ? `~/.SynthVcopilot/output/${String(args?.outputName ?? "project_no_params.svp")}`
        : command === "export_project_lyrics"
          ? `~/.SynthVcopilot/output/${String(args?.outputName ?? "project.lrc")}`
          : undefined,
    data: { preview: true, command, parameters: args ?? {} },
  } as T;
  if (command === "review_workflow") return "结论：结果结构完整。\n风险：预览模式未执行真实组件。\n建议参数：发布构建中按实际素材复核。" as T;
  return { succeeded: true, summary: "预览操作已完成。", detail: "" } as T;
}

export const api = {
  bootstrap: () => call<BootstrapState>("bootstrap"),
  completeOnboarding: (mode: AppMode) => call<BootstrapState>("complete_onboarding", { mode }),
  setMode: (mode: AppMode) => call<BootstrapState>("set_mode", { mode }),
  setAgentWorkMode: (mode: AgentWorkMode) => call<BootstrapState>("set_agent_work_mode", { mode }),
  authorizeAiProvider: (provider: AiProviderId) =>
    call<BootstrapState>("authorize_ai_provider", { provider }),
  selectAiProvider: (provider: AiProviderId, model: string) =>
    call<BootstrapState>("select_ai_provider", { provider, model }),
  aiProviderState: () => call<ModelSummary>("ai_provider_state"),
  opencodeProviderCatalog: (force = false) =>
    call<OpenCodeCatalog>("opencode_provider_catalog", { force }),
  removeAiProviderAccount: (provider: AiProviderId, accountId: string) =>
    call<BootstrapState>("remove_ai_provider_account", { provider, accountId }),
  scanSynthV: () => call<SynthVInstallation[]>("scan_synthv"),
  checkToolboxUpdate: () => call<ToolboxUpdateCheck>("check_toolbox_update"),
  openToolboxReleases: () => call<OperationResult>("open_toolbox_releases"),
  sv2ProfileState: () => call<Sv2ProfilesState>("sv2_profile_state"),
  sv2AccountPrecheck: () => call<Sv2AccountPrecheck>("sv2_account_precheck"),
  sv2AccountUsageSnapshot: () => call<Sv2AccountUsageSnapshot>("sv2_account_usage_snapshot"),
  sv2AccountUsageSnapshotForSlot: (slotId: string) =>
    call<Sv2AccountUsageSnapshot>("sv2_account_usage_snapshot_for_slot", { slotId }),
  setSv2AccountIndicator: (enabled: boolean, acknowledged = false) =>
    call<BootstrapState>("set_sv2_account_indicator", { enabled, acknowledged }),
  sv2SyncCategories: () => call<Sv2SyncCategory[]>("sv2_sync_categories"),
  previewSv2SelectiveSync: (sourceSlotId: string, targetSlotId: string, categories: Sv2SyncCategoryId[], overwrite: boolean) =>
    call<Sv2SyncManifest>("preview_sv2_selective_sync", { sourceSlotId, targetSlotId, categories, overwrite }),
  executeSv2SelectiveSync: (sourceSlotId: string, targetSlotId: string, categories: Sv2SyncCategoryId[], approved: Sv2SyncManifest) =>
    call<Sv2SyncResult>("execute_sv2_selective_sync", { sourceSlotId, targetSlotId, categories, approved, token: approved.token }),
  importCurrentSv2Profile: (displayName: string) =>
    call<Sv2ProfilesState>("import_current_sv2_profile", { displayName }),
  createSv2Profile: (displayName: string) =>
    call<Sv2ProfilesState>("create_sv2_profile", { displayName }),
  renameSv2Profile: (slotId: string, displayName: string) =>
    call<Sv2ProfilesState>("rename_sv2_profile", { slotId, displayName }),
  updateSv2ProfileIdentity: (slotId: string, username: string, email: string) =>
    call<Sv2ProfilesState>("update_sv2_profile_identity", { slotId, username, email }),
  updateSv2ProfileVoiceLicenses: (slotId: string, voices: string[]) =>
    call<Sv2ProfilesState>("update_sv2_profile_voice_licenses", { slotId, voices }),
  deleteSv2Profile: (slotId: string) =>
    call<Sv2ProfilesState>("delete_sv2_profile", { slotId }),
  setSv2ConcurrentEnabled: (enabled: boolean) =>
    call<BootstrapState>("set_sv2_concurrent_enabled", { enabled }),
  updateSv2ConcurrentDefaults: (appSettings: boolean, voiceLibraries: boolean) =>
    call<Sv2ProfilesState>("update_sv2_concurrent_defaults", { appSettings, voiceLibraries }),
  updateSv2ConcurrentContent: (slotId: string, appSettings: Sv2IsolationPreference, voiceLibraries: Sv2IsolationPreference) =>
    call<Sv2ProfilesState>("update_sv2_concurrent_content", { slotId, appSettings, voiceLibraries }),
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
  previewSvpRoute: (projectPath: string) =>
    call<SvpRoutePlan>("preview_svp_route", { projectPath }),
  launchSvpRoute: (slotId: string, projectPath: string, mode: SvpLaunchMode) =>
    call<OperationResult>("launch_svp_route", { slotId, projectPath, mode }),
  setSvpLaunchRouting: (enabled: boolean) =>
    call<BootstrapState>("set_svp_launch_routing", { enabled }),
  openSvpDefaultAppsSettings: () =>
    call<OperationResult>("open_svp_default_apps_settings"),
  acceptSv2ConcurrentDisclaimer: () =>
    call<BootstrapState>("accept_sv2_concurrent_disclaimer"),
  openSv2ConcurrentFolder: (slotId: string) =>
    call<OperationResult>("open_sv2_concurrent_folder", { slotId }),
  saveScriptsPath: (scriptsPath: string) => call<BootstrapState>("save_scripts_path", { scriptsPath }),
  installBridge: (scriptsPath: string) => call<OperationResult>("install_bridge", { scriptsPath }),
  diagnoseBridge: (scriptsPath: string) => call<OperationResult>("diagnose_bridge", { scriptsPath }),
  connectBridge: () => call<OperationResult>("connect_bridge"),
  listSynthvProcesses: () => call<SynthVProcess[]>("list_synthv_processes"),
  synthvShortcutProfile: () => call<SynthVShortcutProfile>("synthv_shortcut_profile"),
  sendSynthvBridgeShortcut: (processId: number, action: "start" | "stop") =>
    call<OperationResult>("send_synthv_bridge_shortcut", { processId, action }),
  autoConnectSynthvBridge: (processId: number) =>
    call<OperationResult>("auto_connect_synthv_bridge", { processId }),
  audioCaptureCapability: () => call<AudioCaptureCapability>("audio_capture_capability"),
  listSynthvCaptureTargets: () => call<AudioCaptureTarget[]>("list_synthv_capture_targets"),
  captureSynthvClip: (processId: number | undefined, startSeconds: number, endSeconds: number, preRollSeconds: number, postRollSeconds: number, label: string) =>
    call<WorkflowResult>("capture_synthv_clip", { processId: processId ?? null, startSeconds, endSeconds, preRollSeconds, postRollSeconds, label }),
  compareSynthvClips: (baselinePath: string, candidatePath: string, maxLagMs: number) =>
    call<WorkflowResult>("compare_synthv_clips", { baselinePath, candidatePath, maxLagMs }),
  componentDownloads: () => call<ComponentDownload[]>("component_downloads"),
  queueComponentInstall: (id: string) => call<ComponentDownload[]>("queue_component_install", { id }),
  cancelComponentInstall: (taskId: string) => call<ComponentDownload[]>("cancel_component_install", { taskId }),
  retryComponentInstall: (taskId: string) => call<ComponentDownload[]>("retry_component_install", { taskId }),
  openDownloadedComponent: (id: string) => call<OperationResult>("open_downloaded_component", { id }),
  removeLocalComponent: (id: string) => call<OperationResult>("remove_local_component", { id }),
  listWorkflowRecipes: () => call<WorkflowRecipe[]>("list_workflow_recipes"),
  listCreativeHistory: (limit = 50) => call<CreativeHistoryEntry[]>("list_creative_history", { limit }),
  createProjectCheckpoint: (projectPath: string, label: string) =>
    call<ProjectCheckpoint>("create_project_checkpoint", { projectPath, label }),
  listProjectCheckpoints: (limit = 50) => call<ProjectCheckpoint[]>("list_project_checkpoints", { limit }),
  restoreProjectCheckpoint: (id: string, outputName: string) =>
    call<OperationResult>("restore_project_checkpoint", { id, outputName }),
  exportWorkflowReport: (kind: string, summary: string, data: Record<string, unknown>, format: "markdown" | "json") =>
    call<OperationResult>("export_workflow_report", { kind, summary, data, format }),
  lookupChineseRhyme: (query: string, matchMode: RhymeMatchMode) =>
    call<ChineseRhymeLookup>("lookup_chinese_rhyme", { query, matchMode }),
  buildLyricTemplate: (language: "zh-CN", title: string, sections: LyricSectionRequest[], rhymeTargets: Record<string, string>) =>
    call<WorkflowResult>("build_lyric_template", { language, title, sections, rhymeTargets }),
  generateLyricCandidates: (request: LyricCandidateRequest) =>
    call<LyricCandidateSet>("generate_lyric_candidates", { request }),
  listLyricProjects: (limit = 50) => call<LyricProjectSummary[]>("list_lyric_projects", { limit }),
  createLyricProject: (title: string, draft: string, sections: LyricSectionRequest[], rhymeTargets: Record<string, string>) =>
    call<LyricProject>("create_lyric_project", { title, draft, sections, rhymeTargets }),
  saveLyricProject: (id: string, title: string, draft: string, sections: LyricSectionRequest[], rhymeTargets: Record<string, string>) =>
    call<LyricProject>("save_lyric_project", { id, title, draft, sections, rhymeTargets }),
  loadLyricProject: (id: string) => call<LyricProject>("load_lyric_project", { id }),
  runProjectDoctor: (projectPath: string) =>
    call<WorkflowResult>("run_project_doctor", { projectPath }),
  runPronunciationDiagnostics: (projectPath?: string, lyrics?: string) =>
    call<WorkflowResult>("run_pronunciation_diagnostics", { projectPath: projectPath || null, lyrics: lyrics || null }),
  runRenderReview: (audioPath: string, expectedDurationSec?: number, expectedBpm?: number, requireNotes = false, advanced = false) =>
    call<WorkflowResult>("run_render_review", { audioPath, expectedDurationSec: expectedDurationSec ?? null, expectedBpm: expectedBpm ?? null, requireNotes, advanced }),
  runAudioToProject: (vocalPath: string, instrumentalPath: string, outputName: string, tolerance: number, advanced: boolean, importToSynthv: boolean, rightsConfirmed: boolean, trackIndex: number, groupName: string) =>
    call<WorkflowResult>("run_audio_to_project", { vocalPath, instrumentalPath, outputName, tolerance, advanced, importToSynthv, rightsConfirmed, trackIndex, groupName }),
  runScoreToSynthv: (scorePath: string, trackIndex: number, groupName: string, rightsConfirmed: boolean) =>
    call<WorkflowResult>("run_score_to_synthv", { scorePath, trackIndex, groupName, rightsConfirmed }),
  runRetakeWorkbench: (trackIndex: number, groupIndex: number, noteIndex: number, operation: string, takeId: number | undefined, newDuration: boolean, newPitch: boolean, newTimbre: boolean, activate: boolean) =>
    call<WorkflowResult>("run_retake_workbench", { trackIndex, groupIndex, noteIndex, operation, takeId: takeId ?? null, newDuration, newPitch, newTimbre, activate }),
  runBatchWorkflow: (recipeId: string, inputPaths: string[], options: Record<string, unknown>) =>
    call<BatchWorkflowResult>("run_batch_workflow", { recipeId, inputPaths, options }),
  runAudioProbe: (audioPath: string, advanced: boolean) =>
    call<WorkflowResult>("run_audio_probe", { audioPath, advanced }),
  previewMediaSource: (source: string) => call<MediaSourcePreview>("preview_media_source", { source }),
  mediaTasks: () => call<MediaTaskSnapshot[]>("media_tasks"),
  queueMediaImport: (source: string, rightsConfirmed: boolean) =>
    call<MediaTaskSnapshot>("queue_media_import", { source, rightsConfirmed }),
  queueMediaSeparation: (audioPath: string) =>
    call<MediaTaskSnapshot>("queue_media_separation", { audioPath }),
  queueCover: (request: CoverTaskRequest) => call<MediaTaskSnapshot>("queue_cover", { request }),
  cancelMediaTask: (taskId: string) => call<MediaTaskSnapshot>("cancel_media_task", { taskId }),
  retryMediaTask: (taskId: string) => call<MediaTaskSnapshot>("retry_media_task", { taskId }),
  listTuningProfiles: () => call<TuningProfile[]>("list_tuning_profiles"),
  learnTuningProfile: (audioPath: string, voiceName: string) => call<TuningProfile>("learn_tuning_profile", { audioPath, voiceName }),
  recordTuningOutcome: (voiceName: string, candidate: TuningParameters, improvement: number) => call<TuningProfile>("record_tuning_outcome", { voiceName, candidate, improvement }),
  applyTuningProfile: (voiceName: string, trackIndex: number, groupIndex: number) => call<WorkflowResult>("apply_tuning_profile", { voiceName, trackIndex, groupIndex }),
  runGameToMidi: (vocalPath: string, instrumentalPath: string, outputName: string, tolerance: number, advanced: boolean) =>
    call<WorkflowResult>("run_game_to_midi", { vocalPath, instrumentalPath, outputName, tolerance, advanced }),
  runProjectProbe: (projectPath: string) =>
    call<WorkflowResult>("run_project_probe", { projectPath }),
  addProjectReference: (projectPath: string, audioPath: string, trackName: string, beginSeconds: number, outputName: string) =>
    call<WorkflowResult>("add_project_reference", { projectPath, audioPath, trackName, beginSeconds, outputName }),
  exportProjectWithoutParameters: (projectPath: string, outputName: string) =>
    call<WorkflowResult>("export_project_without_parameters", { projectPath, outputName }),
  exportProjectLyrics: (projectPath: string, trackIndex: number, lineGapSeconds: number, outputName: string, wordOutputName: string) =>
    call<WorkflowResult>("export_project_lyrics", { projectPath, trackIndex, lineGapSeconds, outputName, wordOutputName }),
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
