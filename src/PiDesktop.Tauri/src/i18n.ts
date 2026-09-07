import { createI18n } from "vue-i18n";

export type AppLocale = "zh-CN" | "en";
type Messages = Record<string, unknown>;

const storageKey = "synthv-toolbox.locale";
const fallbackLocale: AppLocale = "zh-CN";

function savedLocale(): AppLocale {
  try {
    return localStorage.getItem(storageKey) === "en" ? "en" : fallbackLocale;
  } catch {
    return fallbackLocale;
  }
}

const messages = {
  "zh-CN": {
    nav: { workspace: "工作区", system: "系统", home: "概览", accounts: "SV2 账号", import: "导入与转换", quality: "分析与质检", lyrics: "作词", history: "历史", copilot: "Copilot", components: "组件中心", bridge: "SynthV Bridge", connections: "连接", settings: "设置", expand: "展开侧栏", collapse: "收起侧栏" },
    pages: { home: ["概览", "查看环境状态与常用能力"], accounts: ["SV2 账号", "管理本机 SV2 槽位；Windows 还支持可选并发隔离"], import: ["导入与转换", "把曲谱或演唱音频变成可继续编辑的 MIDI 与 SynthV 音符"], quality: ["分析与质检", "集中完成音频分析、工程诊断、发音检查与交付复检"], lyrics: ["作词", "专注写下歌词，需要时再调用结构、韵脚与 AI 辅助"], history: ["历史", "查看工作流记录与工程自动备份"], copilot: ["Copilot", "让 AI 在受控工具边界内协助工作"], components: ["组件中心", "管理本地模型与运行组件"], bridge: ["SynthV Bridge", "探测、安装、诊断并连接 Synthesizer V"], connections: ["连接", "管理本机服务和外部 MCP 工具"], settings: ["设置", "调整运行模式与模型配置"] },
    settings: { language: "显示语言", chinese: "中文", english: "English", mode: "运行模式", modeDescription: "切换后导航与 Rust 后端能力会同时更新。", toolbox: "纯工具箱", toolboxDescription: "确定性基础流程，不启动 AI", ai: "AI 模式", aiDescription: "Copilot、智能增强与 MCP", aiDisabled: "AI 运行时已关闭", aiDisabledDescription: "当前不会显示 Copilot、模型或外部 MCP 设置，也不会向模型端点发送请求。工具箱自身的本地 MCP 服务仍可在连接页使用。", providers: "模型提供商", providersDescription: "可使用 OAuth 订阅或多份 API Key 接入；凭据均由本机后端处理。", addProvider: "添加或切换连接", noProvider: "尚未选择提供商", chooseProvider: "选择认证方式、提供商与模型后即可开始对话。", notConfigured: "未配置连接", legacyCredentials: "检测到旧版 API token 配置", legacyCredentialsDescription: "旧配置不会作为 OAuth 账号展示。请完成浏览器授权；后端迁移完成前仍会保留旧配置。", oauthSummary: "{count} 个 OAuth · {keys} 个 API Key", smartRoute: "智能 .svp 启动", smartRouteDescription: "根据工程所需声库，从空闲账号中建议最合适的启动槽位。", enabled: "已开启", disabled: "已关闭", unsupported: "当前平台不支持", defaultApp: "已设为 .svp 默认打开方式", registered: "已注册，等待设为默认应用", unregistered: "尚未注册为可选打开方式", openDefaults: "打开默认应用设置", update: "应用更新", updateDescription: "按需检查官方 GitHub Releases；不会自动下载或安装。", currentVersion: "当前版本", checkUpdate: "检查更新", checkAgain: "重新检查", dataPlatform: "数据与平台", dataPlatformDescription: "配置和历史使用统一的跨平台用户目录。", platform: "平台", config: "配置", appVersion: "应用版本" },
    connections: { localService: "工具箱本地服务", localServiceDescription: "仅监听本机回环地址；MCP 工具与 Agent 对话分别授权，默认全部关闭。", mcpTools: "MCP 工具接口", agentChat: "Agent 对话接口", port: "监听端口", apply: "应用并保存", running: "运行中", failed: "启动失败", off: "已关闭", listening: "监听", active: "正在运行", inactive: "未运行", disabled: "未启用", error: "错误", externalWarning: "外部 MCP 服务器可以启动本地进程", externalWarningDescription: "只添加你信任的命令。服务器必须显式启用后才会向 Copilot 暴露工具。", external: "外部 MCP", configurations: "{count} 个配置", addStdio: "添加 stdio MCP", stdioDescription: "进程通过私有 stdin/stdout 与 Rust 后端通信。", name: "显示名称", command: "命令", arguments: "参数（每行一个）", enableOnSave: "保存后立即启用", addServer: "添加服务器", enabled: "已启用", disabledServer: "已停用", noServers: "尚未添加外部 MCP 服务器。", aiOnly: "外部 MCP 仅在 AI 模式运行", aiOnlyDescription: "外部 MCP 工具只会提供给 AI 后端。切换到 AI 模式后可添加、测试和启用这些服务器。", saved: "本地 HTTP 接口设置已保存。", closed: "本地 HTTP 接口已关闭。", portError: "端口必须是 1 到 65535 之间的整数。", serverAdded: "{name} 已添加。", deleted: "MCP 配置已删除。" },
  },
  en: {
    nav: { workspace: "WORKSPACE", system: "SYSTEM", home: "Overview", accounts: "SV2 Accounts", import: "Import & Convert", quality: "Analysis & QA", lyrics: "Lyrics", history: "History", copilot: "Copilot", components: "Components", bridge: "SynthV Bridge", connections: "Connections", settings: "Settings", expand: "Expand sidebar", collapse: "Collapse sidebar" },
    pages: { home: ["Overview", "Review environment status and common capabilities"], accounts: ["SV2 Accounts", "Manage local SV2 slots, with optional concurrent isolation on Windows"], import: ["Import & Convert", "Turn scores and vocal audio into editable MIDI and SynthV notes"], quality: ["Analysis & QA", "Run audio analysis, project diagnostics, pronunciation checks, and delivery review"], lyrics: ["Lyrics", "Write lyrics first, then use structure, rhyme, and AI assistance when needed"], history: ["History", "Review workflow records and automatic project backups"], copilot: ["Copilot", "Let AI help within controlled tool boundaries"], components: ["Components", "Manage local models and runtime components"], bridge: ["SynthV Bridge", "Detect, install, diagnose, and connect Synthesizer V"], connections: ["Connections", "Manage local services and external MCP tools"], settings: ["Settings", "Adjust runtime mode and model configuration"] },
    settings: { language: "Display language", chinese: "中文", english: "English", mode: "Runtime mode", modeDescription: "Changing mode updates navigation and Rust backend capabilities together.", toolbox: "Toolbox only", toolboxDescription: "Deterministic core workflows without starting AI", ai: "AI mode", aiDescription: "Copilot, smart enhancements, and MCP", aiDisabled: "AI runtime is off", aiDisabledDescription: "Copilot, model, and external MCP settings are unavailable, and no model endpoint requests are made. Toolbox’s own local MCP service remains available on the Connections page.", providers: "Model providers", providersDescription: "Connect with OAuth subscriptions or multiple API keys; credentials are handled by the local backend.", addProvider: "Add or switch connection", noProvider: "No provider selected", chooseProvider: "Choose authentication, provider, and model to start chatting.", notConfigured: "No connection configured", legacyCredentials: "Legacy API token configuration detected", legacyCredentialsDescription: "Legacy configuration is not displayed as an OAuth account. Complete browser authorization; it remains available until backend migration finishes.", oauthSummary: "{count} OAuth · {keys} API keys", smartRoute: "Smart .svp launch", smartRouteDescription: "Suggest the best idle account slot for the voices required by a project.", enabled: "On", disabled: "Off", unsupported: "Unsupported on this platform", defaultApp: "Set as the default .svp app", registered: "Registered; waiting to become the default app", unregistered: "Not registered as an available app", openDefaults: "Open default apps settings", update: "App updates", updateDescription: "Check official GitHub Releases on demand; downloads and installation never start automatically.", currentVersion: "Current version", checkUpdate: "Check for updates", checkAgain: "Check again", dataPlatform: "Data & platform", dataPlatformDescription: "Configuration and history use a shared cross-platform user directory.", platform: "Platform", config: "Configuration", appVersion: "App version" },
    connections: { localService: "Local Toolbox service", localServiceDescription: "Listens only on the local loopback address. MCP tools and Agent chat require separate consent and are off by default.", mcpTools: "MCP tools endpoint", agentChat: "Agent chat endpoint", port: "Port", apply: "Apply and save", running: "Running", failed: "Failed to start", off: "Off", listening: "Listener", active: "Running", inactive: "Not running", disabled: "Disabled", error: "Error", externalWarning: "External MCP servers can start local processes", externalWarningDescription: "Add only commands you trust. A server must be explicitly enabled before its tools are exposed to Copilot.", external: "External MCP", configurations: "{count} configured", addStdio: "Add stdio MCP", stdioDescription: "The process communicates with the Rust backend over private stdin/stdout.", name: "Display name", command: "Command", arguments: "Arguments (one per line)", enableOnSave: "Enable immediately after saving", addServer: "Add server", enabled: "Enabled", disabledServer: "Disabled", noServers: "No external MCP servers have been added.", aiOnly: "External MCP runs only in AI mode", aiOnlyDescription: "External MCP tools are available only to the AI backend. Switch to AI mode to add, test, and enable these servers.", saved: "Local HTTP interface settings saved.", closed: "Local HTTP interface closed.", portError: "Port must be an integer from 1 to 65535.", serverAdded: "{name} added.", deleted: "MCP configuration deleted." },
  },
};

const settingsMessages = messages["zh-CN"].settings as Record<string, string>;
settingsMessages.autostart = "开机启动";
settingsMessages.autostartDescription = "登录系统时在后台启动 Toolbox；需要时可从托盘打开窗口。";
settingsMessages.unknown = "状态未知";
const englishSettingsMessages = messages.en.settings as Record<string, string>;
englishSettingsMessages.autostart = "Launch at login";
englishSettingsMessages.autostartDescription = "Start Toolbox in the background when you sign in; open the window from the tray when needed.";
englishSettingsMessages.unknown = "Status unavailable";
const options = { legacy: false as const, locale: savedLocale(), fallbackLocale, messages };
export const i18n = createI18n<typeof messages["zh-CN"], AppLocale, false, typeof options>(options);

function applyDocumentLocale(next: AppLocale): void {
  document.documentElement.lang = next;
}

applyDocumentLocale(locale());

export function t(key: string, params?: Record<string, unknown>): string {
  return i18n.global.t(key, params ?? {});
}

export function locale(): AppLocale {
  return i18n.global.locale.value as AppLocale;
}

export function setLocale(next: AppLocale): void {
  i18n.global.locale.value = next;
  applyDocumentLocale(next);
  try { localStorage.setItem(storageKey, next); } catch { /* Browser storage may be unavailable. */ }
}

export function addMessages(target: AppLocale, additions: Messages): void {
  i18n.global.mergeLocaleMessage(target, additions);
}
