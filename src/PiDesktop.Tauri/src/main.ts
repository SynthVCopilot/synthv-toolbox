import "./styles.css";
import { api } from "./api";
import { icon } from "./icons";
import type {
  AppMode,
  BootstrapState,
  ChatMessage,
  ConversationSnapshot,
  ConversationSummary,
  McpServerConfig,
  OperationResult,
  Sv2AccountPrecheck,
  Sv2IsolationPreference,
  Sv2SessionProtection,
  Sv2ProfilesState,
  WorkflowResult,
} from "./types";

const root = document.querySelector<HTMLDivElement>("#app")!;
if (!root) throw new Error("Missing #app root");

type Page = "home" | "accounts" | "toolbox" | "copilot" | "components" | "bridge" | "mcp" | "settings";

interface Feature {
  id: string;
  title: string;
  description: string;
  icon: Parameters<typeof icon>[0];
  accent: string;
  base: string[];
  ai: string[];
  requirements: string[];
}

const features: Feature[] = [
  {
    id: "game-midi",
    title: "Game → MIDI",
    description: "对齐有词/演唱版与无词/伴奏版，提取单音音高和节奏并生成可导入的 MIDI。",
    icon: "audio",
    accent: "violet",
    base: ["基础音高轮廓", "确定性量化", "MIDI 导出"],
    ai: ["高级自动纠正", "置信度复核", "参数微调建议"],
    requirements: ["FFmpeg", "pi-audio"],
  },
  {
    id: "audio-insight",
    title: "音频分析",
    description: "提取 BPM、拍点、能量、调性与乐器倾向，为编曲和调声提供可靠事实。",
    icon: "sparkles",
    accent: "blue",
    base: ["BPM / 拍点", "能量曲线", "基础特征报告"],
    ai: ["风格归纳", "异常段落解释", "上下文建议"],
    requirements: ["FFmpeg", "pi-audio"],
  },
  {
    id: "project-tools",
    title: "SV 工程工具",
    description: "探测工程版本、轨道结构，并安全生成带参考音频轨的工程副本。",
    icon: "file",
    accent: "emerald",
    base: ["工程探测", "跨版本参考轨", "安全副本输出"],
    ai: ["工程风险解释", "变更方案生成", "批量操作复核"],
    requirements: ["CVRS"],
  },
  {
    id: "bridge-tools",
    title: "SynthV Bridge",
    description: "连接 Synthesizer V Studio，在严格工具边界内读取状态、编辑工程和执行审阅。",
    icon: "bridge",
    accent: "orange",
    base: ["安装与诊断", "连接状态", "人工工具操作"],
    ai: ["Copilot 工具调用", "多步任务编排", "结果自检"],
    requirements: ["Node.js", "SynthV Bridge"],
  },
];

let app: BootstrapState | undefined;
let page: Page = "home";
let busy = false;
let notice = "";
let error = "";
let conversations: ConversationSummary[] = [];
let conversation: ConversationSnapshot | undefined;
let profiles: Sv2ProfilesState | undefined;
let accountPrecheck: Sv2AccountPrecheck | undefined;
let activeWorkflow: Feature["id"] | undefined;
let workflowResult: WorkflowResult | undefined;
let pendingBlockedSwitchSlot: string | undefined;
let pendingConcurrentLaunchSlot: string | undefined;
let pendingConcurrentPrepare = false;
let downloadPollTimer: number | undefined;
let accountPrecheckTimer: number | undefined;

const pageMeta: Record<Page, { title: string; subtitle: string }> = {
  home: { title: "概览", subtitle: "查看环境状态与常用能力" },
  accounts: { title: "SV2 账号", subtitle: "普通切换与并发隔离，集中管理账号环境" },
  toolbox: { title: "超级工具箱", subtitle: "从音频到 SynthV 工程的一站式工作流" },
  copilot: { title: "Copilot", subtitle: "让 AI 在受控工具边界内协助工作" },
  components: { title: "组件中心", subtitle: "管理本地模型与运行组件" },
  bridge: { title: "SynthV Bridge", subtitle: "探测、安装、诊断并连接 Synthesizer V" },
  mcp: { title: "外部 MCP", subtitle: "接入额外的本地工具服务器" },
  settings: { title: "设置", subtitle: "调整运行模式与模型配置" },
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatError(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isolationPreferenceOptions(value: Sv2IsolationPreference, globalDefault: boolean): string {
  const options: Array<[Sv2IsolationPreference, string]> = [
    ["global", `跟随全局（${globalDefault ? "隔离" : "共享"}）`],
    ["on", "开启隔离"],
    ["off", "关闭隔离（共享）"],
  ];
  return options
    .map(([option, label]) => `<option value="${option}" ${value === option ? "selected" : ""}>${label}</option>`)
    .join("");
}

function setFeedback(result: OperationResult): void {
  if (result.succeeded) {
    notice = result.summary + (result.detail ? `\n${result.detail}` : "");
    error = "";
  } else {
    error = result.summary + (result.detail ? `\n${result.detail}` : "");
    notice = "";
  }
}

async function run(task: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  notice = "";
  error = "";
  render();
  try {
    await task();
  } catch (reason) {
    error = formatError(reason);
  } finally {
    busy = false;
    render();
  }
}

async function refresh(): Promise<void> {
  app = await api.bootstrap();
}

function scheduleDownloadPoll(): void {
  if (!app?.downloads.some((item) => ["queued", "downloading", "installing"].includes(item.status)) || downloadPollTimer !== undefined) return;
  downloadPollTimer = window.setTimeout(async () => {
    downloadPollTimer = undefined;
    if (!app) return;
    try {
      const wasActive = app.downloads.some((item) => ["queued", "downloading", "installing"].includes(item.status));
      app.downloads = await api.componentDownloads();
      const isActive = app.downloads.some((item) => ["queued", "downloading", "installing"].includes(item.status));
      if (wasActive && !isActive) await refresh();
      render();
    } catch (reason) {
      error = formatError(reason);
      render();
    }
  }, 700);
}

function scheduleAccountPrecheck(): void {
  if (page !== "toolbox" || accountPrecheckTimer !== undefined || (app?.platform !== "windows" && app?.platform !== "preview")) return;
  accountPrecheckTimer = window.setTimeout(async () => {
    accountPrecheckTimer = undefined;
    if (page !== "toolbox") return;
    try {
      accountPrecheck = await api.sv2AccountPrecheck();
      render();
    } catch (reason) {
      error = formatError(reason);
      render();
    }
  }, 3000);
}

function modePill(): string {
  if (!app) return "";
  return app.mode === "ai"
    ? `<span class="mode-pill ai">${icon("sparkles", 15)} AI 模式</span>`
    : `<span class="mode-pill">${icon("toolbox", 15)} 纯工具箱</span>`;
}

function navItem(target: Page, label: string, glyph: Parameters<typeof icon>[0]): string {
  return `<button class="nav-item ${page === target ? "active" : ""}" data-page="${target}">
    ${icon(glyph, 19)}<span>${label}</span>
  </button>`;
}

function render(): void {
  if (!app) return;
  if (!app.onboardingCompleted) {
    renderOnboarding();
    wireForms();
    return;
  }
  if (app.mode !== "ai" && (page === "copilot" || page === "mcp")) page = "home";
  const meta = pageMeta[page];
  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand" data-page="home">
          <div class="brand-mark small">π</div>
          <div><strong>SynthV Toolbox</strong><span>Creative utility suite</span></div>
        </div>
        <nav class="nav" aria-label="主导航">
          <span class="nav-label">工作区</span>
          ${navItem("home", "概览", "home")}
          ${app.platform === "windows" || app.platform === "preview" ? navItem("accounts", "SV2 账号", "users") : ""}
          ${navItem("toolbox", "超级工具箱", "toolbox")}
          ${app.mode === "ai" ? navItem("copilot", "Copilot", "bot") : ""}
          <span class="nav-label">系统</span>
          ${navItem("components", "组件中心", "boxes")}
          ${navItem("bridge", "SynthV Bridge", "bridge")}
          ${app.mode === "ai" ? navItem("mcp", "外部 MCP", "server") : ""}
        </nav>
        <div class="sidebar-footer">
          ${modePill()}
          ${navItem("settings", "设置", "settings")}
          <span class="version">v${escapeHtml(app.appVersion)} · ${escapeHtml(app.platform)}</span>
        </div>
      </aside>
      <main class="main">
        <header class="topbar" data-tauri-drag-region>
          <div><h1>${meta.title}</h1><p>${meta.subtitle}</p></div>
          <div class="top-actions">
            <span class="status-dot ${app.bridgeConnected ? "online" : ""}"></span>
            <span class="muted">Bridge ${app.bridgeConnected ? "已连接" : "未连接"}</span>
          </div>
        </header>
        <section class="content ${page === "copilot" ? "content-flush" : ""}">
          ${notice ? `<div class="toast success">${icon("check", 18)}<pre>${escapeHtml(notice)}</pre></div>` : ""}
          ${error ? `<div class="toast error"><pre>${escapeHtml(error)}</pre></div>` : ""}
          ${renderPage()}
        </section>
      </main>
      ${busy ? '<div class="busy-overlay" aria-label="处理中"><span class="spinner"></span></div>' : ""}
    </div>
    ${pendingBlockedSwitchSlot ? renderBlockedSwitchDialog() : pendingConcurrentLaunchSlot ? renderConcurrentDisclaimer() : ""}`;
  wireForms();
  scheduleDownloadPoll();
  scheduleAccountPrecheck();
}

function renderConcurrentDisclaimer(): string {
  const slot = profiles?.slots.find((item) => item.id === pendingConcurrentLaunchSlot);
  return `<div class="dialog-backdrop" role="presentation">
    <section class="fluent-dialog" role="alertdialog" aria-modal="true" aria-labelledby="concurrent-warning-title">
      <span class="dialog-icon">${icon("boxes", 24)}</span>
      <div><span class="eyebrow">首次使用风险告知</span><h2 id="concurrent-warning-title">并发隔离未被 Dreamtonics 官方承认</h2></div>
      <p>并发隔离已作为 SynthV Toolbox 的正式能力提供。本技术方案基于 Sandboxie 实现，会启动“${escapeHtml(slot?.displayName ?? "此槽位")}”的独立 SV2 实例，但 Dreamtonics 尚未公开承认或保证这种多实例使用方式。</p>
      <ul><li>并发隔离来自 SynthV Toolbox 与 Sandboxie 的进程树虚拟化，不是 Dreamtonics 原生多实例功能。</li><li>工具箱不修改 SV2 二进制、不绕过账户限制，也不拦截官方联网验证；这不等于 Dreamtonics 已确认其符合全部账号政策或服务条款。</li><li>截至当前版本，开发组没有收到因使用本功能而被官方警告或处理的记录；Dreamtonics 仍可能把它认定为不当或违规使用并采取措施。</li><li>启用即表示你已知晓上述情况、自担使用风险，并在适用法律允许的最大范围内不追究 SynthV Toolbox 开发组的直接或连带责任。</li><li>当前只启动 standalone；Sandbox 名称使用普通 <code>/box:名称</code>，不添加 <code>#</code>。</li></ul>
      <div class="dialog-actions"><button class="secondary" data-cancel-concurrent>取消</button><button class="primary" data-accept-concurrent>已知晓风险，继续启动</button></div>
    </section>
  </div>`;
}

function renderBlockedSwitchDialog(): string {
  const slot = profiles?.slots.find((item) => item.id === pendingBlockedSwitchSlot);
  const blockers = profiles?.blockers ?? [];
  const provider = profiles?.concurrentProvider;
  const concurrentRunning = Boolean(slot?.concurrent.runningPids.length);
  const canRunConcurrent = Boolean(provider?.available && !concurrentRunning);
  const concurrentLabel = slot?.concurrent.ready ? "以并发模式运行" : "准备并发副本并运行";
  return `<div class="dialog-backdrop" role="presentation">
    <section class="fluent-dialog switch-dialog" role="alertdialog" aria-modal="true" aria-labelledby="blocked-switch-title">
      <span class="dialog-icon danger">${icon("plug", 24)}</span>
      <div><span class="eyebrow">检测到运行中的程序</span><h2 id="blocked-switch-title">无法安全切换到“${escapeHtml(slot?.displayName ?? "此槽位")}”</h2></div>
      <p>下列程序正在使用当前 SV2 槽位。请先保存工程：强制切换会结束这些 PID 的整个进程树，未保存内容可能丢失；并发模式不会关闭当前程序。</p>
      <div class="dialog-process-list">${blockers.map((blocker) => `<div><span><strong>${escapeHtml(blocker.name)}</strong><small>${escapeHtml(blocker.reason)}</small></span><code>${blocker.pid ? `PID ${blocker.pid}` : "无可用 PID"}</code></div>`).join("")}</div>
      <p class="dialog-choice-note">${canRunConcurrent ? `${escapeHtml(provider?.name ?? "Sandboxie")} 已就绪；${slot?.concurrent.ready ? "将直接启动隔离实例。" : "会先复制该槽位的不透明数据副本，再启动隔离实例。"}` : concurrentRunning ? "此槽位的并发实例已经在运行。" : `并发模式不可用：${escapeHtml(provider?.detail ?? "未检测到隔离提供方。")}`}</p>
      <div class="dialog-actions"><button class="secondary" data-cancel-profile-switch>取消</button><button class="secondary" data-run-blocked-concurrent ${canRunConcurrent ? "" : "disabled"}>${concurrentLabel}</button><button class="danger-action" data-force-profile-switch>强制切换并启动</button></div>
    </section>
  </div>`;
}

async function launchConcurrentSlot(slotId: string, prepare: boolean): Promise<void> {
  if (prepare) profiles = await api.prepareSv2ConcurrentProfile(slotId);
  setFeedback(await api.launchSv2ConcurrentProfile(slotId));
  profiles = await api.sv2ProfileState();
}

function renderOnboarding(): void {
  root.innerHTML = `<main class="onboarding">
    <div class="onboarding-glow one"></div><div class="onboarding-glow two"></div>
    <section class="onboarding-card">
      <div class="onboarding-brand"><div class="brand-mark">π</div><span>SynthV Toolbox</span></div>
      <div class="eyebrow">首次启动 · 选择工作方式</div>
      <h1>一个工具箱，按你的方式工作。</h1>
      <p class="lead">随时可以在设置中切换。纯工具箱模式不会显示或启动任何 AI 功能。</p>
      <div class="mode-grid">
        <button class="mode-card" data-onboarding="toolbox">
          <span class="mode-icon slate">${icon("toolbox", 30)}</span>
          <span class="recommended">轻量 · 本地优先</span>
          <strong>纯工具箱模式</strong>
          <p>直接使用音频、MIDI、工程与 Bridge 工具。界面简洁，不需要模型配置。</p>
          <ul><li>${icon("check", 16)} 确定性基础处理</li><li>${icon("check", 16)} 不显示 AI / MCP 入口</li><li>${icon("check", 16)} 不启动模型运行时</li></ul>
          <span class="mode-cta">使用纯工具箱 ${icon("arrow", 17)}</span>
        </button>
        <button class="mode-card featured" data-onboarding="ai">
          <span class="mode-icon purple">${icon("sparkles", 30)}</span>
          <span class="recommended accent">完整体验</span>
          <strong>AI 模式</strong>
          <p>在完整工具箱之上加入 Copilot、智能增强、能力编排与外部 MCP。</p>
          <ul><li>${icon("check", 16)} 自动纠正与置信度复核</li><li>${icon("check", 16)} 高级参数微调建议</li><li>${icon("check", 16)} 外部 MCP 工具接入</li></ul>
          <span class="mode-cta">启用 AI 模式 ${icon("arrow", 17)}</span>
        </button>
      </div>
      <p class="privacy-note">${icon("plug", 16)} AI 模式只在你配置模型后发起请求；外部 MCP 服务器由你显式添加和启用。</p>
    </section>
  </main>${busy ? '<div class="busy-overlay"><span class="spinner"></span></div>' : ""}`;
}

function renderPage(): string {
  switch (page) {
    case "home": return renderHome();
    case "accounts": return renderAccounts();
    case "toolbox": return renderToolbox();
    case "copilot": return renderCopilot();
    case "components": return renderComponents();
    case "bridge": return renderBridge();
    case "mcp": return renderMcp();
    case "settings": return renderSettings();
  }
}

function renderAccounts(): string {
  if (!profiles) {
    return `<section class="panel quiet-panel"><span class="mode-icon purple">${icon("users", 24)}</span><div><h2>正在读取账号槽位</h2><p>只检查本机目录、占用进程和会话缓存是否存在。</p></div></section>`;
  }
  if (!profiles.supported) {
    return `<section class="panel quiet-panel"><span class="mode-icon slate">${icon("users", 24)}</span><div><h2>当前平台不支持账号槽位</h2><p>${escapeHtml(profiles.recoveryDetail)}</p></div></section>`;
  }
  const blockerPanel = profiles.blockers.length ? `<div class="warning-card profile-blockers"><span>${icon("plug", 23)}</span><div><strong>普通槽位暂时不能切换</strong><p>请先关闭下列普通 SV2 / 插件进程；已经准备好的隔离实例仍可单独启动。<br />${profiles.blockers.map((blocker) => `${escapeHtml(blocker.name)}${blocker.pid ? ` (PID ${blocker.pid})` : ""}：${escapeHtml(blocker.reason)}`).join("<br />")}</p></div></div>` : "";
  const concurrentProviderAvailable = profiles.concurrentProvider.available;
  if (profiles.recoveryRequired) {
    return `${blockerPanel}<div class="warning-card recovery-card"><span>${icon("refresh", 23)}</span><div><strong>槽位需要人工恢复</strong><p>${escapeHtml(profiles.recoveryDetail)}</p><p>工具箱没有删除或覆盖任何目录。请先备份下方路径，再检查目录实况。</p></div><button class="secondary" data-profile-refresh>${icon("refresh", 16)} 重新检查</button></div>
      <section class="panel"><dl class="detail-list"><div><dt>官方路径</dt><dd><code>${escapeHtml(profiles.canonicalPath)}</code></dd></div><div><dt>保管区</dt><dd><code>${escapeHtml(profiles.vaultPath)}</code></dd></div></dl></section>`;
  }
  const activeSlot = profiles.slots.find((slot) => slot.isActive);
  const preparedCount = profiles.slots.filter((slot) => slot.concurrent.ready).length;
  const runningSlots = profiles.slots.filter((slot) => slot.concurrent.runningPids.length > 0);
  const runningProcessCount = runningSlots.reduce((total, slot) => total + slot.concurrent.runningPids.length, 0);
  const providerLabel = [profiles.concurrentProvider.name, profiles.concurrentProvider.version].filter(Boolean).join(" ");
  const providerPath = profiles.concurrentProvider.installPath
    ? `<span class="provider-path" title="${escapeHtml(profiles.concurrentProvider.installPath)}">${icon("folder", 14)} ${escapeHtml(profiles.concurrentProvider.installPath)}</span>`
    : "";
  const launchModes = `<section class="launch-mode-grid" aria-label="启动方式">
    <article class="launch-mode-card default-mode">
      <div class="launch-mode-head"><span class="feature-icon blue">${icon("play", 22)}</span><div><span class="eyebrow">默认方式</span><h3>普通启动</h3></div><span class="launch-mode-state">${activeSlot ? `${escapeHtml(activeSlot.displayName)} · 当前默认` : "等待设置默认槽位"}</span></div>
      <p>适合日常使用。一次只挂载一个账号环境；从桌面快捷方式启动或双击 .svp 时，也会使用当前默认槽位。</p>
      <div class="launch-mode-facts"><span>${icon("check", 14)} 可继续使用原有启动方式</span><span>${icon("refresh", 14)} 切换前需退出普通实例</span></div>
    </article>
    <article class="launch-mode-card isolation-mode ${concurrentProviderAvailable ? "ready" : "unavailable"}">
      <div class="launch-mode-head"><span class="feature-icon violet">${icon("boxes", 22)}</span><div><span class="eyebrow">并发能力</span><h3>并发隔离</h3></div><span class="launch-mode-state ${concurrentProviderAvailable ? "online" : ""}">${concurrentProviderAvailable ? `${icon("check", 13)} 隔离核心就绪` : "需要 Sandboxie"}</span></div>
      ${concurrentProviderAvailable
        ? `<p>通过 ${escapeHtml(providerLabel)} 为每个槽位创建独立的文件、注册表和 IPC 环境，可与普通实例或其他隔离槽位同时运行。</p><div class="provider-integration"><strong>${icon("boxes", 15)} ${escapeHtml(providerLabel)}</strong><span>${preparedCount} 个已准备</span><span>${runningSlots.length} 个运行中${runningProcessCount ? ` · ${runningProcessCount} 个相关进程` : ""}</span>${providerPath}</div>`
        : `<p>${escapeHtml(profiles.concurrentProvider.detail)}</p><div class="provider-integration unavailable"><strong>普通账号切换仍可使用</strong><span>安装受支持版本后，重启工具箱即可自动集成。</span></div>`}
      <form id="concurrent-defaults-form" class="isolation-defaults-form">
        <div><strong>全局隔离默认值</strong><small>账户选择“跟随全局”时使用；修改后于下次隔离启动生效。</small></div>
        <label class="fluent-switch"><input name="appSettings" type="checkbox" ${profiles.concurrentDefaults.appSettings ? "checked" : ""} /><span></span>应用设置</label>
        <label class="fluent-switch"><input name="voiceLibraries" type="checkbox" ${profiles.concurrentDefaults.voiceLibraries ? "checked" : ""} /><span></span>声库数据</label>
        <button class="secondary" type="submit">保存默认值</button>
      </form>
      <small>本技术方案基于 Sandboxie 实现，不是 Dreamtonics 原生多实例功能。工具箱不代理或修改网络；持续验证、账号与工程同步仍由 SV2 和 Dreamtonics 官方服务处理。</small>
    </article>
  </section>`;
  const concurrentProviderDetail = profiles.concurrentProvider.detail;
  const concurrentDefaults = profiles.concurrentDefaults;
  const cards = profiles.slots.map((slot) => {
    const lastUsed = slot.lastActivatedAtUtc ? new Date(slot.lastActivatedAtUtc).toLocaleString("zh-CN") : "尚未启动";
    const initial = Array.from(slot.displayName)[0] ?? "S";
    const color = /^#[0-9a-f]{6}$/i.test(slot.color) ? slot.color : "#6D5CE7";
    const identity = [slot.username, slot.email].filter(Boolean);
    const concurrentRunning = slot.concurrent.runningPids.length > 0;
    const concurrentNeedsAttention = !slot.concurrent.ready && slot.concurrent.detail !== "尚未准备隔离副本。";
    const concurrentState = concurrentRunning ? "running" : slot.concurrent.ready ? "ready" : concurrentNeedsAttention ? "attention" : "pending";
    const concurrentStateLabel = concurrentRunning ? "运行中" : slot.concurrent.ready ? "已准备" : concurrentNeedsAttention ? "需要处理" : "未准备";
    const concurrentDescription = concurrentRunning
      ? `SV2 正在此隔离环境中运行（${slot.concurrent.runningPids.length} 个相关进程）。`
      : slot.concurrent.ready
        ? "独立副本已就绪，可与普通实例或其他隔离槽位同时运行。其本地变化不会自动覆盖普通槽位。"
        : concurrentNeedsAttention
          ? slot.concurrent.detail
          : "首次使用时，从此槽位建立一份独立副本；之后两套本地数据各自保存。";
    const concurrentControls = slot.concurrent.ready
      ? `<button class="secondary concurrent-launch" data-profile-concurrent-launch="${slot.id}" ${concurrentProviderAvailable && !concurrentRunning ? "" : `disabled title="${concurrentRunning ? "该隔离实例已经在运行" : "Sandboxie 隔离核心不可用"}"`}>${icon("boxes", 16)} ${concurrentRunning ? "隔离实例正在运行" : "启动隔离实例"}</button><button class="icon-plain" data-profile-concurrent-folder="${slot.id}" title="打开隔离数据目录" aria-label="打开 ${escapeHtml(slot.displayName)} 的隔离数据目录">${icon("folder", 17)}</button>`
      : `<button class="secondary concurrent-prepare" data-profile-concurrent-prepare="${slot.id}" ${concurrentProviderAvailable ? "" : `disabled title="${escapeHtml(concurrentProviderDetail)}"`}>${icon("download", 16)} 准备隔离实例</button>`;
    const content = slot.concurrent.content;
    const isolationContentForm = `<form class="isolation-content-form" data-profile-isolation-form="${slot.id}">
      <div class="isolation-content-heading"><strong>隔离内容</strong><span>下次隔离启动生效</span></div>
      <label>应用设置<select name="appSettings">${isolationPreferenceOptions(content.appSettings, concurrentDefaults.appSettings)}</select><small class="effective-state ${content.effectiveAppSettings ? "isolated" : "shared"}">${content.effectiveAppSettings ? "实际：独立" : "实际：共享宿主"}</small></label>
      <label>声库数据<select name="voiceLibraries">${isolationPreferenceOptions(content.voiceLibraries, concurrentDefaults.voiceLibraries)}</select><small class="effective-state ${content.effectiveVoiceLibraries ? "isolated" : "shared"}">${content.effectiveVoiceLibraries ? "实际：独立" : "实际：共享宿主"}</small></label>
      <button class="secondary" type="submit">保存隔离内容</button>
      <small class="isolation-content-note">关闭隔离会通过 Sandboxie <code>OpenFilePath</code> 直接使用宿主的对应目录；账号会话、WebView2、注册表和 IPC 仍保持隔离。</small>
    </form>`;
    return `<article class="profile-card ${slot.isActive ? "active" : ""}" style="--profile-color:${color}">
      <div class="profile-card-head"><span class="profile-avatar">${escapeHtml(initial)}</span><div><span class="eyebrow">账号槽位</span><h2>${escapeHtml(slot.displayName)}</h2>${identity.length ? `<span class="profile-identity">${identity.map(escapeHtml).join(" · ")}</span>` : '<span class="profile-identity empty">尚未填写用户名或邮箱</span>'}</div>${slot.isActive ? '<span class="profile-active-badge">当前默认</span>' : ""}</div>
      <div class="profile-meta"><span class="${slot.sessionCached ? "cached" : ""}">${slot.sessionCached ? `${icon("check", 14)} 登录缓存已存在` : `${icon("plug", 14)} 首次启动需要登录`}</span>${sessionProtectionBadge(slot.sessionProtection)}<span>${icon("refresh", 14)} 最近使用：${escapeHtml(lastUsed)}</span></div>
      <section class="profile-launch-block ordinary"><div class="profile-launch-heading"><div><span>普通启动</span><strong>${slot.isActive ? "使用当前默认环境" : "切换到此账号环境"}</strong></div>${slot.isActive ? '<span class="profile-route-badge">默认路由</span>' : ""}</div><p>${slot.isActive ? "桌面快捷方式和 .svp 文件也会继续使用此槽位。" : "会先安全切换默认槽位，再启动 SV2；现有普通实例需要先退出。"}</p><div class="profile-actions"><button class="primary" data-profile-launch="${slot.id}">${icon("play", 16)} ${slot.isActive ? "普通启动" : "切换并启动"}</button>${slot.isActive ? "" : `<button class="secondary" data-profile-activate="${slot.id}">设为默认</button>`}<button class="icon-plain profile-folder" data-profile-folder="${slot.id}" title="打开普通数据目录" aria-label="打开 ${escapeHtml(slot.displayName)} 的普通数据目录">${icon("folder", 18)}</button></div></section>
      <section class="profile-launch-block isolation ${slot.concurrent.ready ? "ready" : ""}"><div class="profile-launch-heading"><div><span>隔离启动</span><strong>独立运行此账号</strong></div><span class="profile-isolation-status ${concurrentState}">${concurrentRunning ? icon("plug", 12) : ""}${concurrentStateLabel}</span></div><p>${escapeHtml(concurrentDescription)}</p>${slot.concurrent.ready ? `<div class="session-guard-inline">${sessionProtectionBadge(slot.concurrentSessionProtection, "隔离环境 · ")}</div>` : ""}${isolationContentForm}<div class="profile-concurrent-actions">${concurrentControls}</div>${slot.concurrent.ready ? `<code title="隔离箱名称：${escapeHtml(slot.concurrent.boxName)}">${escapeHtml(slot.concurrent.boxName)}</code>` : ""}</section>
      <details class="profile-details"><summary>管理账号标签与存储位置 ${icon("arrow", 14)}</summary><div class="profile-details-body"><form class="profile-identity-form" data-profile-identity-form="${slot.id}"><label>用户名<input name="username" value="${escapeHtml(slot.username)}" maxlength="100" placeholder="用于区分账号的用户名" /></label><label>邮箱<input name="email" type="email" value="${escapeHtml(slot.email)}" maxlength="254" placeholder="name@example.com" /></label><button class="secondary">保存账号标签</button><small>这些标签由工具箱单独保存；不会读取或修改 SV2 的密码、Cookie 或 session。</small></form><form class="profile-rename" data-profile-rename-form="${slot.id}"><label>槽位显示名称<input value="${escapeHtml(slot.displayName)}" maxlength="64" required /></label><button class="secondary">保存</button></form><dl class="profile-storage-list"><div><dt>普通数据</dt><dd><code title="${escapeHtml(slot.dataPath)}">${escapeHtml(slot.dataPath)}</code></dd></div>${slot.concurrent.ready ? `<div><dt>隔离数据</dt><dd><code title="${escapeHtml(slot.concurrent.dataPath)}">${escapeHtml(slot.concurrent.dataPath)}</code></dd></div>` : ""}</dl></div></details>
    </article>`;
  }).join("");
  const importPanel = profiles.canImportCurrent ? `<section class="panel profile-setup"><div class="panel-heading"><span class="feature-icon emerald">${icon("folder", 24)}</span><div><h2>导入当前 SV2 环境</h2><p>现有官方数据目录尚未纳入槽位；导入不会移动账号文件。</p></div></div><form id="profile-import-form" class="profile-create-form"><input id="profile-import-name" maxlength="64" required placeholder="例如 主账号" /><button class="primary">导入为第一个槽位</button></form></section>` : "";
  const createPanel = `<section class="panel profile-setup"><div class="panel-heading"><span class="feature-icon blue">${icon("plus", 24)}</span><div><h2>添加账号槽位</h2><p>创建一个空环境；首次启动后，在 SV2 的 Dreamtonics 官方登录页面完成登录。</p></div></div><form id="profile-create-form" class="profile-create-form"><input id="profile-create-name" maxlength="64" required placeholder="例如 制作账号" /><button class="secondary">创建空槽位</button></form></section>`;
  return `<div class="profile-intro"><div><span class="eyebrow">SV2 ACCOUNT LAUNCHER</span><h2>像游戏启动器一样，选账号再启动</h2><p>普通启动负责默认账号切换；隔离启动负责多账号并发。用户名和邮箱是工具箱自己的可编辑标签，登录数据仍按原样、不透明地保存。</p><div class="profile-summary"><span>${profiles.slots.length} 个账号槽位</span><span>${preparedCount} 个隔离实例已准备</span>${runningSlots.length ? `<span class="running">${icon("plug", 13)} ${runningSlots.length} 个正在运行</span>` : ""}</div></div><button class="secondary" data-profile-refresh>${icon("refresh", 16)} 刷新状态</button></div>
    ${launchModes}
    ${blockerPanel}
    <div class="profile-grid">${cards || '<div class="empty-inline">还没有账号槽位。请导入当前环境或创建一个空槽位。</div>'}</div>
    <div class="profile-setup-grid">${importPanel}${createPanel}</div>
    <section class="panel profile-safety"><span>${icon("check", 18)}</span><div><strong>不伪造登录，也不绕过联网验证</strong><p>每个槽位默认按原样保存 license、WebView2、设置、数据库、缓存和脚本；用户可只将应用设置或声库数据改为共享宿主。普通切换只在相关进程退出后进行，官方网络连接保持不变。</p></div></section>`;
}

function renderHome(): string {
  if (!app) return "";
  const ready = app.components.filter((component) => component.installed).length;
  return `<div class="hero-panel">
      <div><span class="eyebrow">${app.mode === "ai" ? "AI workspace" : "Local utility workspace"}</span>
        <h2>${app.mode === "ai" ? "把重复操作交给 Copilot，创作判断留给你。" : "所有核心工具，集中在一个安静的工作区。"}</h2>
        <p>${app.mode === "ai" ? "从音频分析到 SynthV 工程操作，AI 只通过你启用的能力和 MCP 工具工作。" : "无需模型配置即可进行确定性的音频、MIDI、工程和 Bridge 操作。"}</p>
        <div class="hero-actions"><button class="primary" data-page="${app.mode === "ai" ? "copilot" : "toolbox"}">${icon(app.mode === "ai" ? "bot" : "toolbox", 18)} ${app.mode === "ai" ? "打开 Copilot" : "打开工具箱"}</button><button class="secondary" data-page="bridge">检查 Bridge</button></div>
      </div>
      <div class="hero-orb"><div>π</div><span>${app.mode === "ai" ? "COPILOT READY" : "LOCAL FIRST"}</span></div>
    </div>
    <div class="stats-grid">
      <article class="stat-card"><span>运行模式</span><strong>${app.mode === "ai" ? "AI 增强" : "纯工具箱"}</strong><small>${app.mode === "ai" ? (app.model?.tokenConfigured ? "模型凭据已配置" : "等待配置模型") : "模型运行时已停用"}</small></article>
      <article class="stat-card"><span>本地组件</span><strong>${ready} / ${app.components.length}</strong><small>已检测为可用</small></article>
      <article class="stat-card"><span>SynthV</span><strong>${app.installations.length ? "已发现" : "未发现"}</strong><small>${app.installations[0]?.displayName ?? "可手动选择 scripts 目录"}</small></article>
      <article class="stat-card"><span>工具连接</span><strong>${app.bridgeConnected ? "在线" : "离线"}</strong><small>${app.mode === "ai" ? `${app.mcpServers.filter((server) => server.enabled).length} 个 MCP 已启用` : "Bridge 可独立使用"}</small></article>
    </div>
    <section class="section-block"><div class="section-heading"><div><h2>快速开始</h2><p>继续最近的工作，或打开常用能力。</p></div></div>
      <div class="quick-grid">${features.slice(0, 3).map((feature) => `<button class="quick-card" data-feature="${feature.id}"><span class="feature-icon ${feature.accent}">${icon(feature.icon, 23)}</span><span><strong>${feature.title}</strong><small>${feature.base[0]} · ${feature.base[1]}</small></span>${icon("arrow", 18)}</button>`).join("")}</div>
    </section>`;
}

function sessionProtectionBadge(protection: Sv2SessionProtection, prefix = ""): string {
  const labels: Record<Sv2SessionProtection["status"], string> = {
    signInRequired: "登录后启用保护",
    ready: "登录态保护就绪",
    monitoring: "正在监测登录态",
    recoveryPending: "登录态等待恢复",
    restored: "登录态已自动恢复",
    attention: "登录态保护需处理",
  };
  const emphasis = ["recoveryPending", "attention"].includes(protection.status) ? " attention" : protection.status === "monitoring" ? " monitoring" : "";
  return `<span class="session-protection${emphasis}" title="${escapeHtml(protection.detail)}">${icon(protection.status === "recoveryPending" ? "refresh" : "check", 14)} ${prefix}${labels[protection.status]}</span>`;
}

function renderAccountPrecheck(): string {
  if (!app || (app.platform !== "windows" && app.platform !== "preview")) return "";
  if (!accountPrecheck) {
    return `<section class="account-precheck panel loading"><span class="feature-icon blue">${icon("refresh", 22)}</span><div><span class="eyebrow">ACCOUNT USE PRECHECK</span><h2>正在预检当前账号占用</h2><p>检查本机普通实例、插件、Sandboxie 实例和受保护会话是否失效。</p></div></section>`;
  }
  const check = accountPrecheck;
  const stateClass = check.recoveryPending ? "conflict" : check.localUse ? "in-use" : "clear";
  const localDetail = check.localProcesses.length
    ? check.localProcesses.map((process) => `${escapeHtml(process.name)}${process.pid ? ` · PID ${process.pid}` : ""}`).join("；")
    : check.concurrentPids.length ? `Sandboxie PID：${check.concurrentPids.join(", ")}` : "未发现本机进程";
  const remoteLabel = check.remoteUse === "detected" ? "已检测到远端占用迹象" : "远端状态等待 SV2 验证";
  return `<section class="account-precheck panel ${stateClass}">
    <span class="feature-icon ${check.recoveryPending ? "orange" : check.localUse ? "violet" : "emerald"}">${icon(check.recoveryPending ? "refresh" : check.localUse ? "plug" : "check", 22)}</span>
    <div class="account-precheck-main"><span class="eyebrow">ACCOUNT USE PRECHECK</span><h2>账号占用锁 · ${escapeHtml(check.displayName || "未设置账号")}</h2><p><strong>${escapeHtml(check.summary)}</strong> ${escapeHtml(check.detail)}</p><div class="precheck-facts"><span>${icon("users", 14)} ${localDetail}</span><span class="${check.remoteUse === "detected" ? "remote-detected" : ""}">${icon("plug", 14)} ${remoteLabel}</span><span>${icon("refresh", 14)} ${new Date(check.checkedAtUtc).toLocaleTimeString("zh-CN")}</span></div></div>
    <button class="secondary compact" data-account-precheck>${icon("refresh", 15)} 重新预检</button>
  </section>`;
}

function renderToolbox(): string {
  if (!app) return "";
  const current = app;
  return `${renderAccountPrecheck()}${activeWorkflow ? renderWorkflowPanel(activeWorkflow) : ""}<div class="section-heading"><div><h2>创作能力</h2><p>基础流程在两种模式下都可用；带 ${icon("sparkles", 14)} 的能力由后端限定为 AI 模式。</p></div></div>
    <div class="feature-grid">${features.map((feature) => `<article class="feature-card">
      <div class="feature-card-head"><span class="feature-icon ${feature.accent}">${icon(feature.icon, 25)}</span><span class="availability">基础可用</span></div>
      <h3>${feature.title}</h3><p>${feature.description}</p>
      <div class="capability-columns"><div><span>工具箱能力</span>${feature.base.map((item) => `<small>${icon("check", 14)} ${item}</small>`).join("")}</div><div class="ai-capabilities ${current.mode === "ai" ? "unlocked" : ""}"><span>${icon("sparkles", 14)} AI 增强</span>${feature.ai.map((item) => `<small>${item}</small>`).join("")}</div></div>
      <div class="feature-requirements">${feature.requirements.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
      <button class="card-action ${current.mode === "ai" ? "" : "restricted"}" data-feature="${feature.id}">${current.mode === "ai" ? "打开工作流" : "使用基础流程"} ${icon("arrow", 17)}</button>
    </article>`).join("")}</div>
    ${current.mode === "toolbox" ? `<div class="upgrade-banner"><span class="mode-icon purple">${icon("sparkles", 24)}</span><div><strong>需要自动纠正、置信度复核或高级参数微调？</strong><p>切换到 AI 模式即可在现有工具之上启用智能增强。</p></div><button class="secondary" data-enable-ai>了解 AI 模式</button></div>` : ""}`;
}

function renderWorkflowPanel(id: string): string {
  if (!app) return "";
  const ai = app.mode === "ai";
  let form = "";
  if (id === "game-midi") {
    form = `<form id="game-midi-form" class="workflow-form">
      <label>有词/演唱音频路径<input id="game-vocal" required placeholder="C:\\Audio\\song-vocal.wav 或 /Users/me/song-vocal.wav" /></label>
      <label>同版本无词/伴奏路径<input id="game-inst" required placeholder="与有词版本时间轴对齐的音频" /></label>
      <label>输出 MIDI 文件名<input id="game-output" required value="game-vocal.mid" /></label>
      ${ai ? `<label>匹配容差（秒）<input id="game-tolerance" type="number" min="0.02" max="0.25" step="0.01" value="0.08" /></label><label class="checkbox workflow-check"><input id="game-advanced" type="checkbox" checked /> 多参数寻优、自动纠正与高级置信度检查</label>` : `<div class="mode-limit">纯工具箱使用固定 0.08 秒容差，不执行高级自动纠正、置信度检查或额外微调。</div>`}
      <button class="primary">${ai ? `${icon("sparkles", 16)} 运行增强提取` : `${icon("play", 16)} 运行基础提取`}</button>
    </form>`;
  } else if (id === "audio-insight") {
    form = `<form id="audio-probe-form" class="workflow-form">
      <label>音频文件路径<input id="audio-path" required placeholder="选择待分析的 WAV、FLAC、MP3、M4A、AAC、OGG 或 OPUS" /></label>
      ${ai ? `<label class="checkbox workflow-check"><input id="audio-advanced" type="checkbox" checked /> 启用音符统计、PANNs 乐器/风格倾向和人声置信判断</label>` : `<div class="mode-limit">纯工具箱只输出 BPM、调性、能量与频谱趋势；不下载或运行高级模型。</div>`}
      <button class="primary">${icon(ai ? "sparkles" : "play", 16)} 开始分析</button>
    </form>`;
  } else if (id === "project-tools") {
    form = `<div class="workflow-split"><form id="project-probe-form" class="workflow-form"><h3>只读工程探测</h3><label>.svp 工程路径<input id="project-probe-path" required placeholder="目标 .svp 文件" /></label><button class="primary">${icon("file", 16)} 探测版本与轨道</button></form>
      <form id="project-reference-form" class="workflow-form"><h3>生成参考轨副本</h3><label>目标 .svp 工程路径<input id="project-ref-path" required /></label><label>参考音频路径<input id="project-ref-audio" required /></label><div class="workflow-pair"><label>参考轨名称<input id="project-ref-name" required value="CVRS Reference" /></label><label>起始秒数<input id="project-ref-begin" type="number" min="0" max="86400" step="0.01" value="0" /></label></div><label>输出工程文件名<input id="project-ref-output" required value="project_cvrs.svp" /></label><button class="secondary">${icon("plus", 16)} 生成安全副本</button></form></div>`;
  }
  const feature = features.find((item) => item.id === id);
  const result = workflowResult ? `<section class="workflow-result"><div class="result-head"><div><span class="availability">运行完成</span><h3>${escapeHtml(workflowResult.summary)}</h3></div>${workflowResult.outputPath ? `<code>${escapeHtml(workflowResult.outputPath)}</code>` : ""}</div><pre>${escapeHtml(JSON.stringify(workflowResult.data, null, 2))}</pre>${workflowResult.aiReview ? `<div class="ai-review"><strong>${icon("sparkles", 15)} AI 复核</strong><p>${escapeHtml(workflowResult.aiReview)}</p></div>` : ai ? `<button class="secondary" data-review-workflow>${icon("sparkles", 16)} 用已配置模型复核结果</button>` : ""}</section>` : "";
  return `<section class="panel workflow-panel"><div class="workflow-heading"><span class="feature-icon ${feature?.accent ?? "violet"}">${icon(feature?.icon ?? "toolbox", 25)}</span><div><span class="eyebrow">ACTIVE WORKFLOW</span><h2>${escapeHtml(feature?.title ?? "工作流")}</h2><p>${escapeHtml(feature?.description ?? "")}</p></div><button class="icon-plain" data-close-workflow title="关闭">×</button></div>${form}${result}</section>`;
}

function renderCopilot(): string {
  const messages = conversation?.messages.filter((message) => message.role === "user" || message.role === "assistant") ?? [];
  return `<div class="copilot-layout">
    <aside class="sessions-panel"><button class="primary full" data-new-conversation>${icon("plus", 17)} 新建对话</button><span class="nav-label">历史对话</span><div class="session-list">${conversations.length ? conversations.map((item) => `<button class="session-item ${conversation?.id === item.id ? "active" : ""}" data-conversation="${escapeHtml(item.id)}"><strong>${escapeHtml(item.title)}</strong><small>${item.messageCount} 条消息 · ${escapeHtml(item.updatedAt.slice(0, 10))}</small></button>`).join("") : '<p class="empty-small">还没有历史对话</p>'}</div></aside>
    <section class="chat-panel">
      <div class="chat-header"><div><strong>${escapeHtml(conversation?.title ?? "新对话")}</strong><small>Copilot 只会调用已启用的能力</small></div><span class="mode-pill ai">${icon("sparkles", 14)} AI</span></div>
      <div class="messages">${messages.length ? messages.map(renderMessage).join("") : `<div class="empty-chat"><span class="mode-icon purple">${icon("bot", 30)}</span><h2>今天想完成什么？</h2><p>可以从分析音频、检查工程或连接 SynthV 开始。</p><div class="prompt-chips"><button data-prompt="分析这段音频的 BPM、调性和能量变化">分析音频特征</button><button data-prompt="检查当前 SynthV 工程并总结轨道结构">检查 SynthV 工程</button><button data-prompt="帮我规划从人声录音到 MIDI 的工作流">规划 Game → MIDI</button></div></div>`}</div>
      <form id="chat-form" class="composer"><textarea id="chat-input" rows="2" placeholder="向 Copilot 描述任务…（Ctrl/⌘ + Enter 发送）"></textarea><button class="primary icon-button" title="发送">${icon("send", 19)}</button><span>Copilot 可能出错，重要修改请在 SynthV 中复核。</span></form>
    </section>
  </div>`;
}

function renderMessage(message: ChatMessage): string {
  const mine = message.role === "user";
  return `<div class="message ${mine ? "user" : "assistant"}"><span class="avatar">${mine ? "你" : "π"}</span><div><small>${mine ? "你" : "Copilot"}</small><p>${escapeHtml(message.content)}</p></div></div>`;
}

function renderComponents(): string {
  if (!app) return "";
  const statusLabel = { queued: "排队中", downloading: "aria2 下载中", installing: "安装中", completed: "已完成", failed: "失败" } as const;
  const activeDownloads = app.downloads.filter((item) => item.status !== "completed");
  const queue = activeDownloads.length ? `<section class="download-queue panel">
    <div class="section-heading"><div><h2>下载队列</h2><p>队列串行执行；远程组件固定版本并由 aria2 + SHA-256 校验。</p></div><span class="queue-count">${activeDownloads.length}</span></div>
    <div class="download-list">${activeDownloads.map((item) => `<article class="download-item ${item.status}">
      <span class="component-status ${item.status === "completed" ? "ready" : ""}">${item.status === "failed" ? icon("plug", 17) : icon("download", 17)}</span>
      <div><div class="download-title"><strong>${escapeHtml(item.displayName)}</strong><span>${statusLabel[item.status]}</span></div><div class="progress-track"><span style="width:${Math.max(2, Math.min(100, item.progress))}%"></span></div><small>${escapeHtml(item.detail)}</small></div>
    </article>`).join("")}</div>
  </section>` : "";
  return `${queue}<div class="section-heading"><div><h2>本地组件</h2><p>下载任务会加入队列；无固定来源与 SHA-256 的组件会拒绝安装。</p></div></div>
    <div class="component-list">${app.components.map((component) => {
      const task = app?.downloads.find((item) => item.componentId === component.id && ["queued", "downloading", "installing"].includes(item.status));
      const label = component.installed ? "已就绪" : component.downloaded ? "打开安装包位置" : task ? statusLabel[task.status] : component.installable ? "加入队列" : "当前平台不可用";
      const action = component.downloaded
        ? `data-open-component-download="${escapeHtml(component.id)}"`
        : `data-install-component="${escapeHtml(component.id)}"`;
      return `<article class="component-row"><span class="component-status ${component.installed || component.downloaded ? "ready" : ""}">${component.installed ? icon("check", 18) : icon("download", 18)}</span><div><h3>${escapeHtml(component.displayName)}</h3><p>${escapeHtml(component.description)}</p><div class="tags"><span>${escapeHtml(component.audience)}</span><span>${escapeHtml(component.status)}</span></div></div><button class="secondary" ${action} ${component.installed || task || (!component.installable && !component.downloaded) ? "disabled" : ""}>${label}</button></article>`;
    }).join("")}</div>`;
}

function renderBridge(): string {
  if (!app) return "";
  const applicationLocations = app.installations.filter((item) => item.installPath);
  const scriptsLocations = app.installations.filter((item) => item.scriptsPath);
  const applicationList = applicationLocations.length
    ? applicationLocations.map((item) => `<article class="installation-item"><span class="status-dot online"></span><span><strong>${escapeHtml(item.displayName)}</strong><small title="${escapeHtml(item.installPath ?? "")}">${escapeHtml(item.installPath ?? "")}</small></span><span class="location-source">${escapeHtml(item.source)}</span></article>`).join("")
    : '<div class="empty-inline compact-empty">没有发现 Synthesizer V 应用安装。</div>';
  const scriptsList = scriptsLocations.length
    ? scriptsLocations.map((item) => `<button class="installation-item" data-scripts="${escapeHtml(item.scriptsPath ?? "")}" title="选择此 scripts 目录作为 Bridge 安装目标"><span class="status-dot online"></span><span><strong>${escapeHtml(item.displayName)}</strong><small title="${escapeHtml(item.scriptsPath ?? "")}">${escapeHtml(item.scriptsPath ?? "")}</small></span><span class="location-action">选择</span></button>`).join("")
    : '<div class="empty-inline compact-empty">没有发现 scripts 目录，可以在右侧手动填写。</div>';
  return `<div class="bridge-grid"><section class="panel"><div class="panel-heading"><span class="feature-icon orange">${icon("bridge", 25)}</span><div><h2>Synthesizer V 探测</h2><p>Windows 与 macOS 使用各自的标准路径，只进行只读检查。</p></div><button class="secondary compact" data-scan>${icon("refresh", 16)} 重新探测</button></div>
    <div class="detection-groups">
      <section class="detection-group"><div class="detection-group-title"><strong>应用安装</strong><span>${applicationLocations.length}</span></div><div class="installation-list">${applicationList}</div></section>
      <section class="detection-group"><div class="detection-group-title"><strong>Scripts 目录</strong><span>${scriptsLocations.length}</span></div><p class="detection-group-help">选择一个目录后，会填入右侧的 Bridge 安装目标。</p><div class="installation-list">${scriptsList}</div></section>
    </div></section>
    <section class="panel"><div class="panel-heading"><span class="feature-icon blue">${icon("plug", 25)}</span><div><h2>Bridge 管理</h2><p>安装器只写入你指定的 scripts 目录，不开放网络端口。</p></div></div>
      <form id="bridge-form" class="form-stack"><label>Scripts 目录<input id="scripts-path" value="${escapeHtml(app.scriptsPath ?? app.installations.find((item) => item.scriptsPath)?.scriptsPath ?? "")}" placeholder="选择或粘贴 SynthV scripts 目录" /></label><div class="button-row"><button class="primary" value="install">安装 / 更新</button><button class="secondary" value="diagnose">检查安装</button><button class="secondary" value="connect">测试连接</button></div></form>
      <div class="inline-status"><span class="status-dot ${app.bridgeBundled ? "online" : ""}"></span><span>${app.bridgeBundled ? "内置 Bridge 资源已就绪" : "当前构建未包含 Bridge 资源"}</span></div>
    </section></div>`;
}

function renderMcp(): string {
  if (!app) return "";
  return `<div class="warning-card"><span>${icon("server", 23)}</span><div><strong>MCP 服务器可以启动本地进程</strong><p>只添加你信任的命令。服务器必须显式启用后才会向 Copilot 暴露工具。</p></div></div>
    <div class="mcp-layout"><section class="panel"><div class="section-heading"><div><h2>已配置服务器</h2><p>${app.mcpServers.length} 个配置</p></div></div><div class="mcp-list">${app.mcpServers.length ? app.mcpServers.map((server) => `<article><span class="server-icon">${icon("server", 20)}</span><div><strong>${escapeHtml(server.name)}</strong><code>${escapeHtml([server.command, ...server.args].join(" "))}</code></div><span class="availability">${server.enabled ? "已启用" : "已停用"}</span><button class="icon-plain" data-test-mcp="${escapeHtml(server.id)}" title="测试">${icon("refresh", 17)}</button><button class="icon-plain danger" data-delete-mcp="${escapeHtml(server.id)}" title="删除">${icon("trash", 17)}</button></article>`).join("") : '<div class="empty-inline">尚未添加外部 MCP 服务器。</div>'}</div></section>
    <section class="panel"><div class="section-heading"><div><h2>添加 stdio MCP</h2><p>进程通过私有 stdin/stdout 与 Rust 后端通信。</p></div></div><form id="mcp-form" class="form-stack"><label>显示名称<input id="mcp-name" required placeholder="例如 Filesystem tools" /></label><label>命令<input id="mcp-command" required placeholder="例如 npx、node 或绝对路径" /></label><label>参数（每行一个）<textarea id="mcp-args" rows="4" placeholder="-y\n@modelcontextprotocol/server-filesystem\n/path/to/workspace"></textarea></label><label class="checkbox"><input id="mcp-enabled" type="checkbox" checked /> 保存后立即启用</label><button class="primary">添加服务器</button></form></section></div>`;
}

function renderSettings(): string {
  if (!app) return "";
  return `<div class="settings-layout"><section class="panel"><div class="section-heading"><div><h2>运行模式</h2><p>切换后导航与 Rust 后端能力会同时更新。</p></div></div><div class="mode-setting"><button class="setting-choice ${app.mode === "toolbox" ? "active" : ""}" data-set-mode="toolbox"><span class="mode-icon slate">${icon("toolbox", 23)}</span><span><strong>纯工具箱</strong><small>确定性基础流程，不启动 AI</small></span>${app.mode === "toolbox" ? icon("check", 20) : ""}</button><button class="setting-choice ${app.mode === "ai" ? "active" : ""}" data-set-mode="ai"><span class="mode-icon purple">${icon("sparkles", 23)}</span><span><strong>AI 模式</strong><small>Copilot、智能增强与 MCP</small></span>${app.mode === "ai" ? icon("check", 20) : ""}</button></div></section>
    ${app.mode === "ai" ? `<section class="panel"><div class="section-heading"><div><h2>模型连接</h2><p>令牌写入本机用户配置，不会返回给前端。</p></div></div><form id="model-form" class="form-stack"><label>Anthropic 兼容 API 地址<input id="model-url" type="url" required value="${escapeHtml(app.model?.baseUrl ?? "https://api.anthropic.com")}" /></label><label>模型 ID<input id="model-id" required value="${escapeHtml(app.model?.model ?? "")}" placeholder="例如 claude-sonnet-4-5" /></label><label>访问令牌<input id="model-token" type="password" placeholder="${app.model?.tokenConfigured ? "已保存；留空则保留" : "输入访问令牌"}" /></label><button class="primary">保存模型设置</button></form></section>` : `<section class="panel quiet-panel"><span class="mode-icon slate">${icon("bot", 24)}</span><div><h2>AI 运行时已关闭</h2><p>当前不会显示 Copilot、模型或 MCP 设置，也不会向模型端点发送请求。</p></div></section>`}
    <section class="panel"><div class="section-heading"><div><h2>数据与平台</h2><p>配置和历史使用统一的跨平台用户目录。</p></div></div><dl class="detail-list"><div><dt>平台</dt><dd>${escapeHtml(app.platform)}</dd></div><div><dt>配置</dt><dd><code>${escapeHtml(app.configPath)}</code></dd></div><div><dt>应用版本</dt><dd>${escapeHtml(app.appVersion)}</dd></div></dl></section></div>`;
}

function wireForms(): void {
  document.querySelector<HTMLFormElement>("#game-midi-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const vocalPath = document.querySelector<HTMLInputElement>("#game-vocal")?.value.trim() ?? "";
    const instrumentalPath = document.querySelector<HTMLInputElement>("#game-inst")?.value.trim() ?? "";
    const outputName = document.querySelector<HTMLInputElement>("#game-output")?.value.trim() ?? "game-vocal.mid";
    const tolerance = Number(document.querySelector<HTMLInputElement>("#game-tolerance")?.value ?? "0.08");
    const advanced = app?.mode === "ai" && (document.querySelector<HTMLInputElement>("#game-advanced")?.checked ?? false);
    void run(async () => { workflowResult = await api.runGameToMidi(vocalPath, instrumentalPath, outputName, tolerance, advanced); notice = workflowResult.summary; });
  });
  document.querySelector<HTMLFormElement>("#audio-probe-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const audioPath = document.querySelector<HTMLInputElement>("#audio-path")?.value.trim() ?? "";
    const advanced = app?.mode === "ai" && (document.querySelector<HTMLInputElement>("#audio-advanced")?.checked ?? false);
    void run(async () => { workflowResult = await api.runAudioProbe(audioPath, advanced); notice = workflowResult.summary; });
  });
  document.querySelector<HTMLFormElement>("#project-probe-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const projectPath = document.querySelector<HTMLInputElement>("#project-probe-path")?.value.trim() ?? "";
    void run(async () => { workflowResult = await api.runProjectProbe(projectPath); notice = workflowResult.summary; });
  });
  document.querySelector<HTMLFormElement>("#project-reference-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const projectPath = document.querySelector<HTMLInputElement>("#project-ref-path")?.value.trim() ?? "";
    const audioPath = document.querySelector<HTMLInputElement>("#project-ref-audio")?.value.trim() ?? "";
    const trackName = document.querySelector<HTMLInputElement>("#project-ref-name")?.value.trim() ?? "";
    const beginSeconds = Number(document.querySelector<HTMLInputElement>("#project-ref-begin")?.value ?? "0");
    const outputName = document.querySelector<HTMLInputElement>("#project-ref-output")?.value.trim() ?? "project_cvrs.svp";
    void run(async () => { workflowResult = await api.addProjectReference(projectPath, audioPath, trackName, beginSeconds, outputName); notice = workflowResult.summary; });
  });
  document.querySelector<HTMLFormElement>("#profile-import-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const displayName = document.querySelector<HTMLInputElement>("#profile-import-name")?.value.trim() ?? "";
    if (!displayName) return;
    void run(async () => { profiles = await api.importCurrentSv2Profile(displayName); notice = `已导入“${displayName}”。`; });
  });
  document.querySelector<HTMLFormElement>("#profile-create-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const displayName = document.querySelector<HTMLInputElement>("#profile-create-name")?.value.trim() ?? "";
    if (!displayName) return;
    void run(async () => { profiles = await api.createSv2Profile(displayName); notice = `已创建“${displayName}”。`; });
  });
  document.querySelectorAll<HTMLFormElement>("[data-profile-rename-form]").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    const slotId = form.dataset.profileRenameForm ?? "";
    const displayName = form.querySelector<HTMLInputElement>("input")?.value.trim() ?? "";
    if (!slotId || !displayName) return;
    void run(async () => { profiles = await api.renameSv2Profile(slotId, displayName); notice = "槽位名称已保存。"; });
  }));
  document.querySelectorAll<HTMLFormElement>("[data-profile-identity-form]").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    const slotId = form.dataset.profileIdentityForm ?? "";
    const username = form.querySelector<HTMLInputElement>('[name="username"]')?.value.trim() ?? "";
    const email = form.querySelector<HTMLInputElement>('[name="email"]')?.value.trim() ?? "";
    if (!slotId) return;
    void run(async () => { profiles = await api.updateSv2ProfileIdentity(slotId, username, email); notice = "账号用户名和邮箱标签已保存。"; });
  }));
  document.querySelector<HTMLFormElement>("#concurrent-defaults-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const appSettings = form.querySelector<HTMLInputElement>('[name="appSettings"]')?.checked ?? true;
    const voiceLibraries = form.querySelector<HTMLInputElement>('[name="voiceLibraries"]')?.checked ?? true;
    void run(async () => {
      profiles = await api.updateSv2ConcurrentDefaults(appSettings, voiceLibraries);
      notice = "全局隔离默认值已保存，将在各账户下次隔离启动时生效。";
    });
  });
  document.querySelectorAll<HTMLFormElement>("[data-profile-isolation-form]").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    const slotId = form.dataset.profileIsolationForm ?? "";
    const appSettings = form.querySelector<HTMLSelectElement>('[name="appSettings"]')?.value as Sv2IsolationPreference;
    const voiceLibraries = form.querySelector<HTMLSelectElement>('[name="voiceLibraries"]')?.value as Sv2IsolationPreference;
    if (!slotId || !appSettings || !voiceLibraries) return;
    void run(async () => {
      profiles = await api.updateSv2ConcurrentContent(slotId, appSettings, voiceLibraries);
      notice = "该账户的隔离内容策略已保存，将在下次隔离启动时生效。";
    });
  }));
  document.querySelector<HTMLFormElement>("#chat-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector<HTMLTextAreaElement>("#chat-input")?.value.trim();
    if (!input) return;
    void sendPrompt(input);
  });
  document.querySelector<HTMLTextAreaElement>("#chat-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      const input = (event.currentTarget as HTMLTextAreaElement).value.trim();
      if (input) void sendPrompt(input);
    }
  });
  document.querySelector<HTMLFormElement>("#model-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const baseUrl = document.querySelector<HTMLInputElement>("#model-url")?.value.trim() ?? "";
    const model = document.querySelector<HTMLInputElement>("#model-id")?.value.trim() ?? "";
    const token = document.querySelector<HTMLInputElement>("#model-token")?.value.trim();
    void run(async () => { app = await api.saveModel(baseUrl, model, token); notice = "模型设置已保存。"; });
  });
  document.querySelector<HTMLFormElement>("#mcp-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.querySelector<HTMLInputElement>("#mcp-name")?.value.trim() ?? "";
    const command = document.querySelector<HTMLInputElement>("#mcp-command")?.value.trim() ?? "";
    const args = (document.querySelector<HTMLTextAreaElement>("#mcp-args")?.value ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const enabled = document.querySelector<HTMLInputElement>("#mcp-enabled")?.checked ?? false;
    const server: McpServerConfig = { id: crypto.randomUUID(), name, command, args, enabled };
    void run(async () => { app = await api.saveMcpServer(server); notice = `${name} 已添加。`; });
  });
  document.querySelector<HTMLFormElement>("#bridge-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    const action = submitter?.value;
    const scriptsPath = document.querySelector<HTMLInputElement>("#scripts-path")?.value.trim() ?? "";
    void run(async () => {
      if (action === "connect") setFeedback(await api.connectBridge());
      else if (action === "diagnose") setFeedback(await api.diagnoseBridge(scriptsPath));
      else { await api.saveScriptsPath(scriptsPath); setFeedback(await api.installBridge(scriptsPath)); }
      await refresh();
    });
  });
}

async function sendPrompt(input: string): Promise<void> {
  await run(async () => {
    if (!conversation) conversation = await api.newConversation();
    const optimistic: ChatMessage = { role: "user", content: input };
    conversation.messages.push(optimistic);
    render();
    const added = await api.sendMessage(input);
    conversation.messages = conversation.messages.filter((message) => message !== optimistic);
    conversation.messages.push(...added);
    conversations = await api.listConversations();
  });
}

document.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("button, [data-page], [data-onboarding]");
  if (!target || target.hasAttribute("disabled")) return;
  if (target.hasAttribute("data-cancel-profile-switch")) {
    pendingBlockedSwitchSlot = undefined;
    render();
    return;
  }
  if (target.hasAttribute("data-force-profile-switch")) {
    const slotId = pendingBlockedSwitchSlot;
    if (!slotId) return;
    pendingBlockedSwitchSlot = undefined;
    void run(async () => {
      setFeedback(await api.forceLaunchSv2Profile(slotId));
      profiles = await api.sv2ProfileState();
    });
    return;
  }
  if (target.hasAttribute("data-run-blocked-concurrent")) {
    const slotId = pendingBlockedSwitchSlot;
    const slot = profiles?.slots.find((item) => item.id === slotId);
    if (!slotId || !slot) return;
    const prepare = !slot.concurrent.ready;
    pendingBlockedSwitchSlot = undefined;
    if (!app?.concurrentDisclaimerAccepted) {
      pendingConcurrentLaunchSlot = slotId;
      pendingConcurrentPrepare = prepare;
      render();
    } else {
      void run(async () => { await launchConcurrentSlot(slotId, prepare); });
    }
    return;
  }
  if (target.hasAttribute("data-cancel-concurrent")) {
    pendingConcurrentLaunchSlot = undefined;
    pendingConcurrentPrepare = false;
    render();
    return;
  }
  if (target.hasAttribute("data-accept-concurrent")) {
    const slotId = pendingConcurrentLaunchSlot;
    if (!slotId) return;
    const prepare = pendingConcurrentPrepare;
    pendingConcurrentLaunchSlot = undefined;
    pendingConcurrentPrepare = false;
    void run(async () => {
      app = await api.acceptSv2ConcurrentDisclaimer();
      await launchConcurrentSlot(slotId, prepare);
    });
    return;
  }
  const targetPage = target.dataset.page as Page | undefined;
  if (targetPage) {
    page = targetPage;
    notice = "";
    error = "";
    if (page === "copilot") void run(async () => { conversations = await api.listConversations(); });
    else if (page === "accounts") void run(async () => { profiles = await api.sv2ProfileState(); });
    else if (page === "toolbox" && (app?.platform === "windows" || app?.platform === "preview")) void run(async () => { accountPrecheck = await api.sv2AccountPrecheck(); });
    else render();
    return;
  }
  const onboarding = target.dataset.onboarding as AppMode | undefined;
  if (onboarding) { void run(async () => { app = await api.completeOnboarding(onboarding); page = "home"; }); return; }
  const mode = target.dataset.setMode as AppMode | undefined;
  if (mode) { void run(async () => { app = await api.setMode(mode); notice = `已切换到${mode === "ai" ? " AI 模式" : "纯工具箱模式"}。`; }); return; }
  if (target.hasAttribute("data-enable-ai")) { page = "settings"; render(); return; }
  if (target.dataset.feature) {
    if (target.dataset.feature === "bridge-tools") { page = "bridge"; render(); return; }
    page = "toolbox";
    activeWorkflow = target.dataset.feature;
    workflowResult = undefined;
    notice = "";
    if (app?.platform === "windows" || app?.platform === "preview") void run(async () => { accountPrecheck = await api.sv2AccountPrecheck(); });
    else render();
    return;
  }
  if (target.hasAttribute("data-close-workflow")) { activeWorkflow = undefined; workflowResult = undefined; render(); return; }
  if (target.hasAttribute("data-review-workflow") && workflowResult) {
    void run(async () => { if (workflowResult) workflowResult.aiReview = await api.reviewWorkflow(workflowResult.kind, workflowResult.data); });
    return;
  }
  if (target.hasAttribute("data-scan")) { void run(async () => { if (app) app.installations = await api.scanSynthV(); notice = "探测完成。"; }); return; }
  if (target.hasAttribute("data-account-precheck")) { void run(async () => { accountPrecheck = await api.sv2AccountPrecheck(); notice = "当前账号占用预检已刷新。"; }); return; }
  if (target.hasAttribute("data-profile-refresh")) { void run(async () => { profiles = await api.sv2ProfileState(); notice = "账号槽位状态已刷新。"; }); return; }
  if (target.dataset.profileLaunch) {
    const slotId = target.dataset.profileLaunch;
    const slot = profiles?.slots.find((item) => item.id === slotId);
    if (slot && !slot.isActive && profiles?.blockers.length) {
      pendingBlockedSwitchSlot = slotId;
      render();
    } else {
      void run(async () => { setFeedback(await api.launchSv2Profile(slotId)); profiles = await api.sv2ProfileState(); });
    }
    return;
  }
  if (target.dataset.profileActivate) { void run(async () => { profiles = await api.activateSv2Profile(target.dataset.profileActivate ?? ""); notice = "默认账号槽位已切换。"; }); return; }
  if (target.dataset.profileFolder) { void run(async () => { setFeedback(await api.openSv2ProfileFolder(target.dataset.profileFolder ?? "")); }); return; }
  if (target.dataset.profileConcurrentPrepare) { void run(async () => { profiles = await api.prepareSv2ConcurrentProfile(target.dataset.profileConcurrentPrepare ?? ""); notice = "隔离副本已准备，可以并发启动。"; }); return; }
  if (target.dataset.profileConcurrentLaunch) {
    const slotId = target.dataset.profileConcurrentLaunch;
    if (!app?.concurrentDisclaimerAccepted) {
      pendingConcurrentLaunchSlot = slotId;
      pendingConcurrentPrepare = false;
      render();
    } else {
      void run(async () => { await launchConcurrentSlot(slotId, false); });
    }
    return;
  }
  if (target.dataset.profileConcurrentFolder) { void run(async () => { setFeedback(await api.openSv2ConcurrentFolder(target.dataset.profileConcurrentFolder ?? "")); }); return; }
  if (target.dataset.scripts !== undefined) {
    const input = document.querySelector<HTMLInputElement>("#scripts-path");
    if (input && target.dataset.scripts) input.value = target.dataset.scripts;
    return;
  }
  if (target.dataset.openComponentDownload) {
    void run(async () => { setFeedback(await api.openDownloadedComponent(target.dataset.openComponentDownload ?? "")); });
    return;
  }
  if (target.dataset.installComponent) {
    void run(async () => {
      if (app) app.downloads = await api.queueComponentInstall(target.dataset.installComponent ?? "");
      notice = "组件已加入下载队列。";
    });
    return;
  }
  if (target.hasAttribute("data-new-conversation")) { void run(async () => { conversation = await api.newConversation(); conversations = await api.listConversations(); }); return; }
  if (target.dataset.conversation) { void run(async () => { conversation = await api.openConversation(target.dataset.conversation ?? ""); }); return; }
  if (target.dataset.prompt) { void sendPrompt(target.dataset.prompt); return; }
  if (target.dataset.testMcp) { void run(async () => { setFeedback(await api.testMcpServer(target.dataset.testMcp ?? "")); }); return; }
  if (target.dataset.deleteMcp) { void run(async () => { app = await api.deleteMcpServer(target.dataset.deleteMcp ?? ""); notice = "MCP 配置已删除。"; }); }
});

void (async () => {
  try {
    await refresh();
    render();
  } catch (reason) {
    root.innerHTML = `<div class="fatal"><div class="brand-mark">π</div><h1>无法启动 SynthV Toolbox</h1><pre>${escapeHtml(formatError(reason))}</pre><p>请确认应用由 Tauri 运行，而不是直接打开前端页面。</p></div>`;
  }
})();
