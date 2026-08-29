import "./styles.css";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { icon } from "./icons";
import { featureCatalog, type FeatureCatalogItem } from "./featureCatalog";
import { mountShell, type ShellController } from "./vue/shell";
import type {
  AppMode,
  BootstrapState,
  ChatMessage,
  ConversationSnapshot,
  ConversationSummary,
  CreativeHistoryEntry,
  McpServerConfig,
  OperationResult,
  ProjectCheckpoint,
  Sv2AccountPrecheck,
  Sv2IsolationPreference,
  Sv2ProfileSlot,
  Sv2SessionProtection,
  Sv2ProfilesState,
  Sv2SyncCategory,
  Sv2SyncCategoryId,
  Sv2SyncManifest,
  SvpLaunchMode,
  SvpRouteCandidate,
  SvpRoutePlan,
  WorkflowRecipe,
  WorkflowResult,
} from "./types";

const root = document.querySelector<HTMLDivElement>("#app")!;
if (!root) throw new Error("Missing #app root");

const ACCOUNT_USAGE_REFRESH_INTERVAL_MS = 30_000;
const ACCOUNT_USAGE_MIN_SCHEDULE_DELAY_MS = 250;

type Page = "home" | "accounts" | "toolbox" | "copilot" | "components" | "bridge" | "mcp" | "settings";
type AccountManagerSection = "profile" | "isolation" | "add";

type Feature = FeatureCatalogItem;
const features: Feature[] = featureCatalog;

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
let workflowRecipes: WorkflowRecipe[] = [];
let creativeHistory: CreativeHistoryEntry[] = [];
let projectCheckpoints: ProjectCheckpoint[] = [];
let syncCategories: Sv2SyncCategory[] = [];
let syncManifest: Sv2SyncManifest | undefined;
let syncSourceSlotId = "";
let syncTargetSlotId = "";
let syncSelectedCategories: Sv2SyncCategoryId[] = [];
let syncOverwrite = false;
let pendingBlockedSwitchSlot: string | undefined;
let pendingConcurrentLaunchSlot: string | undefined;
let pendingConcurrentPrepare = false;
let pendingConcurrentRoute: { slotId: string; projectPath: string; mode: SvpLaunchMode } | undefined;
let pendingSvpRoute: SvpRoutePlan | undefined;
let downloadPollTimer: number | undefined;
let accountPrecheckTimer: number | undefined;
let accountUsageLastAttemptAt = 0;
let accountUsageRefreshInFlight: Promise<void> | undefined;
let sidebarCollapsed = (() => {
  try { return localStorage.getItem("pi.sidebar.collapsed") === "true"; }
  catch { return false; }
})();
let accountManagerOpen = false;
let accountManagerSection: AccountManagerSection = "profile";
let managedProfileSlotId: string | undefined;
let shellController: ShellController | undefined;
let lastWiredMarkup = "";

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

function isAccountUsagePage(): boolean {
  return (["accounts", "toolbox"] as Page[]).includes(page);
}

function clearAccountUsageSchedule(): void {
  if (accountPrecheckTimer === undefined) return;
  window.clearTimeout(accountPrecheckTimer);
  accountPrecheckTimer = undefined;
}

async function refreshAccountUsage(): Promise<void> {
  if (accountUsageRefreshInFlight) return accountUsageRefreshInFlight;
  accountUsageLastAttemptAt = Date.now();
  const request = (async () => {
    const snapshot = await api.sv2AccountUsageSnapshot();
    profiles = snapshot.profiles;
    accountPrecheck = snapshot.precheck;
  })();
  accountUsageRefreshInFlight = request;
  try {
    await request;
  } finally {
    if (accountUsageRefreshInFlight === request) accountUsageRefreshInFlight = undefined;
  }
}

function scheduleAccountPrecheck(): void {
  if (!isAccountUsagePage() || busy || document.hidden || accountPrecheckTimer !== undefined || accountUsageRefreshInFlight || (app?.platform !== "windows" && app?.platform !== "preview")) return;
  const elapsed = Date.now() - accountUsageLastAttemptAt;
  const delay = Math.max(ACCOUNT_USAGE_MIN_SCHEDULE_DELAY_MS, ACCOUNT_USAGE_REFRESH_INTERVAL_MS - elapsed);
  accountPrecheckTimer = window.setTimeout(async () => {
    accountPrecheckTimer = undefined;
    if (!isAccountUsagePage() || document.hidden) return;
    try {
      await refreshAccountUsage();
      render();
    } catch (reason) {
      error = formatError(reason);
      render();
    }
  }, delay);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearAccountUsageSchedule();
    return;
  }
  if (!isAccountUsagePage() || busy || (app?.platform !== "windows" && app?.platform !== "preview")) return;
  if (Date.now() - accountUsageLastAttemptAt < ACCOUNT_USAGE_REFRESH_INTERVAL_MS) {
    scheduleAccountPrecheck();
    return;
  }
  void (async () => {
    try {
      await refreshAccountUsage();
      render();
    } catch (reason) {
      error = formatError(reason);
      render();
    }
  })();
});

function modePill(): string {
  if (!app) return "";
  return app.mode === "ai"
    ? `<span class="mode-pill ai">${icon("sparkles", 15)} AI 模式</span>`
    : `<span class="mode-pill">${icon("toolbox", 15)} 纯工具箱</span>`;
}

function navItem(target: Page, label: string, glyph: Parameters<typeof icon>[0]): string {
  return `<button class="nav-item ${page === target ? "active" : ""}" data-page="${target}" title="${label}" aria-label="${label}" ${page === target ? 'aria-current="page"' : ""}>
    ${icon(glyph, 19)}<span>${label}</span>
  </button>`;
}

function renderSidebar(): string {
  if (!app) return "";
  return `<div class="brand" data-page="home" title="返回概览">
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
      <button class="nav-item sidebar-toggle" data-toggle-sidebar title="${sidebarCollapsed ? "展开侧栏" : "收起侧栏"}" aria-label="${sidebarCollapsed ? "展开侧栏" : "收起侧栏"}" aria-expanded="${!sidebarCollapsed}">${icon("arrow", 18)}<span>${sidebarCollapsed ? "展开侧栏" : "收起侧栏"}</span></button>
      <span class="version">v${escapeHtml(app.appVersion)} · ${escapeHtml(app.platform)}</span>
    </div>`;
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
  const pageHtml = renderPage();
  const noticeHtml = notice ? `<div class="toast success">${icon("check", 18)}<pre>${escapeHtml(notice)}</pre></div>` : "";
  const errorHtml = error ? `<div class="toast error"><pre>${escapeHtml(error)}</pre></div>` : "";
  const overlayHtml = `${busy ? '<div class="busy-overlay" aria-label="处理中"><span class="spinner"></span></div>' : ""}
    ${pendingBlockedSwitchSlot ? renderBlockedSwitchDialog() : pendingConcurrentLaunchSlot ? renderConcurrentDisclaimer() : pendingSvpRoute ? renderSvpRouteDialog() : accountManagerOpen && page === "accounts" ? renderAccountManager() : ""}`;
  const nextShellState = {
    page,
    sidebarCollapsed,
    sidebarHtml: renderSidebar(),
    title: meta.title,
    subtitle: meta.subtitle,
    bridgeConnected: app.bridgeConnected,
    pageHtml,
    noticeHtml,
    errorHtml,
    overlayHtml,
  };
  if (shellController) shellController.update(nextShellState);
  else shellController = mountShell(root, nextShellState);
  const wiredMarkup = `${pageHtml}\u0000${overlayHtml}`;
  if (wiredMarkup !== lastWiredMarkup) {
    lastWiredMarkup = wiredMarkup;
    shellController.afterUpdate(wireForms);
  }
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

function renderSvpRouteDialog(): string {
  if (!pendingSvpRoute) return "";
  const plan = pendingSvpRoute;
  const fileName = plan.projectPath.split(/[\\/]/).pop() || plan.projectPath;
  const requirements = plan.requiredVoices.length
    ? plan.requiredVoices.map((voice) => `<span title="${escapeHtml([voice.backendType, voice.version].filter(Boolean).join(" · "))}">${icon("audio", 14)} ${escapeHtml(voice.name)}${voice.version ? ` <small>v${voice.version}</small>` : ""}</span>`).join("")
    : '<span class="muted">工程中没有可识别的演唱声库要求</span>';
  const candidates = plan.candidates.map((candidate) => renderSvpRouteCandidate(candidate, plan)).join("");
  return `<div class="dialog-backdrop" role="presentation">
    <section class="fluent-dialog svp-route-dialog" role="dialog" aria-modal="true" aria-labelledby="svp-route-title">
      <span class="dialog-icon route">${icon("file", 24)}</span>
      <div><span class="eyebrow">SMART SVP ROUTING</span><h2 id="svp-route-title">选择用于打开工程的账号</h2><p class="dialog-subtitle" title="${escapeHtml(plan.projectPath)}">${escapeHtml(fileName)}</p></div>
      <div class="svp-route-summary"><strong>${escapeHtml(plan.summary)}</strong><p>${escapeHtml(plan.detail)}</p></div>
      <div class="svp-route-requirements"><span>工程所需声库</span><div>${requirements}</div></div>
      ${plan.requiresConfirmation ? `<div class="route-confirmation-note">${icon("shield", 17)}<span><strong>需要你的确认</strong><small>没有权威授权匹配时，工具箱不会静默选择账号。授权结果最终由 SV2 官方服务验证。</small></span></div>` : ""}
      <div class="svp-route-candidates">${candidates || '<div class="empty-inline">没有可用账号。请关闭正在运行的 SV2，或先准备隔离槽位。</div>'}</div>
      <div class="dialog-actions"><button class="secondary" data-cancel-svp-route>取消打开</button></div>
    </section>
  </div>`;
}

function renderSvpRouteCandidate(candidate: SvpRouteCandidate, plan: SvpRoutePlan): string {
  const selectable = candidate.idle && Boolean(candidate.launchMode);
  const selected = candidate.slotId === plan.selectedSlotId && candidate.launchMode === plan.selectedLaunchMode;
  const modeLabel = candidate.launchMode === "concurrent" ? "Sandboxie 并发" : candidate.launchMode === "normal" ? "普通切换" : "不可启动";
  const matchLabel = candidate.exactAuthorizationMatch
    ? `${icon("check", 14)} 已匹配全部确认声库`
    : candidate.matchedVoices.length
      ? `已匹配 ${candidate.matchedVoices.length}，另有 ${candidate.missingOrUnknownVoices.length} 个未知`
      : "授权未知，需人工确认";
  const actionLabel = plan.requiresConfirmation || !candidate.exactAuthorizationMatch ? "确认使用此账号" : "使用此账号打开";
  return `<article class="svp-route-candidate ${selected ? "recommended" : ""} ${selectable ? "" : "disabled"}">
    <div class="route-candidate-heading"><span class="profile-avatar compact">${escapeHtml(Array.from(candidate.displayName)[0] ?? "S")}</span><div><strong>${escapeHtml(candidate.displayName)}</strong><small>${escapeHtml(modeLabel)}${selected ? " · 推荐" : ""}</small></div><span class="route-match ${candidate.exactAuthorizationMatch ? "exact" : "unknown"}">${matchLabel}</span></div>
    <p>${escapeHtml(candidate.reason)}</p>
    ${candidate.missingOrUnknownVoices.length ? `<div class="route-missing" title="未匹配或未知">${candidate.missingOrUnknownVoices.map((voice) => `<span>${escapeHtml(voice)}</span>`).join("")}</div>` : ""}
    <button class="${selected ? "primary" : "secondary"}" data-launch-svp-route="${escapeHtml(candidate.slotId)}" data-svp-route-mode="${escapeHtml(candidate.launchMode ?? "normal")}" ${selectable ? "" : "disabled"}>${candidate.launchMode === "concurrent" ? icon("boxes", 16) : icon("play", 16)} ${actionLabel}</button>
  </article>`;
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
  if (profiles.recoveryRequired) {
    return `${blockerPanel}<div class="warning-card recovery-card"><span>${icon("refresh", 23)}</span><div><strong>槽位需要人工恢复</strong><p>${escapeHtml(profiles.recoveryDetail)}</p><p>工具箱没有删除或覆盖任何目录。请先备份下方路径，再检查目录实况。</p></div><button class="secondary" data-profile-refresh>${icon("refresh", 16)} 重新检查</button></div>
      <section class="panel"><dl class="detail-list"><div><dt>官方路径</dt><dd><code>${escapeHtml(profiles.canonicalPath)}</code></dd></div><div><dt>保管区</dt><dd><code>${escapeHtml(profiles.vaultPath)}</code></dd></div></dl></section>`;
  }
  const activeSlot = profiles.slots.find((slot) => slot.isActive);
  const preparedCount = profiles.slots.filter((slot) => slot.concurrent.ready).length;
  const runningSlots = profiles.slots.filter((slot) => slot.concurrent.runningPids.length > 0);
  const concurrentProviderAvailable = profiles.concurrentProvider.available;
  const providerLabel = [profiles.concurrentProvider.name, profiles.concurrentProvider.version].filter(Boolean).join(" ") || "Sandboxie";
  const providerDetail = profiles.concurrentProvider.detail;
  const cards = profiles.slots.map((slot) => {
    const lastUsed = slot.lastActivatedAtUtc ? new Date(slot.lastActivatedAtUtc).toLocaleString("zh-CN") : "尚未启动";
    const initial = Array.from(slot.displayName)[0] ?? "S";
    const color = /^#[0-9a-f]{6}$/i.test(slot.color) ? slot.color : "#6D5CE7";
    const identity = [slot.username, slot.email].filter(Boolean);
    const useState = accountUseStateForSlot(slot);
    const concurrentRunning = slot.concurrent.runningPids.length > 0;
    const isolatedLabel = concurrentRunning ? "隔离运行中" : slot.concurrent.ready ? "隔离启动" : "准备隔离";
    const isolatedDisabled = concurrentRunning || !concurrentProviderAvailable;
    return `<article class="account-launch-card ${slot.isActive ? "active" : ""}" style="--profile-color:${color}">
      <div class="account-card-main"><span class="profile-avatar compact">${escapeHtml(initial)}</span><div class="account-card-identity"><div class="profile-title-line"><h2>${escapeHtml(slot.displayName)}</h2>${accountUseDot(useState)}${slot.isActive ? '<span class="profile-active-badge">默认</span>' : ""}</div>${identity.length ? `<span class="profile-identity">${identity.map(escapeHtml).join(" · ")}</span>` : '<span class="profile-identity empty">未设置账号标签</span>'}</div><button class="icon-plain" data-manage-slot="${slot.id}" title="管理账号" aria-label="管理 ${escapeHtml(slot.displayName)}">${icon("settings", 18)}</button></div>
      <div class="account-card-facts"><span class="${slot.sessionCached ? "cached" : ""}">${slot.sessionCached ? `${icon("check", 13)} 已缓存登录` : `${icon("plug", 13)} 需要登录`}</span>${sessionProtectionBadge(slot.sessionProtection)}${voiceInventoryBadge(slot)}<span>${icon("refresh", 13)} ${escapeHtml(lastUsed)}</span>${concurrentRunning ? `<span class="running">${icon("plug", 13)} ${slot.concurrent.runningPids.length} 个隔离进程</span>` : ""}</div>
      <div class="account-launch-actions"><button class="primary" data-profile-launch="${slot.id}">${icon("play", 16)} ${slot.isActive ? "普通启动" : "切换并启动"}</button>${slot.concurrent.ready ? `<button class="secondary" data-profile-concurrent-launch="${slot.id}" ${isolatedDisabled ? `disabled title="${concurrentRunning ? "该隔离实例已在运行" : escapeHtml(providerDetail)}"` : ""}>${icon("boxes", 16)} ${isolatedLabel}</button>` : `<button class="secondary" data-profile-concurrent-prepare="${slot.id}" ${concurrentProviderAvailable ? "" : `disabled title="${escapeHtml(providerDetail)}"`}>${icon("download", 16)} ${isolatedLabel}</button>`}</div>
    </article>`;
  }).join("");
  return `<section class="account-hub panel"><div><span class="eyebrow">SV2 ACCOUNT LAUNCHER</span><h2>选择账号并启动</h2><p>普通启动切换默认环境；隔离启动允许多个账号独立运行。</p></div><div class="account-hub-actions"><div class="profile-summary"><span>${profiles.slots.length} 个账号</span><span>${preparedCount} 个隔离就绪</span>${runningSlots.length ? `<span class="running">${icon("plug", 13)} ${runningSlots.length} 个运行中</span>` : ""}</div><div class="button-row"><button class="secondary compact" data-profile-refresh title="刷新状态">${icon("refresh", 16)} 刷新</button><button class="secondary compact" data-account-manager="profile">${icon("settings", 16)} 管理</button><button class="primary compact" data-account-manager="add">${icon("plus", 16)} 添加账号</button></div></div></section>
    <div class="account-provider-strip ${concurrentProviderAvailable ? "ready" : "unavailable"}"><span>${icon("boxes", 16)}</span><strong>并发隔离</strong><span>${concurrentProviderAvailable ? `${escapeHtml(providerLabel)} 已就绪` : "当前不可用"}</span><button class="icon-plain" data-account-manager="isolation" aria-label="管理并发隔离" title="管理并发隔离">${icon("settings", 16)}</button></div>
    ${blockerPanel}
    <div class="account-launch-grid">${cards || `<button class="empty-account-card" data-account-manager="add">${icon("plus", 22)}<strong>添加第一个账号</strong><span>导入当前环境或创建空槽位</span></button>`}</div>
    ${activeSlot ? `<p class="account-default-note">桌面快捷方式和 .svp 文件当前使用“${escapeHtml(activeSlot.displayName)}”。账号资料、目录与隔离策略已收进「管理」。</p>` : ""}`;
}

function voiceInventoryBadge(slot: Sv2ProfileSlot): string {
  const inventory = slot.voiceInventory;
  if (inventory.status === "manual") {
    return `<span class="voice-inventory confirmed" title="${escapeHtml(inventory.detail)}">${icon("audio", 13)} ${inventory.manuallyConfirmedVoices.length} 个确认声库</span>`;
  }
  if (inventory.status === "localEvidence") {
    return `<span class="voice-inventory evidence" title="${escapeHtml(inventory.detail)}">${icon("audio", 13)} ${inventory.installedOpaqueCount} 个本地安装证据</span>`;
  }
  return `<span class="voice-inventory unknown" title="${escapeHtml(inventory.detail)}">${icon("audio", 13)} 授权未知</span>`;
}

function renderAccountManager(): string {
  if (!profiles) return "";
  const managedSlot = profiles.slots.find((slot) => slot.id === managedProfileSlotId)
    ?? profiles.slots.find((slot) => slot.isActive)
    ?? profiles.slots[0];
  if (managedSlot) managedProfileSlotId = managedSlot.id;
  const selector = profiles.slots.length ? `<div class="account-mini-list" aria-label="选择账号">${profiles.slots.map((slot) => {
    const initial = Array.from(slot.displayName)[0] ?? "S";
    const color = /^#[0-9a-f]{6}$/i.test(slot.color) ? slot.color : "#6D5CE7";
    return `<button class="account-mini-item ${slot.id === managedSlot?.id ? "active" : ""}" data-select-managed-slot="${slot.id}" style="--profile-color:${color}"><span>${escapeHtml(initial)}</span><strong>${escapeHtml(slot.displayName)}</strong>${slot.isActive ? '<small>默认</small>' : ""}</button>`;
  }).join("")}</div>` : "";
  let body = "";
  if (accountManagerSection === "profile") {
    body = managedSlot ? `${selector}<div class="account-manager-pane"><div class="manager-pane-heading"><div><h3>${escapeHtml(managedSlot.displayName)}</h3><p>这里只保存便于识别的标签，不读取密码、Cookie 或 session。</p></div>${managedSlot.isActive ? '<span class="profile-active-badge">当前默认</span>' : ""}</div>
      <form class="profile-identity-form compact-form" data-profile-identity-form="${managedSlot.id}"><label>用户名<input name="username" value="${escapeHtml(managedSlot.username)}" maxlength="100" placeholder="用于区分账号" /></label><label>邮箱<input name="email" type="email" value="${escapeHtml(managedSlot.email)}" maxlength="254" placeholder="name@example.com" /></label><button class="secondary">保存标签</button></form>
      <form class="profile-rename compact-form" data-profile-rename-form="${managedSlot.id}"><label>槽位显示名称<input value="${escapeHtml(managedSlot.displayName)}" maxlength="64" required /></label><button class="secondary">重命名</button></form>
      <form class="voice-license-form" data-profile-voice-form="${managedSlot.id}"><div class="voice-license-heading"><div><strong>手工确认可用声库</strong><small>每行一个完整产品名称，仅记录你确认属于此账号的授权。</small></div><span class="inventory-status ${managedSlot.voiceInventory.status}">${managedSlot.voiceInventory.status === "manual" ? "用户已确认" : managedSlot.voiceInventory.status === "localEvidence" ? "仅本地证据" : "未知"}</span></div><textarea name="voices" rows="4" maxlength="16384" placeholder="例如：&#10;Mai 2&#10;SOLARIA">${escapeHtml(managedSlot.voiceInventory.manuallyConfirmedVoices.join("\n"))}</textarea><div class="voice-evidence-note">${icon("shield", 16)}<span><strong>本地安装不等于账号授权</strong><small>${escapeHtml(managedSlot.voiceInventory.detail)}${managedSlot.voiceInventory.installedOpaqueCount ? ` 当前检测到 ${managedSlot.voiceInventory.installedOpaqueCount} 个不透明安装项。` : ""}</small></span></div><button class="secondary" type="submit">保存确认记录</button></form>
      <div class="manager-action-row">${managedSlot.isActive ? "" : `<button class="secondary" data-profile-activate="${managedSlot.id}">${icon("check", 15)} 设为默认账号</button>`}<button class="secondary" data-profile-folder="${managedSlot.id}">${icon("folder", 15)} 打开普通数据目录</button>${managedSlot.concurrent.ready ? `<button class="secondary" data-profile-concurrent-folder="${managedSlot.id}">${icon("folder", 15)} 打开隔离目录</button>` : ""}</div>
      <dl class="profile-storage-list compact"><div><dt>普通数据</dt><dd><code title="${escapeHtml(managedSlot.dataPath)}">${escapeHtml(managedSlot.dataPath)}</code></dd></div>${managedSlot.concurrent.ready ? `<div><dt>隔离数据</dt><dd><code title="${escapeHtml(managedSlot.concurrent.dataPath)}">${escapeHtml(managedSlot.concurrent.dataPath)}</code></dd></div>` : ""}</dl></div>` : '<div class="empty-inline">尚无账号，请先添加一个槽位。</div>';
  } else if (accountManagerSection === "isolation") {
    const content = managedSlot?.concurrent.content;
    const defaults = profiles.concurrentDefaults;
    const providerLabel = [profiles.concurrentProvider.name, profiles.concurrentProvider.version].filter(Boolean).join(" ") || "Sandboxie";
    body = `<div class="manager-provider ${profiles.concurrentProvider.available ? "ready" : "unavailable"}"><span class="feature-icon violet">${icon("boxes", 20)}</span><div><strong>${escapeHtml(providerLabel)}</strong><p>${escapeHtml(profiles.concurrentProvider.detail)}</p></div><span class="availability">${profiles.concurrentProvider.available ? "已就绪" : "不可用"}</span></div>
      <form id="concurrent-defaults-form" class="isolation-defaults-form manager-defaults"><div><strong>全局隔离默认值</strong><small>单账号选择“跟随全局”时使用。</small></div><label class="fluent-switch"><input name="appSettings" type="checkbox" ${defaults.appSettings ? "checked" : ""} /><span></span>应用设置</label><label class="fluent-switch"><input name="voiceLibraries" type="checkbox" ${defaults.voiceLibraries ? "checked" : ""} /><span></span>声库数据</label><button class="secondary" type="submit">保存默认值</button></form>
      ${managedSlot && content ? `${selector}<form class="isolation-content-form manager-isolation-form" data-profile-isolation-form="${managedSlot.id}"><div class="isolation-content-heading"><strong>${escapeHtml(managedSlot.displayName)} · 隔离内容</strong><span>下次隔离启动生效</span></div><label>应用设置<select name="appSettings">${isolationPreferenceOptions(content.appSettings, defaults.appSettings)}</select><small class="effective-state ${content.effectiveAppSettings ? "isolated" : "shared"}">${content.effectiveAppSettings ? "实际：独立" : "实际：共享宿主"}</small></label><label>声库数据<select name="voiceLibraries">${isolationPreferenceOptions(content.voiceLibraries, defaults.voiceLibraries)}</select><small class="effective-state ${content.effectiveVoiceLibraries ? "isolated" : "shared"}">${content.effectiveVoiceLibraries ? "实际：独立" : "实际：共享宿主"}</small></label><button class="secondary" type="submit">保存账号策略</button><small class="isolation-content-note">账号会话、WebView2、注册表和 IPC 始终保持隔离。</small></form>` : ""}
      <details class="manager-note"><summary>隔离模式说明</summary><p>本方案基于 Sandboxie，并非 Dreamtonics 原生多实例功能。工具箱不修改 SV2 二进制，也不代理或绕过官方网络验证。</p></details>`;
  } else {
    body = `<div class="account-add-grid">${profiles.canImportCurrent ? `<section><span class="feature-icon emerald">${icon("folder", 20)}</span><h3>导入当前环境</h3><p>把现有官方数据目录纳入槽位，不移动账号文件。</p><form id="profile-import-form" class="profile-create-form"><input id="profile-import-name" maxlength="64" required placeholder="例如 主账号" /><button class="primary">导入</button></form></section>` : ""}<section><span class="feature-icon blue">${icon("plus", 20)}</span><h3>创建空槽位</h3><p>首次启动后，在 SV2 官方登录页面完成登录。</p><form id="profile-create-form" class="profile-create-form"><input id="profile-create-name" maxlength="64" required placeholder="例如 制作账号" /><button class="secondary">创建</button></form></section></div><div class="manager-safety">${icon("check", 17)}<span><strong>账号数据保持原样</strong><small>工具箱不会伪造登录或绕过联网验证。</small></span></div>`;
  }
  return `<div class="dialog-backdrop account-manager-backdrop" role="presentation"><section class="account-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="account-manager-title"><header><div><span class="eyebrow">SV2 ACCOUNT MANAGER</span><h2 id="account-manager-title">账号管理</h2></div><button class="icon-plain" data-close-account-manager title="关闭" aria-label="关闭账号管理">×</button></header><div class="segmented manager-tabs" role="tablist"><button class="${accountManagerSection === "profile" ? "active" : ""}" data-account-manager-section="profile">账号资料</button><button class="${accountManagerSection === "isolation" ? "active" : ""}" data-account-manager-section="isolation">并发隔离</button><button class="${accountManagerSection === "add" ? "active" : ""}" data-account-manager-section="add">添加账号</button></div><div class="account-manager-body">${body}</div></section></div>`;
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

type AccountUseTone = "clear" | "unknown" | "in-use";

interface AccountUseState {
  tone: AccountUseTone;
  label: string;
}

function accountUseStateFromPrecheck(check: Sv2AccountPrecheck): AccountUseState {
  if (check.localUse || check.remoteUse === "detected") {
    return {
      tone: "in-use",
      label: check.localUse ? "已确认本机正在使用" : "已确认存在其他设备占用迹象",
    };
  }
  if (check.remoteUse === "clear") return { tone: "clear", label: "已确认无人使用" };
  return { tone: "unknown", label: "占用状态未知：无法实时确认其他设备" };
}

function accountUseStateForSlot(slot: Sv2ProfileSlot): AccountUseState {
  const recoveryPending = slot.sessionProtection.status === "recoveryPending"
    || slot.concurrentSessionProtection.status === "recoveryPending";
  if (slot.concurrent.runningPids.length || recoveryPending || (slot.isActive && Boolean(profiles?.blockers.length))) {
    return {
      tone: "in-use",
      label: recoveryPending ? "已确认存在其他设备占用迹象" : "已确认本机正在使用",
    };
  }
  if (accountPrecheck?.slotId === slot.id) return accountUseStateFromPrecheck(accountPrecheck);
  return { tone: "unknown", label: "占用状态未知：此槽位尚无实时远端结果" };
}

function accountUseDot(state: AccountUseState): string {
  return `<span class="account-use-dot ${state.tone}" role="img" aria-label="${escapeHtml(state.label)}" title="${escapeHtml(state.label)}"></span>`;
}

function renderAccountPrecheck(): string {
  if (!app || (app.platform !== "windows" && app.platform !== "preview")) return "";
  if (!accountPrecheck) {
    return `<section class="account-precheck panel loading"><span class="feature-icon blue">${icon("refresh", 22)}</span><div><span class="eyebrow">ACCOUNT USE PRECHECK</span><h2>正在预检当前账号占用</h2><p>检查本机普通实例、插件、Sandboxie 实例和受保护会话是否失效。</p></div></section>`;
  }
  const check = accountPrecheck;
  const useState = accountUseStateFromPrecheck(check);
  const stateClass = useState.tone;
  const localDetail = check.localProcesses.length
    ? check.localProcesses.map((process) => `${escapeHtml(process.name)}${process.pid ? ` · PID ${process.pid}` : ""}`).join("；")
    : check.concurrentPids.length ? `Sandboxie PID：${check.concurrentPids.join(", ")}` : "未发现本机进程";
  const remoteLabel = check.remoteUse === "detected"
    ? "已检测到远端占用迹象"
    : check.remoteUse === "clear" ? "已确认远端未占用" : "远端状态等待 SV2 验证";
  const stateIcon = useState.tone === "in-use" ? "plug" : useState.tone === "clear" ? "check" : "refresh";
  const stateAccent = useState.tone === "in-use" ? "red" : useState.tone === "clear" ? "emerald" : "orange";
  return `<section class="account-precheck panel ${stateClass}">
    <span class="feature-icon ${stateAccent}">${icon(stateIcon, 22)}</span>
    <div class="account-precheck-main"><span class="eyebrow">ACCOUNT USE PRECHECK</span><div class="precheck-title-line"><h2>账号占用锁 · ${escapeHtml(check.displayName || "未设置账号")}</h2>${accountUseDot(useState)}</div><p><strong>${escapeHtml(check.summary)}</strong> ${escapeHtml(check.detail)}</p><div class="precheck-facts"><span>${icon("users", 14)} ${localDetail}</span><span class="${check.remoteUse === "detected" ? "remote-detected" : check.remoteUse === "clear" ? "remote-clear" : ""}">${icon("plug", 14)} ${remoteLabel}</span><span>${icon("refresh", 14)} ${new Date(check.checkedAtUtc).toLocaleTimeString("zh-CN")}</span></div></div>
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
    form = `<div class="mode-limit">请先在 SynthV 中保存工程；这里读取磁盘上的 .svp，不包含尚未保存的内存修改。所有输出统一写入 ~/.SynthVcopilot/output/，源工程不会被覆盖。</div>
      <div class="workflow-split">
        <form id="project-probe-form" class="workflow-form"><h3>只读工程探测</h3><label>.svp 工程路径<input id="project-probe-path" required placeholder="目标 .svp 文件" /></label><button class="primary">${icon("file", 16)} 探测版本与轨道</button></form>
        <form id="project-no-params-form" class="workflow-form"><h3>导出无参工程</h3><label>已保存的 .svp 工程路径<input id="project-no-params-path" required placeholder="源工程不会被修改" /></label><label>输出工程文件名<input id="project-no-params-output" required value="project_no_params.svp" /></label><button class="secondary">${icon("file", 16)} 生成无参副本</button></form>
        <form id="project-lyrics-form" class="workflow-form"><h3>生成 LRC / 逐字 LRC</h3><label>已保存的 .svp 工程路径<input id="project-lyrics-path" required /></label><div class="workflow-pair"><label>歌词轨道编号<input id="project-lyrics-track" type="number" min="1" max="10000" step="1" value="1" required /></label><label>分句空隙（秒）<input id="project-lyrics-gap" type="number" min="0" max="10" step="0.1" value="0.8" required /></label></div><label>普通 LRC 文件名<input id="project-lyrics-output" required value="project.lrc" /></label><label>逐字 LRC 文件名<input id="project-word-lyrics-output" required value="project.word.lrc" /></label><button class="secondary">${icon("file", 16)} 同时生成两种 LRC</button></form>
        <form id="project-reference-form" class="workflow-form"><h3>生成参考轨副本</h3><label>目标 .svp 工程路径<input id="project-ref-path" required /></label><label>参考音频路径<input id="project-ref-audio" required /></label><div class="workflow-pair"><label>参考轨名称<input id="project-ref-name" required value="CVRS Reference" /></label><label>起始秒数<input id="project-ref-begin" type="number" min="0" max="86400" step="0.01" value="0" /></label></div><label>输出工程文件名<input id="project-ref-output" required value="project_cvrs.svp" /></label><button class="secondary">${icon("plus", 16)} 生成安全副本</button></form>
      </div>`;
  } else if (id === "audio-to-project") {
    form = `<div class="mode-limit">第一版使用时间轴一致的演唱版与伴奏版提取单音旋律。未连接 Bridge 时仍会保留 MIDI 检查点；含词转写会在 Whisper 组件进入可信安装清单后启用。</div>
      <form id="audio-to-project-form" class="workflow-form workflow-wide">
        <div class="workflow-pair"><label>演唱版音频路径<input id="pipeline-vocal" required placeholder="包含目标演唱的音频" /></label><label>伴奏版音频路径<input id="pipeline-inst" required placeholder="同版本、同时间轴的伴奏" /></label></div>
        <div class="workflow-pair"><label>输出 MIDI 文件名<input id="pipeline-output" required value="audio_to_project.mid" /></label><label>SynthV 音符组名称<input id="pipeline-group-name" required value="Toolbox Audio Import" maxlength="200" /></label></div>
        <div class="workflow-pair"><label>目标轨道编号<input id="pipeline-track" type="number" min="1" max="10000" value="1" required /></label>${ai ? `<label>匹配容差（秒）<input id="pipeline-tolerance" type="number" min="0.02" max="0.25" step="0.01" value="0.08" /></label>` : '<input id="pipeline-tolerance" type="hidden" value="0.08" />'}</div>
        ${ai ? `<label class="checkbox workflow-check"><input id="pipeline-advanced" type="checkbox" checked /> 启用多参数寻优与低置信音符纠正</label>` : ""}
        <label class="checkbox workflow-check"><input id="pipeline-import" type="checkbox" ${app.bridgeConnected ? "" : "disabled"} /> 提取完成后通过 Bridge 导入当前 SynthV 工程${app.bridgeConnected ? "" : "（Bridge 未连接）"}</label>
        <label class="checkbox workflow-check"><input id="pipeline-rights" type="checkbox" /> 我确认有权使用这些本地素材及生成的 MIDI（仅导入时需要）</label>
        <button class="primary">${icon("pipeline", 16)} 运行音频到工程流程</button>
      </form>`;
  } else if (id === "project-doctor") {
    form = `<div class="mode-limit">完全离线、只读检查已保存的 .svp；不会调用模型或修改工程。</div><form id="project-doctor-form" class="workflow-form workflow-wide"><label>.svp 工程路径<input id="doctor-project" required placeholder="选择需要体检的工程" /></label><button class="primary">${icon("doctor", 16)} 开始只读体检</button></form>`;
  } else if (id === "checkpoints") {
    const history = creativeHistory.length ? creativeHistory.map((item) => `<article class="timeline-item"><span class="status-dot online"></span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.summary)}</small><code>${escapeHtml(new Date(item.createdAtUtc).toLocaleString("zh-CN"))}${item.outputPath ? ` · ${escapeHtml(item.outputPath)}` : ""}</code></div></article>`).join("") : '<div class="empty-inline">还没有创作工作流记录。</div>';
    const checkpoints = projectCheckpoints.length ? projectCheckpoints.map((item) => `<article class="checkpoint-item"><span class="feature-icon blue">${icon("shield", 17)}</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.sourcePath)}</small><code>SHA-256 ${escapeHtml(item.sourceSha256.slice(0, 16))}… · ${new Date(item.createdAtUtc).toLocaleString("zh-CN")}</code></div><button class="secondary compact" data-restore-checkpoint="${escapeHtml(item.id)}">恢复副本</button></article>`).join("") : '<div class="empty-inline">还没有工程检查点。</div>';
    form = `<div class="workflow-split"><form id="checkpoint-form" class="workflow-form"><h3>创建工程检查点</h3><label>.svp 工程路径<input id="checkpoint-project" required /></label><label>检查点名称<input id="checkpoint-label" required maxlength="100" value="调声前" /></label><button class="primary">${icon("shield", 16)} 创建哈希检查点</button></form><section class="workflow-form"><h3>工程检查点</h3><div class="checkpoint-list">${checkpoints}</div></section></div><section class="workflow-history"><div class="section-heading"><div><h3>工作流历史</h3><p>记录输入参数、组件结果和输出位置；大结果会自动截断历史副本。</p></div><button class="secondary compact" data-refresh-history>${icon("refresh", 15)} 刷新</button></div><div class="timeline-list">${history}</div></section>`;
  } else if (id === "batch-recipes") {
    const recipes = workflowRecipes.filter((recipe) => recipe.supportsBatch);
    form = `<div class="mode-limit">每行一个输入路径，一次最多 100 项。任务串行执行，单项失败不会中断其余文件。</div><form id="batch-workflow-form" class="workflow-form workflow-wide"><label>批处理配方<select id="batch-recipe">${recipes.map((recipe) => `<option value="${escapeHtml(recipe.id)}">${escapeHtml(recipe.title)} · ${escapeHtml(recipe.description)}</option>`).join("")}</select></label><label>输入文件路径（每行一个）<textarea id="batch-inputs" rows="8" required placeholder="C:\Projects\song-a.svp&#10;C:\Projects\song-b.svp"></textarea></label><label>可选 JSON 参数<textarea id="batch-options" rows="3" placeholder='例如 {"suffix":"_delivery"}'>{}</textarea></label><button class="primary">${icon("batch", 16)} 加入批处理并执行</button></form>`;
  } else if (id === "selective-sync") {
    const slotOptions = profiles?.slots.map((slot) => `<option value="${escapeHtml(slot.id)}" ${slot.id === syncSourceSlotId ? "selected" : ""}>${escapeHtml(slot.displayName)}${slot.isActive ? "（当前默认）" : ""}</option>`).join("") ?? "";
    const targetOptions = profiles?.slots.map((slot) => `<option value="${escapeHtml(slot.id)}" ${slot.id === syncTargetSlotId ? "selected" : ""}>${escapeHtml(slot.displayName)}${slot.isActive ? "（当前默认）" : ""}</option>`).join("") ?? "";
    const categoryOptions = syncCategories.map((category) => `<label class="sync-category"><input type="checkbox" name="sync-category" value="${category.id}" ${syncSelectedCategories.includes(category.id) ? "checked" : ""} /><span><strong>${escapeHtml(category.label)}</strong><small>${escapeHtml(category.description)}</small></span></label>`).join("");
    const preview = syncManifest ? `<section class="sync-preview"><div class="section-heading"><div><h3>写入前清单</h3><p>${syncManifest.entries.length} 个文件；令牌会在执行前重新校验。</p></div><span class="availability">${syncManifest.overwrite ? "允许更新" : "冲突不覆盖"}</span></div><div class="sync-entry-list">${syncManifest.entries.map((entry) => `<div><span class="sync-action ${entry.action}">${entry.action}</span><code>${escapeHtml(entry.relativePath)}</code><small>${entry.sourceSize} bytes</small></div>`).join("") || '<div class="empty-inline">所选类别没有可同步文件。</div>'}</div></section>` : "";
    form = profiles && profiles.slots.length >= 2 ? `<div class="mode-limit">只同步白名单中的词典、脚本、预设和安全设置；license、session、WebView2、Cookie 与声库数据库始终排除。同步前必须关闭相关普通/隔离实例。</div><form id="selective-sync-form" class="workflow-form workflow-wide"><div class="workflow-pair"><label>源账号<select id="sync-source">${slotOptions}</select></label><label>目标账号<select id="sync-target">${targetOptions}</select></label></div><div class="sync-category-grid">${categoryOptions}</div><label class="checkbox workflow-check"><input id="sync-overwrite" type="checkbox" ${syncOverwrite ? "checked" : ""} /> 目标不同文件显示为 Update 并允许覆盖；关闭时标记 Conflict 且不写入</label><div class="button-row"><button class="secondary" value="preview">${icon("compare", 16)} 生成差异预览</button><button class="primary" value="execute" ${syncManifest ? "" : "disabled"}>${icon("sync", 16)} 执行已批准清单</button></div></form>${preview}` : '<div class="mode-limit">至少需要两个 SV2 账号槽位才能使用选择性同步。</div>';
  } else if (id === "retake-compare") {
    form = `<div class="mode-limit">在 SynthV 中确认目标音符编号。每次写入前都会重新读取 Retake 上下文；新鲜度校验失败时会直接停止，不会盲写。</div><form id="retake-form" class="workflow-form workflow-wide"><div class="workflow-pair three"><label>轨道编号<input id="retake-track" type="number" min="1" value="1" required /></label><label>音符组编号<input id="retake-group" type="number" min="1" value="1" required /></label><label>音符编号<input id="retake-note" type="number" min="1" value="1" required /></label></div><div class="workflow-pair"><label>操作<select id="retake-operation"><option value="refresh">读取候选</option><option value="generate">生成新候选</option><option value="activate">切换到 Take</option><option value="delete">删除 Take</option></select></label><label>Take ID（切换/删除）<input id="retake-id" type="number" min="0" value="0" /></label></div><div class="retake-dimensions"><label class="checkbox"><input id="retake-duration" type="checkbox" checked /> 时值</label><label class="checkbox"><input id="retake-pitch" type="checkbox" checked /> 音高</label><label class="checkbox"><input id="retake-timbre" type="checkbox" checked /> 音色/发音</label><label class="checkbox"><input id="retake-activate" type="checkbox" /> 生成后立即启用</label></div><button class="primary" ${app.bridgeConnected ? "" : "disabled"}>${icon("compare", 16)} ${app.bridgeConnected ? "执行 Retake 操作" : "请先连接 Bridge"}</button></form>`;
  } else if (id === "pronunciation-doctor") {
    form = `<div class="mode-limit">可检查已保存工程，也可直接粘贴歌词；两种输入只填写一种。首版聚焦空歌词、多音节拥挤、混合文字和极短音符。</div><form id="pronunciation-form" class="workflow-form workflow-wide"><label>.svp 工程路径（可选）<input id="pronunciation-project" placeholder="填写工程路径时不要再粘贴歌词" /></label><label>歌词文本（可选）<textarea id="pronunciation-lyrics" rows="8" placeholder="逐行粘贴歌词；填写歌词时不要再填写工程路径"></textarea></label><button class="primary">${icon("pronunciation", 16)} 运行发音诊断</button></form>`;
  } else if (id === "render-review") {
    form = `<div class="mode-limit">复用本地 pi-audio 探测结果检查静音、时长、BPM 与音高事件；不会上传渲染音频。</div><form id="render-review-form" class="workflow-form workflow-wide"><label>渲染音频路径<input id="render-audio" required /></label><div class="workflow-pair"><label>预期时长（秒，可选）<input id="render-duration" type="number" min="0.01" step="0.01" /></label><label>预期 BPM（可选）<input id="render-bpm" type="number" min="1" max="1000" step="0.01" /></label></div><label class="checkbox workflow-check"><input id="render-notes" type="checkbox" /> 要求探测到音高事件</label>${ai ? '<label class="checkbox workflow-check"><input id="render-advanced" type="checkbox" /> 启用高级音频分析</label>' : ""}<button class="primary">${icon("shield", 16)} 开始交付复检</button></form>`;
  } else {
    const catalogFeature = features.find((item) => item.id === id);
    form = catalogFeature ? `<div class="mode-limit"><strong>能力入口已就绪</strong><br />${escapeHtml(catalogFeature.base.join(" · "))}。后端工作流接入后会在这里显示参数与执行结果；当前不会对工程或音频执行写入。</div>` : "";
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
  const showSvpRouting = app.platform === "windows" || app.platform === "preview";
  const association = app.svpAssociation;
  const associationLabel = !association.supported
    ? "当前平台不支持"
    : association.isDefault
      ? "已设为 .svp 默认打开方式"
      : association.registered
        ? "已注册，等待设为默认应用"
        : "尚未注册为可选打开方式";
  return `<div class="settings-layout"><section class="panel"><div class="section-heading"><div><h2>运行模式</h2><p>切换后导航与 Rust 后端能力会同时更新。</p></div></div><div class="mode-setting"><button class="setting-choice ${app.mode === "toolbox" ? "active" : ""}" data-set-mode="toolbox"><span class="mode-icon slate">${icon("toolbox", 23)}</span><span><strong>纯工具箱</strong><small>确定性基础流程，不启动 AI</small></span>${app.mode === "toolbox" ? icon("check", 20) : ""}</button><button class="setting-choice ${app.mode === "ai" ? "active" : ""}" data-set-mode="ai"><span class="mode-icon purple">${icon("sparkles", 23)}</span><span><strong>AI 模式</strong><small>Copilot、智能增强与 MCP</small></span>${app.mode === "ai" ? icon("check", 20) : ""}</button></div></section>
    ${app.mode === "ai" ? `<section class="panel"><div class="section-heading"><div><h2>模型连接</h2><p>令牌写入本机用户配置，不会返回给前端。</p></div></div><form id="model-form" class="form-stack"><label>Anthropic 兼容 API 地址<input id="model-url" type="url" required value="${escapeHtml(app.model?.baseUrl ?? "https://api.anthropic.com")}" /></label><label>模型 ID<input id="model-id" required value="${escapeHtml(app.model?.model ?? "")}" placeholder="例如 claude-sonnet-4-5" /></label><label>访问令牌<input id="model-token" type="password" placeholder="${app.model?.tokenConfigured ? "已保存；留空则保留" : "输入访问令牌"}" /></label><button class="primary">保存模型设置</button></form></section>` : `<section class="panel quiet-panel"><span class="mode-icon slate">${icon("bot", 24)}</span><div><h2>AI 运行时已关闭</h2><p>当前不会显示 Copilot、模型或 MCP 设置，也不会向模型端点发送请求。</p></div></section>`}
    ${showSvpRouting ? `<section class="panel smart-route-settings"><div class="section-heading"><div><h2>智能 .svp 启动</h2><p>根据工程所需声库，从空闲账号中建议最合适的启动槽位。</p></div><label class="fluent-switch large"><input id="svp-routing-enabled" type="checkbox" ${app.smartSvpLaunchEnabled ? "checked" : ""} ${association.supported ? "" : "disabled"} aria-label="启用智能 .svp 启动" /><span></span>${app.smartSvpLaunchEnabled ? "已开启" : "已关闭"}</label></div><div class="smart-route-state ${association.isDefault ? "ready" : "pending"}"><span class="feature-icon ${association.isDefault ? "emerald" : "blue"}">${icon("file", 20)}</span><div><strong>${escapeHtml(associationLabel)}</strong><p>${escapeHtml(association.detail)}</p></div><button class="secondary compact" data-open-svp-default-apps ${association.supported ? "" : "disabled"}>打开默认应用设置</button></div><div class="smart-route-boundary">${icon("shield", 17)}<span><strong>智能路由只在工具箱已经运行时生效</strong><small>冷启动或关闭此功能时，工具箱会把工程透明转交给原始 .svp 处理程序；不会监控、终止或劫持已经启动的 SV2。声库匹配依据仅来自你的确认记录，未知时必须由你选择账号。</small></span></div></section>` : ""}
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
  document.querySelector<HTMLFormElement>("#project-no-params-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const projectPath = document.querySelector<HTMLInputElement>("#project-no-params-path")?.value.trim() ?? "";
    const outputName = document.querySelector<HTMLInputElement>("#project-no-params-output")?.value.trim() ?? "project_no_params.svp";
    void run(async () => { workflowResult = await api.exportProjectWithoutParameters(projectPath, outputName); notice = workflowResult.summary; });
  });
  document.querySelector<HTMLFormElement>("#project-lyrics-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const projectPath = document.querySelector<HTMLInputElement>("#project-lyrics-path")?.value.trim() ?? "";
    const trackIndex = Number(document.querySelector<HTMLInputElement>("#project-lyrics-track")?.value ?? "1");
    const lineGapSeconds = Number(document.querySelector<HTMLInputElement>("#project-lyrics-gap")?.value ?? "0.8");
    const outputName = document.querySelector<HTMLInputElement>("#project-lyrics-output")?.value.trim() ?? "project.lrc";
    const wordOutputName = document.querySelector<HTMLInputElement>("#project-word-lyrics-output")?.value.trim() ?? "project.word.lrc";
    void run(async () => { workflowResult = await api.exportProjectLyrics(projectPath, trackIndex, lineGapSeconds, outputName, wordOutputName); notice = workflowResult.summary; });
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
  document.querySelector<HTMLFormElement>("#audio-to-project-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const vocalPath = document.querySelector<HTMLInputElement>("#pipeline-vocal")?.value.trim() ?? "";
    const instrumentalPath = document.querySelector<HTMLInputElement>("#pipeline-inst")?.value.trim() ?? "";
    const outputName = document.querySelector<HTMLInputElement>("#pipeline-output")?.value.trim() ?? "audio_to_project.mid";
    const groupName = document.querySelector<HTMLInputElement>("#pipeline-group-name")?.value.trim() ?? "Toolbox Audio Import";
    const trackIndex = Number(document.querySelector<HTMLInputElement>("#pipeline-track")?.value ?? "1");
    const tolerance = Number(document.querySelector<HTMLInputElement>("#pipeline-tolerance")?.value ?? "0.08");
    const advanced = app?.mode === "ai" && (document.querySelector<HTMLInputElement>("#pipeline-advanced")?.checked ?? false);
    const importToSynthv = document.querySelector<HTMLInputElement>("#pipeline-import")?.checked ?? false;
    const rightsConfirmed = document.querySelector<HTMLInputElement>("#pipeline-rights")?.checked ?? false;
    void run(async () => { workflowResult = await api.runAudioToProject(vocalPath, instrumentalPath, outputName, tolerance, advanced, importToSynthv, rightsConfirmed, trackIndex, groupName); notice = workflowResult.summary; });
  });
  document.querySelector<HTMLFormElement>("#project-doctor-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const projectPath = document.querySelector<HTMLInputElement>("#doctor-project")?.value.trim() ?? "";
    void run(async () => { workflowResult = await api.runProjectDoctor(projectPath); notice = workflowResult.summary; });
  });
  document.querySelector<HTMLFormElement>("#checkpoint-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const projectPath = document.querySelector<HTMLInputElement>("#checkpoint-project")?.value.trim() ?? "";
    const label = document.querySelector<HTMLInputElement>("#checkpoint-label")?.value.trim() ?? "";
    void run(async () => {
      const checkpoint = await api.createProjectCheckpoint(projectPath, label);
      projectCheckpoints = await api.listProjectCheckpoints();
      notice = `已创建检查点“${checkpoint.label}”。`;
    });
  });
  document.querySelector<HTMLFormElement>("#batch-workflow-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const recipeId = document.querySelector<HTMLSelectElement>("#batch-recipe")?.value ?? "project-doctor";
    const inputPaths = (document.querySelector<HTMLTextAreaElement>("#batch-inputs")?.value ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const optionsText = document.querySelector<HTMLTextAreaElement>("#batch-options")?.value.trim() || "{}";
    void run(async () => {
      const options = JSON.parse(optionsText) as Record<string, unknown>;
      const batch = await api.runBatchWorkflow(recipeId, inputPaths, options);
      workflowResult = { kind: "batch-recipes", summary: `批处理完成 ${batch.completed} 项，失败 ${batch.failed} 项。`, data: batch as unknown as Record<string, unknown> };
      notice = workflowResult.summary;
    });
  });
  document.querySelector<HTMLFormElement>("#selective-sync-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    const sourceSlotId = document.querySelector<HTMLSelectElement>("#sync-source")?.value ?? "";
    const targetSlotId = document.querySelector<HTMLSelectElement>("#sync-target")?.value ?? "";
    const categories = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="sync-category"]:checked')).map((input) => input.value as Sv2SyncCategoryId);
    const overwrite = document.querySelector<HTMLInputElement>("#sync-overwrite")?.checked ?? false;
    syncSourceSlotId = sourceSlotId;
    syncTargetSlotId = targetSlotId;
    syncSelectedCategories = categories;
    syncOverwrite = overwrite;
    void run(async () => {
      if (submitter?.value === "execute") {
        if (!syncManifest) throw new Error("请先生成并检查同步清单。");
        const result = await api.executeSv2SelectiveSync(sourceSlotId, targetSlotId, categories, syncManifest);
        workflowResult = { kind: "profile-selective-sync", summary: `选择性同步完成：复制 ${result.copied}、更新 ${result.updated}、跳过 ${result.skipped}、冲突 ${result.conflicts}。`, data: result as unknown as Record<string, unknown> };
        notice = workflowResult.summary;
        syncManifest = undefined;
      } else {
        syncManifest = await api.previewSv2SelectiveSync(sourceSlotId, targetSlotId, categories, overwrite);
        notice = `同步预览已生成：${syncManifest.entries.length} 个文件，尚未写入。`;
      }
    });
  });
  document.querySelector<HTMLFormElement>("#retake-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const trackIndex = Number(document.querySelector<HTMLInputElement>("#retake-track")?.value ?? "1");
    const groupIndex = Number(document.querySelector<HTMLInputElement>("#retake-group")?.value ?? "1");
    const noteIndex = Number(document.querySelector<HTMLInputElement>("#retake-note")?.value ?? "1");
    const operation = document.querySelector<HTMLSelectElement>("#retake-operation")?.value ?? "refresh";
    const takeIdValue = document.querySelector<HTMLInputElement>("#retake-id")?.value.trim() ?? "";
    const takeId = takeIdValue ? Number(takeIdValue) : undefined;
    const newDuration = document.querySelector<HTMLInputElement>("#retake-duration")?.checked ?? true;
    const newPitch = document.querySelector<HTMLInputElement>("#retake-pitch")?.checked ?? true;
    const newTimbre = document.querySelector<HTMLInputElement>("#retake-timbre")?.checked ?? true;
    const activate = document.querySelector<HTMLInputElement>("#retake-activate")?.checked ?? false;
    void run(async () => { workflowResult = await api.runRetakeWorkbench(trackIndex, groupIndex, noteIndex, operation, takeId, newDuration, newPitch, newTimbre, activate); notice = workflowResult.summary; });
  });
  document.querySelector<HTMLFormElement>("#pronunciation-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const projectPath = document.querySelector<HTMLInputElement>("#pronunciation-project")?.value.trim() || undefined;
    const lyrics = document.querySelector<HTMLTextAreaElement>("#pronunciation-lyrics")?.value.trim() || undefined;
    void run(async () => { workflowResult = await api.runPronunciationDiagnostics(projectPath, lyrics); notice = workflowResult.summary; });
  });
  document.querySelector<HTMLFormElement>("#render-review-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const audioPath = document.querySelector<HTMLInputElement>("#render-audio")?.value.trim() ?? "";
    const durationValue = document.querySelector<HTMLInputElement>("#render-duration")?.value.trim() ?? "";
    const bpmValue = document.querySelector<HTMLInputElement>("#render-bpm")?.value.trim() ?? "";
    const expectedDurationSec = durationValue ? Number(durationValue) : undefined;
    const expectedBpm = bpmValue ? Number(bpmValue) : undefined;
    const requireNotes = document.querySelector<HTMLInputElement>("#render-notes")?.checked ?? false;
    const advanced = app?.mode === "ai" && (document.querySelector<HTMLInputElement>("#render-advanced")?.checked ?? false);
    void run(async () => { workflowResult = await api.runRenderReview(audioPath, expectedDurationSec, expectedBpm, requireNotes, advanced); notice = workflowResult.summary; });
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
  document.querySelectorAll<HTMLFormElement>("[data-profile-voice-form]").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    const slotId = form.dataset.profileVoiceForm ?? "";
    const voices = (form.querySelector<HTMLTextAreaElement>('[name="voices"]')?.value ?? "")
      .split(/\r?\n/)
      .map((voice) => voice.trim())
      .filter(Boolean);
    if (!slotId) return;
    void run(async () => {
      profiles = await api.updateSv2ProfileVoiceLicenses(slotId, voices);
      notice = voices.length
        ? `已保存 ${voices.length} 条用户确认的声库记录。`
        : "已清除用户确认记录；本地安装证据不会被视为授权。";
    });
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
  document.querySelector<HTMLInputElement>("#svp-routing-enabled")?.addEventListener("change", (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    void run(async () => {
      app = await api.setSvpLaunchRouting(enabled);
      notice = enabled
        ? "智能 .svp 启动已开启。请确认 Windows 已将 SynthV Toolbox 设为 .svp 默认应用。"
        : "智能 .svp 启动已关闭；工程会透明转交给原始处理程序。";
    });
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
  if (target.hasAttribute("data-toggle-sidebar")) {
    sidebarCollapsed = !sidebarCollapsed;
    try { localStorage.setItem("pi.sidebar.collapsed", String(sidebarCollapsed)); } catch { /* preference remains in memory */ }
    render();
    return;
  }
  if (target.hasAttribute("data-cancel-svp-route")) {
    pendingSvpRoute = undefined;
    render();
    return;
  }
  if (target.dataset.launchSvpRoute) {
    const plan = pendingSvpRoute;
    const slotId = target.dataset.launchSvpRoute;
    const mode = target.dataset.svpRouteMode as SvpLaunchMode | undefined;
    const candidate = plan?.candidates.find((item) => item.slotId === slotId && item.launchMode === mode);
    if (!plan || !candidate || !candidate.idle || !mode) return;
    pendingSvpRoute = undefined;
    if (mode === "concurrent" && !app?.concurrentDisclaimerAccepted) {
      pendingConcurrentLaunchSlot = slotId;
      pendingConcurrentPrepare = false;
      pendingConcurrentRoute = { slotId, projectPath: plan.projectPath, mode };
      render();
      return;
    }
    void run(async () => {
      setFeedback(await api.launchSvpRoute(slotId, plan.projectPath, mode));
      profiles = await api.sv2ProfileState();
    });
    return;
  }
  if (target.hasAttribute("data-open-svp-default-apps")) {
    void run(async () => { setFeedback(await api.openSvpDefaultAppsSettings()); });
    return;
  }
  if (target.hasAttribute("data-close-account-manager")) {
    accountManagerOpen = false;
    render();
    return;
  }
  const managerSection = (target.dataset.accountManagerSection ?? target.dataset.accountManager) as AccountManagerSection | undefined;
  if (managerSection) {
    accountManagerOpen = true;
    accountManagerSection = managerSection;
    render();
    return;
  }
  if (target.dataset.manageSlot) {
    managedProfileSlotId = target.dataset.manageSlot;
    accountManagerSection = "profile";
    accountManagerOpen = true;
    render();
    return;
  }
  if (target.dataset.selectManagedSlot) {
    managedProfileSlotId = target.dataset.selectManagedSlot;
    render();
    return;
  }
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
    pendingConcurrentRoute = undefined;
    render();
    return;
  }
  if (target.hasAttribute("data-accept-concurrent")) {
    const slotId = pendingConcurrentLaunchSlot;
    if (!slotId) return;
    const prepare = pendingConcurrentPrepare;
    const route = pendingConcurrentRoute;
    pendingConcurrentLaunchSlot = undefined;
    pendingConcurrentPrepare = false;
    pendingConcurrentRoute = undefined;
    void run(async () => {
      app = await api.acceptSv2ConcurrentDisclaimer();
      if (route) {
        setFeedback(await api.launchSvpRoute(route.slotId, route.projectPath, route.mode));
        profiles = await api.sv2ProfileState();
      } else {
        await launchConcurrentSlot(slotId, prepare);
      }
    });
    return;
  }
  const targetPage = target.dataset.page as Page | undefined;
  if (targetPage) {
    clearAccountUsageSchedule();
    page = targetPage;
    accountManagerOpen = false;
    notice = "";
    error = "";
    if (page === "copilot") void run(async () => { conversations = await api.listConversations(); });
    else if (isAccountUsagePage() && (app?.platform === "windows" || app?.platform === "preview")) void run(refreshAccountUsage);
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
    syncManifest = undefined;
    notice = "";
    clearAccountUsageSchedule();
    const featureId = target.dataset.feature;
    if (featureId === "checkpoints") void run(async () => { [creativeHistory, projectCheckpoints] = await Promise.all([api.listCreativeHistory(), api.listProjectCheckpoints()]); });
    else if (featureId === "batch-recipes") void run(async () => { workflowRecipes = await api.listWorkflowRecipes(); });
    else if (featureId === "selective-sync") void run(async () => {
      [syncCategories] = await Promise.all([api.sv2SyncCategories(), refreshAccountUsage()]);
      const slots = profiles?.slots ?? [];
      if (!slots.some((slot) => slot.id === syncSourceSlotId)) syncSourceSlotId = slots[0]?.id ?? "";
      if (!slots.some((slot) => slot.id === syncTargetSlotId) || syncTargetSlotId === syncSourceSlotId) {
        syncTargetSlotId = slots.find((slot) => slot.id !== syncSourceSlotId)?.id ?? "";
      }
      syncSelectedCategories = syncCategories.map((category) => category.id);
    });
    else if (app?.platform === "windows" || app?.platform === "preview") void run(refreshAccountUsage);
    else render();
    return;
  }
  if (target.hasAttribute("data-close-workflow")) { activeWorkflow = undefined; workflowResult = undefined; render(); return; }
  if (target.hasAttribute("data-review-workflow") && workflowResult) {
    void run(async () => { if (workflowResult) workflowResult.aiReview = await api.reviewWorkflow(workflowResult.kind, workflowResult.data); });
    return;
  }
  if (target.hasAttribute("data-refresh-history")) {
    void run(async () => { [creativeHistory, projectCheckpoints] = await Promise.all([api.listCreativeHistory(), api.listProjectCheckpoints()]); notice = "工作流历史与工程检查点已刷新。"; });
    return;
  }
  if (target.dataset.restoreCheckpoint) {
    const id = target.dataset.restoreCheckpoint;
    void run(async () => {
      const outputName = `checkpoint_${id.slice(0, 8)}_${Date.now()}.svp`;
      setFeedback(await api.restoreProjectCheckpoint(id, outputName));
    });
    return;
  }
  if (target.hasAttribute("data-scan")) { void run(async () => { if (app) app.installations = await api.scanSynthV(); notice = "探测完成。"; }); return; }
  if (target.hasAttribute("data-account-precheck")) { clearAccountUsageSchedule(); void run(async () => { await refreshAccountUsage(); notice = "当前账号占用预检已刷新。"; }); return; }
  if (target.hasAttribute("data-profile-refresh")) { clearAccountUsageSchedule(); void run(async () => { await refreshAccountUsage(); notice = "账号槽位与占用状态已刷新。"; }); return; }
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

function svpRoutePlanFromPayload(payload: unknown): SvpRoutePlan | undefined {
  const wrapped = payload && typeof payload === "object" && "plan" in payload
    ? (payload as { plan?: unknown }).plan
    : payload;
  if (!wrapped || typeof wrapped !== "object") return undefined;
  const plan = wrapped as Partial<SvpRoutePlan>;
  if (typeof plan.projectPath !== "string" || !Array.isArray(plan.requiredVoices) || !Array.isArray(plan.candidates)) return undefined;
  return plan as SvpRoutePlan;
}

async function listenForSvpRouteRequests(): Promise<void> {
  if (!isTauri()) return;
  await Promise.all([listen<unknown>("svp-route-request", (event) => {
    const plan = svpRoutePlanFromPayload(event.payload);
    if (!plan) {
      error = "收到的 .svp 智能路由请求格式无效。";
      render();
      return;
    }
    pendingSvpRoute = plan;
    notice = "";
    error = "";
    render();
  }), listen<unknown>("svp-route-error", (event) => {
    pendingSvpRoute = undefined;
    error = formatError(event.payload);
    notice = "";
    render();
  })]);
}

void (async () => {
  try {
    await refresh();
    await listenForSvpRouteRequests();
    render();
  } catch (reason) {
    root.innerHTML = `<div class="fatal"><div class="brand-mark">π</div><h1>无法启动 SynthV Toolbox</h1><pre>${escapeHtml(formatError(reason))}</pre><p>请确认应用由 Tauri 运行，而不是直接打开前端页面。</p></div>`;
  }
})();
