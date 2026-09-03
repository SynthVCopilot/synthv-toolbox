import "./styles.css";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { icon } from "./icons";
import { featureCatalog, toolGroups, type FeatureCatalogItem, type ToolGroup } from "./featureCatalog";
import { mountShell, type ShellController } from "./vue/shell";
import type {
  AiProviderId,
  AiProviderSummary,
  AppMode,
  AudioCaptureCapability,
  AudioCaptureTarget,
  BootstrapState,
  ChatMessage,
  ChineseRhymeLookup,
  ConversationSnapshot,
  ConversationSummary,
  CreativeHistoryEntry,
  LyricCandidateSet,
  LyricProject,
  LyricProjectSummary,
  LyricSectionRequest,
  MediaSourcePreview,
  MediaTaskSnapshot,
  McpServerConfig,
  OperationResult,
  OpenCodeCatalog,
  ProjectCheckpoint,
  RhymeMatchMode,
  Sv2AccountProbe,
  Sv2ProfileSlot,
  Sv2ProfilesState,
  Sv2SyncCategory,
  Sv2SyncCategoryId,
  Sv2SyncManifest,
  SvpLaunchMode,
  SvpRouteCandidate,
  SvpRoutePlan,
  SynthVProcess,
  SynthVShortcutProfile,
  ToolboxUpdateCheck,
  WorkflowRecipe,
  WorkflowResult,
} from "./types";

const root = document.querySelector<HTMLDivElement>("#app")!;
if (!root) throw new Error("Missing #app root");

type Page = "home" | "accounts" | "toolbox" | "lyrics" | "history" | "copilot" | "components" | "bridge" | "mcp" | "settings";
type AccountManagerSection = "profile" | "global" | "add";

interface PendingAccountIndicatorConsent {
  refreshAfterEnable: boolean;
  refreshSlotId?: string;
  concurrentEnabled?: boolean;
}

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
let activeWorkflow: Feature["id"] | undefined;
let workflowResult: WorkflowResult | undefined;
let mediaSourceInput = "";
let mediaSourcePreview: MediaSourcePreview | undefined;
let mediaTasks: MediaTaskSnapshot[] = [];
let audioCaptureCapability: AudioCaptureCapability | undefined;
let audioCaptureTargets: AudioCaptureTarget[] = [];
let synthvProcesses: SynthVProcess[] = [];
let synthvShortcutProfile: SynthVShortcutProfile | undefined;
let abProcessId: number | undefined;
let abStartSeconds = 10;
let abEndSeconds = 15;
let abPreRollSeconds = 0.4;
let abPostRollSeconds = 0.25;
let abBaselinePath = "";
let abCandidatePath = "";
let toolboxUpdate: ToolboxUpdateCheck | undefined;
let workflowRecipes: WorkflowRecipe[] = [];
let creativeHistory: CreativeHistoryEntry[] = [];
let projectCheckpoints: ProjectCheckpoint[] = [];
let syncCategories: Sv2SyncCategory[] = [];
let syncManifest: Sv2SyncManifest | undefined;
let syncSourceSlotId = "";
let syncTargetSlotId = "";
let syncSelectedCategories: Sv2SyncCategoryId[] = [];
let syncOverwrite = false;
let lyricRhymeQuery = "ang";
let lyricRhymeMode: RhymeMatchMode = "family";
let lyricRhymeResult: ChineseRhymeLookup | undefined;
let lyricSongTitle = "";
let lyricRhymeTargets: Record<string, string> = { A: "ang", B: "ai", C: "", D: "" };
let lyricDraft = "";
let lyricCandidateBrief = "";
let lyricCandidateImagery = "";
let lyricCandidateSection = "副歌";
let lyricCandidateTone = "克制而有画面感";
let lyricCandidateRhyme = "ang";
let lyricCandidateCount = 4;
let lyricCandidates: LyricCandidateSet | undefined;
let lyricSectionCounter = 0;
let lyricSections: LyricSectionRequest[] = createLyricPreset("compact");
let lyricProjects: LyricProjectSummary[] = [];
let lyricProjectId: string | undefined;
let lyricProjectRevision = 0;
let lyricSavedSnapshot = "";
let pendingBlockedSwitchSlot: string | undefined;
let pendingConcurrentLaunchSlot: string | undefined;
let pendingConcurrentPrepare = false;
let pendingConcurrentRoute: { slotId: string; projectPath: string; mode: SvpLaunchMode } | undefined;
let pendingSvpRoute: SvpRoutePlan | undefined;
let pendingComponentRemovalId: string | undefined;
let pendingProfileDeletionId: string | undefined;
let pendingAccountIndicatorConsent: PendingAccountIndicatorConsent | undefined;
let removingComponentId: string | undefined;
let expandedAiProvider: AiProviderId | undefined;
let authorizingAiProvider: AiProviderId | undefined;
let pendingAiAccountRemoval: { provider: AiProviderId; accountId: string } | undefined;
let pendingAiAccountRemovalTimer: number | undefined;
let openCodeCatalog: OpenCodeCatalog | undefined;
let openCodeCatalogLoading = false;
let openCodeCatalogError = "";
let downloadPollTimer: number | undefined;
let mediaTaskPollTimer: number | undefined;
let toastDismissTimer: number | undefined;
let toastSignature = "";
let accountUsageRefreshInFlight: Promise<void> | undefined;
let lyricPersistTimer: number | undefined;
let sidebarCollapsed = (() => {
  try { return localStorage.getItem("pi.sidebar.collapsed") === "true"; }
  catch { return false; }
})();
let accountManagerOpen = false;
let accountManagerSection: AccountManagerSection = "global";
let managedProfileSlotId: string | undefined;
let shellController: ShellController | undefined;
let lastWiredMarkup = "";

function createLyricSection(
  kind: LyricSectionRequest["kind"],
  label: string,
  lineCount: number,
  rhymeScheme: string,
): LyricSectionRequest {
  lyricSectionCounter += 1;
  return { id: `lyric-${kind}-${lyricSectionCounter}`, kind, label, lineCount, rhymeScheme };
}

function createLyricPreset(preset: "compact" | "pop" | "rap" | "blank"): LyricSectionRequest[] {
  if (preset === "blank") return [createLyricSection("verse", "段落 1", 4, "AAAA")];
  if (preset === "rap") return [
    createLyricSection("intro", "前奏", 2, "--"),
    createLyricSection("verse", "Verse 1", 16, "AABB"),
    createLyricSection("chorus", "Hook", 8, "AAAA"),
    createLyricSection("verse", "Verse 2", 16, "AABB"),
    createLyricSection("outro", "尾声", 4, "AAAA"),
  ];
  if (preset === "pop") return [
    createLyricSection("verse", "主歌 1", 4, "ABAB"),
    createLyricSection("preChorus", "预副歌", 4, "AABB"),
    createLyricSection("chorus", "副歌", 4, "AAAA"),
    createLyricSection("verse", "主歌 2", 4, "ABAB"),
    createLyricSection("chorus", "副歌重复", 4, "AAAA"),
    createLyricSection("bridge", "桥段", 4, "CCDD"),
    createLyricSection("chorus", "末副歌", 4, "AAAA"),
  ];
  return [
    createLyricSection("verse", "主歌 1", 4, "ABAB"),
    createLyricSection("chorus", "副歌", 4, "AAAA"),
    createLyricSection("verse", "主歌 2", 4, "ABAB"),
    createLyricSection("chorus", "副歌重复", 4, "AAAA"),
  ];
}

function persistLyricWorkspace(): void {
  try {
    localStorage.setItem("pi.lyric.workspace.v1", JSON.stringify({
      projectId: lyricProjectId,
      projectRevision: lyricProjectRevision,
      title: lyricSongTitle,
      rhymeTargets: lyricRhymeTargets,
      draft: lyricDraft,
      sections: lyricSections,
    }));
  } catch { /* workspace remains available for this session */ }
}

function restoreLyricWorkspace(): void {
  try {
    const raw = localStorage.getItem("pi.lyric.workspace.v1");
    if (!raw) return;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    if (typeof saved.projectId === "string" && /^[0-9a-f-]{36}$/i.test(saved.projectId)) lyricProjectId = saved.projectId;
    if (typeof saved.projectRevision === "number" && Number.isInteger(saved.projectRevision) && saved.projectRevision > 0) lyricProjectRevision = saved.projectRevision;
    if (typeof saved.title === "string") lyricSongTitle = saved.title.slice(0, 120);
    if (typeof saved.draft === "string") lyricDraft = saved.draft.slice(0, 200_000);
    if (saved.rhymeTargets && typeof saved.rhymeTargets === "object" && !Array.isArray(saved.rhymeTargets)) {
      for (const label of ["A", "B", "C", "D"]) {
        const value = (saved.rhymeTargets as Record<string, unknown>)[label];
        if (typeof value === "string") lyricRhymeTargets[label] = value.slice(0, 24);
      }
    }
    if (Array.isArray(saved.sections)) {
      const restored = saved.sections.slice(0, 40).flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const section = value as Record<string, unknown>;
        const kind = section.kind as LyricSectionRequest["kind"];
        if (!["intro", "verse", "preChorus", "chorus", "bridge", "instrumental", "outro", "custom"].includes(kind)) return [];
        if (typeof section.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(section.id)) return [];
        if (typeof section.label !== "string" || !section.label.trim()) return [];
        const lineCount = Number(section.lineCount);
        if (!Number.isInteger(lineCount) || lineCount < 1 || lineCount > 32) return [];
        const rhymeScheme = typeof section.rhymeScheme === "string" ? section.rhymeScheme.slice(0, 32) : "-";
        return [{ id: section.id, kind, label: section.label.slice(0, 60), lineCount, rhymeScheme }];
      });
      if (restored.length) {
        lyricSections = restored;
        lyricSectionCounter = Math.max(lyricSectionCounter, restored.length + 100);
      }
    }
    lyricSavedSnapshot = lyricWorkspaceSnapshot();
  } catch { /* ignore invalid local drafts */ }
}

function lyricWorkspaceSnapshot(): string {
  return JSON.stringify({
    title: lyricSongTitle,
    draft: lyricDraft,
    rhymeTargets: lyricRhymeTargets,
    sections: lyricSections,
  });
}

function lyricProjectHasUnsavedChanges(): boolean {
  return lyricWorkspaceSnapshot() !== lyricSavedSnapshot;
}

function applyLyricProject(project: LyricProject): void {
  lyricProjectId = project.id;
  lyricProjectRevision = project.revision;
  lyricSongTitle = project.title;
  lyricDraft = project.draft;
  lyricRhymeTargets = { A: "", B: "", C: "", D: "", ...project.rhymeTargets };
  lyricSections = project.sections.map((section) => ({ ...section }));
  lyricSectionCounter = Math.max(lyricSectionCounter, lyricSections.length + 100);
  lyricCandidates = undefined;
  workflowResult = undefined;
  lyricSavedSnapshot = lyricWorkspaceSnapshot();
  persistLyricWorkspace();
}

function startNewLyricProject(): void {
  lyricProjectId = undefined;
  lyricProjectRevision = 0;
  lyricSongTitle = "";
  lyricDraft = "";
  lyricRhymeTargets = { A: "ang", B: "ai", C: "", D: "" };
  lyricSections = createLyricPreset("compact");
  lyricCandidateSection = lyricSections.find((section) => section.kind === "chorus")?.label ?? lyricSections[0]?.label ?? "";
  lyricCandidates = undefined;
  workflowResult = undefined;
  lyricSavedSnapshot = lyricWorkspaceSnapshot();
  persistLyricWorkspace();
}

restoreLyricWorkspace();
if (!lyricSavedSnapshot) lyricSavedSnapshot = lyricWorkspaceSnapshot();

const pageMeta: Record<Page, { title: string; subtitle: string }> = {
  home: { title: "概览", subtitle: "查看环境状态与常用能力" },
  accounts: { title: "SV2 账号", subtitle: "管理本机 SV2 槽位；Windows 还支持可选并发隔离" },
  toolbox: { title: "工具箱", subtitle: "直接使用创作工具，或进入自动化工作流" },
  lyrics: { title: "作词", subtitle: "专注写下歌词，需要时再调用结构、韵脚与 AI 辅助" },
  history: { title: "历史与检查点", subtitle: "回看自动保存的工作流记录，并管理工程检查点" },
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

function clearPendingAiAccountRemoval(): void {
  pendingAiAccountRemoval = undefined;
  if (pendingAiAccountRemovalTimer !== undefined) {
    window.clearTimeout(pendingAiAccountRemovalTimer);
    pendingAiAccountRemovalTimer = undefined;
  }
}

function focusAiAccountRemovalButton(provider: AiProviderId, accountId: string): void {
  requestAnimationFrame(() => {
    Array.from(document.querySelectorAll<HTMLButtonElement>("[data-remove-ai-account]"))
      .find((button) => button.dataset.aiProvider === provider
        && button.dataset.removeAiAccount === accountId)
      ?.focus();
  });
}

function armAiAccountRemoval(provider: AiProviderId, accountId: string): void {
  clearPendingAiAccountRemoval();
  pendingAiAccountRemoval = { provider, accountId };
  pendingAiAccountRemovalTimer = window.setTimeout(() => {
    pendingAiAccountRemovalTimer = undefined;
    if (pendingAiAccountRemoval?.provider === provider
      && pendingAiAccountRemoval.accountId === accountId) {
      pendingAiAccountRemoval = undefined;
      render();
      focusAiAccountRemovalButton(provider, accountId);
    }
  }, 5_000);
}

function resetContentScroll(): void {
  requestAnimationFrame(() => {
    const content = document.querySelector<HTMLElement>("#page-content");
    if (content) content.scrollTop = 0;
  });
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
  [lyricProjects, synthvProcesses, synthvShortcutProfile, mediaTasks] = await Promise.all([
    api.listLyricProjects(),
    api.listSynthvProcesses(),
    api.synthvShortcutProfile(),
    api.mediaTasks(),
  ]);
}

async function refreshAccountUsage(slotId?: string): Promise<void> {
  if (!app?.sv2AccountIndicatorEnabled) return;
  if (accountUsageRefreshInFlight) return accountUsageRefreshInFlight;
  const request = (async () => {
    try {
      const snapshot = slotId
        ? await api.sv2AccountUsageSnapshotForSlot(slotId)
        : await api.sv2AccountUsageSnapshot();
      profiles = snapshot.profiles;
    } finally {
      if (page === "accounts") render();
    }
  })();
  accountUsageRefreshInFlight = request;
  try {
    await request;
  } finally {
    if (accountUsageRefreshInFlight === request) accountUsageRefreshInFlight = undefined;
  }
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

function scheduleMediaTaskPoll(): void {
  if (!mediaTasks.some((item) => ["queued", "running", "cancelling"].includes(item.status)) || mediaTaskPollTimer !== undefined) return;
  mediaTaskPollTimer = window.setTimeout(async () => {
    mediaTaskPollTimer = undefined;
    try {
      mediaTasks = await api.mediaTasks();
      render();
    } catch (reason) {
      error = formatError(reason);
      render();
    }
  }, 700);
}

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
      <div class="brand-mark small"><img class="brand-logo" src="/assets/synthv-toolbox-logo.png" alt="SynthV Toolbox" /></div>
      <div><strong>SynthV Toolbox</strong><span>Creative utility suite</span></div>
    </div>
    <nav class="nav" aria-label="主导航">
      <span class="nav-label">工作区</span>
      ${navItem("home", "概览", "home")}
      ${app.platform === "windows" || app.platform === "macos" || app.platform === "preview" ? navItem("accounts", "SV2 账号", "users") : ""}
      ${navItem("toolbox", "工具箱", "toolbox")}
      ${navItem("lyrics", "作词", "lyrics")}
      ${navItem("history", "历史与检查点", "history")}
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
  if (app.settingsLoadError) {
    root.innerHTML = `<main class="fatal settings-recovery" role="alert">
      <div class="brand-mark"><img class="brand-logo" src="/assets/synthv-toolbox-logo.png" alt="SynthV Toolbox" /></div>
      <span class="eyebrow">设置恢复保护模式</span>
      <h1>配置需要修复，原文件尚未被覆盖</h1>
      <p>工具箱检测到设置文件无法安全读取，因此已停用所有设置写入。OAuth 凭据和账号映射不会被默认配置替换。</p>
      <pre>${escapeHtml(app.settingsLoadError)}</pre>
      <div class="settings-recovery-path"><strong>配置文件</strong><code>${escapeHtml(app.configPath)}</code></div>
      <p>请修复 JSON 与 <code>schemaVersion</code>，或从备份恢复此文件，然后重新启动 SynthV Toolbox。</p>
    </main>`;
    return;
  }
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
  const nextToastSignature = `${notice}\u0000${error}`;
  if (nextToastSignature !== toastSignature) {
    toastSignature = nextToastSignature;
    if (toastDismissTimer !== undefined) window.clearTimeout(toastDismissTimer);
    if (notice || error) {
      toastDismissTimer = window.setTimeout(() => {
        toastDismissTimer = undefined;
        if (`${notice}\u0000${error}` !== nextToastSignature) return;
        notice = "";
        error = "";
        render();
      }, 4200);
    }
  }
  const overlayHtml = pendingComponentRemovalId ? renderComponentRemovalDialog() : pendingProfileDeletionId ? renderProfileDeletionDialog() : pendingBlockedSwitchSlot ? renderBlockedSwitchDialog() : pendingConcurrentLaunchSlot ? renderConcurrentDisclaimer() : pendingSvpRoute ? renderSvpRouteDialog() : pendingAccountIndicatorConsent ? renderAccountIndicatorConsent() : accountManagerOpen && page === "accounts" ? renderAccountManager() : "";
  const nextShellState = {
    page,
    sidebarCollapsed,
    sidebarHtml: renderSidebar(),
    title: meta.title,
    subtitle: meta.subtitle,
    bridgeConnected: app.bridgeConnected,
    busy,
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
  scheduleMediaTaskPoll();
}

function renderConcurrentDisclaimer(): string {
  const slot = profiles?.slots.find((item) => item.id === pendingConcurrentLaunchSlot);
  return `<div class="dialog-backdrop" role="presentation">
    <section class="fluent-dialog" role="alertdialog" aria-modal="true" aria-labelledby="concurrent-warning-title">
      <span class="dialog-icon">${icon("boxes", 24)}</span>
      <div><span class="eyebrow">首次使用风险告知</span><h2 id="concurrent-warning-title">并发隔离未被 Dreamtonics 官方承认</h2></div>
      <p>将为“${escapeHtml(slot?.displayName ?? "此槽位")}”启动独立的 SV2 实例。Dreamtonics 尚未公开确认多实例使用方式。</p>
      <p class="dialog-choice-note">工具箱不会修改 SV2、绕过账号限制或代为踢出其他会话。继续即表示你已知晓并自行承担这一使用风险。</p>
      <div class="dialog-actions"><button class="secondary" data-cancel-concurrent>取消</button><button class="primary" data-accept-concurrent>已知晓风险，继续启动</button></div>
    </section>
  </div>`;
}

function renderAccountIndicatorConsent(): string {
  return `<div class="dialog-backdrop" role="presentation">
    <section class="fluent-dialog account-indicator-consent" role="alertdialog" aria-modal="true" aria-labelledby="account-indicator-consent-title">
      <span class="dialog-icon route">${icon("shield", 24)}</span>
      <div><span class="eyebrow">SV2 ACCOUNT LOGIN INDICATOR</span><h2 id="account-indicator-consent-title">开启账号登录指示器？</h2></div>
      <p>此功能不会启动 Synthesizer V，但它不是纯本地、纯只读检查。确认开启会完成本次进入页面的首次预检；以后只会在你重新进入「SV2 账号」页面或手动刷新时执行下列操作：</p>
      <ul>
        <li>读取并解密普通槽位及已准备隔离副本的本地 <code>license/session</code>；若标准 JWT 含有 <code>name</code>/<code>email</code> 声明，会将姓名和邮箱显示在账号卡片及账号管理页。access/refresh token 原文仅在后端内存中处理，不会在界面展示、复制或写入日志。</li>
        <li>同一槽位只选择一份账号 session 作为 authority；access JWT 临期或失效时可能自动刷新，并把更新后的加密 session 同步到闲置的普通/隔离副本。</li>
        <li>每个账号只执行一轮官方 <code>enroll_device</code> 启动等价检查，以确认实际启动是否会被登录冲突拒绝；所有请求固定使用 <code>kickout_other_sessions=false</code>。</li>
      </ul>
      <p class="dialog-choice-note">这不是 dry-run：官方服务会收到真实登录事件。工具箱只报告冲突，绝不会代你踢出其他会话，也不会启动客户端。你可以随时关闭此功能。</p>
      <div class="dialog-actions"><button class="secondary" data-cancel-account-indicator>取消</button><button class="primary" data-confirm-account-indicator>${icon("check", 16)} 同意并开启</button></div>
    </section>
  </div>`;
}

function renderProfileDeletionDialog(): string {
  const slot = profiles?.slots.find((item) => item.id === pendingProfileDeletionId);
  if (!slot) return "";
  const hasReplacement = profiles!.slots.some((item) => item.id !== slot.id);
  const defaultNote = slot.isActive
    ? hasReplacement
      ? "该账号目前是默认账号；删除后会自动切换到另一个账号。"
      : "这是最后一个账号；删除后桌面快捷方式和 .svp 文件不再有默认账号。"
    : "此操作不会影响当前默认账号。";
  return `<div class="dialog-backdrop" role="presentation">
    <section class="fluent-dialog component-removal-dialog" role="alertdialog" aria-modal="true" aria-labelledby="profile-deletion-title">
      <span class="dialog-icon danger">${icon("trash", 24)}</span>
      <div><span class="eyebrow">SV2 ACCOUNT MANAGER</span><h2 id="profile-deletion-title">删除“${escapeHtml(slot.displayName)}”？</h2></div>
      <p>这会删除该账号槽位的普通数据、隔离副本和登录态恢复快照，无法撤销。</p>
      <p class="dialog-choice-note">${defaultNote}</p>
      <div class="dialog-actions"><button class="secondary" data-cancel-profile-deletion>取消</button><button class="danger-action" data-confirm-profile-deletion>${icon("trash", 16)} 删除账号</button></div>
    </section>
  </div>`;
}

function renderComponentRemovalDialog(): string {
  const component = app?.components.find((item) => item.id === pendingComponentRemovalId);
  if (!component) return "";
  const cleanupOnly = !component.installed;
  const actionLabel = cleanupOnly ? "清理残留" : "删除组件";
  return `<div class="dialog-backdrop" role="presentation">
    <section class="fluent-dialog component-removal-dialog" role="alertdialog" aria-modal="true" aria-labelledby="component-removal-title">
      <span class="dialog-icon danger">${icon("trash", 24)}</span>
      <div><span class="eyebrow">本地组件管理</span><h2 id="component-removal-title">${cleanupOnly ? "清理" : "删除"}“${escapeHtml(component.displayName)}”？</h2></div>
      <p>此操作会删除 SynthV Toolbox 管理的本地运行环境与对应配置。依赖此组件的工作流在重新安装前将不可用。</p>
      <p class="dialog-choice-note">用户工程、输入素材以及已导出的输出文件不会被删除；之后仍可从组件中心重新安装。</p>
      <div class="dialog-actions"><button class="secondary" data-cancel-component-removal>取消</button><button class="danger-action" data-confirm-component-removal>${icon("trash", 16)} ${actionLabel}</button></div>
    </section>
  </div>`;
}

function renderBlockedSwitchDialog(): string {
  const slot = profiles?.slots.find((item) => item.id === pendingBlockedSwitchSlot);
  const blockers = profiles?.blockers ?? [];
  if (!supportsWindowsSv2Extensions()) {
    return `<div class="dialog-backdrop" role="presentation">
      <section class="fluent-dialog switch-dialog" role="alertdialog" aria-modal="true" aria-labelledby="blocked-switch-title">
        <span class="dialog-icon danger">${icon("plug", 24)}</span>
        <div><span class="eyebrow">检测到运行中的程序</span><h2 id="blocked-switch-title">无法安全切换到“${escapeHtml(slot?.displayName ?? "此槽位")}”</h2></div>
        <p>请先保存并退出下列程序，然后重新启动目标槽位。macOS v1 不会强制结束进程，也不会启动并发实例。</p>
        <div class="dialog-process-list">${blockers.map((blocker) => `<div><span><strong>${escapeHtml(blocker.name)}</strong><small>${escapeHtml(blocker.reason)}</small></span><code>${blocker.pid ? `PID ${blocker.pid}` : "无可用 PID"}</code></div>`).join("")}</div>
        <div class="dialog-actions"><button class="primary" data-cancel-profile-switch>知道了</button></div>
      </section>
    </div>`;
  }
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
      ${plan.requiresConfirmation ? `<div class="route-confirmation-note">${icon("shield", 17)}<span><strong>需要你的确认</strong><small>账号占用或授权仍有未知项时，工具箱不会静默选择账号。最终结果仍由 SV2 官方服务验证。</small></span></div>` : ""}
      <div class="svp-route-candidates">${candidates || '<div class="empty-inline">没有可用账号。请关闭正在运行的 SV2，或先准备隔离槽位。</div>'}</div>
      <div class="dialog-actions"><button class="secondary" data-cancel-svp-route>取消打开</button></div>
    </section>
  </div>`;
}

function renderSvpRouteCandidate(candidate: SvpRouteCandidate, plan: SvpRoutePlan): string {
  const selectable = candidate.idle && candidate.remoteUse !== "detected" && Boolean(candidate.launchMode);
  const selected = candidate.slotId === plan.selectedSlotId && candidate.launchMode === plan.selectedLaunchMode;
  const modeLabel = candidate.launchMode === "concurrent" ? "Sandboxie 并发" : candidate.launchMode === "normal" ? "普通切换" : "不可启动";
  const sessionLabel = candidate.remoteUse === "detected"
    ? "账号服务报告正在使用"
    : candidate.remoteUse === "clear" && candidate.sessionStatus === "ready"
      ? "官方服务已接受无踢出登录事件"
      : candidate.sessionStatus === "inUse"
        ? "缓存会话正由本机使用"
        : `${accountProbeSessionLabel(candidate.sessionStatus)} · 占用未知`;
  const authorizationLabel = candidate.authorizationSource === "session"
    ? "官方授权"
    : candidate.authorizationSource === "mixed"
      ? "官方授权 + 手工确认"
      : candidate.authorizationSource === "manual" ? "手工确认" : "授权未知";
  const matchLabel = candidate.exactAuthorizationMatch
    ? `${icon("check", 14)} ${authorizationLabel}已匹配全部声库`
    : candidate.matchedVoices.length
      ? `${authorizationLabel}已匹配 ${candidate.matchedVoices.length}，另有 ${candidate.missingOrUnknownVoices.length} 个未知`
      : "授权未知，需人工确认";
  const needsConfirmation = candidate.remoteUse === "unknown" || candidate.sessionStatus !== "ready" || !candidate.exactAuthorizationMatch;
  const actionLabel = plan.requiresConfirmation || needsConfirmation ? "确认使用此账号" : "使用此账号打开";
  return `<article class="svp-route-candidate ${selected ? "recommended" : ""} ${selectable ? "" : "disabled"}">
    <div class="route-candidate-heading"><span class="profile-avatar compact">${escapeHtml(Array.from(candidate.displayName)[0] ?? "S")}</span><div><strong>${escapeHtml(candidate.displayName)}</strong><small>${escapeHtml(modeLabel)} · ${escapeHtml(sessionLabel)}${selected ? " · 推荐" : ""}</small></div><span class="route-match ${candidate.exactAuthorizationMatch ? "exact" : "unknown"}">${matchLabel}</span></div>
    <p>${escapeHtml(candidate.reason)}</p>
    ${candidate.missingOrUnknownVoices.length ? `<div class="route-missing" title="未匹配或未知">${candidate.missingOrUnknownVoices.map((voice) => `<span>${escapeHtml(voice)}</span>`).join("")}</div>` : ""}
    <button class="${selected ? "primary" : "secondary"}" data-launch-svp-route="${escapeHtml(candidate.slotId)}" data-svp-route-mode="${escapeHtml(candidate.launchMode ?? "normal")}" ${selectable ? "" : "disabled"}>${candidate.launchMode === "concurrent" ? icon("boxes", 16) : icon("play", 16)} ${actionLabel}</button>
  </article>`;
}

function accountProbeSessionLabel(status: SvpRouteCandidate["sessionStatus"]): string {
  const labels: Record<SvpRouteCandidate["sessionStatus"], string> = {
    ready: "缓存会话可用",
    missing: "需要登录",
    inUse: "缓存会话正由本机使用",
    expired: "访问凭据已过期，需要重新登录",
    loginRequired: "官方服务要求重新登录",
    invalid: "缓存会话无效",
    syncFailed: "会话同步失败，需要修复",
    accountMismatch: "账号副本不一致",
    unsupported: "暂不支持此会话格式",
    offline: "账号服务离线",
  };
  return labels[status];
}

interface AccountProbeIssuePresentation {
  cardLabel: string;
  authorizationLabel: string;
  title: string;
  attention: boolean;
}

const accountProbeIssueRules: Array<[
  Sv2AccountProbe["sessionStatus"],
  AccountProbeIssuePresentation,
]> = [
  ["syncFailed", {
    cardLabel: "会话同步失败，需要修复",
    authorizationLabel: "会话同步失败，未读取该副本授权",
    title: "账号凭据刷新或设备身份写回后未能安全同步；该副本已被隔离，不能当作尚未预检。",
    attention: true,
  }],
  ["accountMismatch", {
    cardLabel: "账号副本不一致",
    authorizationLabel: "账号副本不一致，未读取该副本授权",
    title: "普通与隔离副本的 JWT 账号主体不同；工具箱没有覆盖任一账号缓存。",
    attention: true,
  }],
  ["inUse", {
    cardLabel: "账号正在本机使用",
    authorizationLabel: "账号正在使用，本次未读取授权",
    title: "会话正在被客户端使用；姓名与邮箱可沿用上次脱敏结果，授权与占用结论不会沿用。",
    attention: false,
  }],
  ["loginRequired", {
    cardLabel: "账号需要重新登录",
    authorizationLabel: "官方服务要求重新登录，未读取授权",
    title: "官方服务明确要求重新登录；这不是尚未预检或网络离线。",
    attention: true,
  }],
  ["expired", {
    cardLabel: "账号需要重新登录",
    authorizationLabel: "凭据续期失败，需要重新登录后读取授权",
    title: "访问凭据已过期且未能续期；请在 SV2 中重新登录。",
    attention: true,
  }],
  ["invalid", {
    cardLabel: "登录缓存无效",
    authorizationLabel: "登录缓存无效，未读取授权",
    title: "本地登录缓存无法安全验证。",
    attention: true,
  }],
  ["offline", {
    cardLabel: "账号服务暂时离线",
    authorizationLabel: "账号服务暂时离线，授权当前不可用",
    title: "本地会话已读取，但账号服务暂时不可达；不要把它解释为尚未预检或需要重新登录。",
    attention: false,
  }],
  ["unsupported", {
    cardLabel: "暂不支持此会话格式",
    authorizationLabel: "会话格式暂不支持，未读取授权",
    title: "当前版本无法安全解析此登录缓存。",
    attention: false,
  }],
  ["missing", {
    cardLabel: "尚未登录",
    authorizationLabel: "尚无登录缓存，未读取授权",
    title: "未发现登录缓存；请先在 SV2 中完成登录。",
    attention: false,
  }],
];

function accountProbeIssue(probes: Sv2AccountProbe[]): AccountProbeIssuePresentation | undefined {
  for (const [status, presentation] of accountProbeIssueRules) {
    if (probes.some((probe) => probe.sessionStatus === status)) return presentation;
  }
  return undefined;
}

interface AccountProbeEnvironmentState {
  label: "普通" | "隔离";
  probe: Sv2AccountProbe;
  launchEnabled: boolean;
  localBlocked: boolean;
  localBlockLabel: string;
  usable: boolean;
  busy: boolean;
}

function accountProbeEnvironments(slot: Sv2ProfileSlot): AccountProbeEnvironmentState[] {
  const normalRecovery = slot.sessionProtection.status === "recoveryPending";
  const normalProcessBlocked = Boolean(profiles?.blockers.length);
  const environments: AccountProbeEnvironmentState[] = [{
    label: "普通",
    probe: slot.accountProbe,
    launchEnabled: true,
    localBlocked: normalRecovery || normalProcessBlocked,
    localBlockLabel: normalRecovery ? "登录缓存等待恢复" : normalProcessBlocked ? "普通环境正在本机使用" : "",
    usable: false,
    busy: false,
  }];

  if (slot.concurrent.ready) {
    const concurrentRecovery = slot.concurrentSessionProtection.status === "recoveryPending";
    const concurrentRunning = Boolean(slot.concurrent.runningPids.length);
    environments.push({
      label: "隔离",
      probe: slot.concurrentAccountProbe,
      launchEnabled: Boolean(app?.sv2ConcurrentEnabled && profiles?.concurrentProvider.available),
      localBlocked: concurrentRecovery || concurrentRunning,
      localBlockLabel: concurrentRecovery ? "登录缓存等待恢复" : concurrentRunning ? "隔离环境正在本机使用" : "",
      usable: false,
      busy: false,
    });
  }

  for (const environment of environments) {
    const remoteBusy = environment.probe.remoteUse === "detected";
    const probeInUse = environment.probe.sessionStatus === "inUse";
    environment.usable = environment.launchEnabled
      && !environment.localBlocked
      && environment.probe.sessionStatus === "ready"
      && environment.probe.remoteUse === "clear";
    environment.busy = environment.launchEnabled
      && (environment.localBlocked || remoteBusy || probeInUse);
  }
  return environments;
}

function accountProbeEnvironmentSummary(environment: AccountProbeEnvironmentState): string {
  if (!environment.launchEnabled) return "当前不可启动（隔离功能或提供方不可用）";
  if (environment.localBlocked) return environment.localBlockLabel;
  const probe = environment.probe;
  const session = probe.remoteUse === "detected"
    ? "远端占用"
    : probe.sessionStatus === "inUse"
      ? "本机使用中"
      : probe.sessionStatus === "ready" && probe.remoteUse === "clear"
        ? "启动预检通过"
        : probe.sessionStatus === "ready" && probe.remoteUse === "unknown"
          ? "尚未完成占用预检"
          : accountProbeSessionLabel(probe.sessionStatus);
  const authorization = probe.authorizationStatus === "verified" ? "官方授权已确认" : "官方授权未知";
  return `${session}；${authorization}`;
}

function environmentDefinitelyUnavailable(environment: AccountProbeEnvironmentState): boolean {
  return environment.busy
    || ["expired", "loginRequired", "invalid", "syncFailed", "accountMismatch", "missing", "unsupported", "offline"].includes(environment.probe.sessionStatus);
}

function accountProbeBadge(slot: Sv2ProfileSlot): string {
  if (!app?.sv2AccountIndicatorEnabled) {
    return `<span class="session-protection" title="账号登录指示器已关闭；未读取或解密此槽位的登录缓存。">${icon("shield", 14)} 登录指示器已关闭</span>`;
  }
  const environments = accountProbeEnvironments(slot);
  const launchable = environments.filter((environment) => environment.launchEnabled);
  const hasUsableEnvironment = launchable.some((environment) => environment.usable);
  const hasBusyEnvironment = launchable.some((environment) => environment.busy);
  const allUnavailable = launchable.length > 0 && launchable.every(environmentDefinitelyUnavailable);
  const probes = launchable.map((environment) => environment.probe);
  const notYetChecked = probes.some((probe) => probe.sessionStatus === "ready" && probe.remoteUse === "unknown");
  const reportedIssue = accountProbeIssue(probes.filter((probe) => probe.sessionStatus !== "missing"))
    ?? (probes.length > 0 && probes.every((probe) => probe.sessionStatus === "missing")
      ? accountProbeIssue(probes)
      : undefined);

  let label = "账号状态尚未确认";
  let emphasis = "";
  let iconName: "refresh" | "check" | "plug" = "refresh";
  if (reportedIssue) {
    label = reportedIssue.cardLabel;
    emphasis = reportedIssue.attention ? " attention" : "";
  } else if (hasUsableEnvironment) {
    label = "至少一个启动环境可用";
    iconName = "check";
  } else if (hasBusyEnvironment && allUnavailable) {
    label = "账号当前无空闲启动环境";
    emphasis = " attention";
    iconName = "plug";
  } else if (notYetChecked) {
    label = "账号状态尚未预检";
  }

  const tooltip = environments
    .map((environment) => {
      const detail = environment.probe.detail.trim();
      return `${environment.label}：${accountProbeEnvironmentSummary(environment)}${detail ? `。${detail}` : ""}`;
    })
    .join("；");
  return `<span class="session-protection${emphasis}" title="${escapeHtml(tooltip)}">${icon(iconName, 14)} ${escapeHtml(label)}</span>`;
}

function voiceInventoryBadge(slot: Sv2ProfileSlot): string {
  const probes = slot.concurrent.ready
    ? [slot.accountProbe, slot.concurrentAccountProbe]
    : [slot.accountProbe];
  const verifiedCounts = probes
    .filter((probe) => probe.authorizationStatus === "verified")
    .map((probe) => probe.authorizedVoiceCount);
  const reportedIssue = accountProbeIssue(probes.filter((probe) => probe.sessionStatus !== "missing"))
    ?? (verifiedCounts.length ? undefined : accountProbeIssue(probes));
  const unresolvedOfficial = reportedIssue
    ? { label: reportedIssue.authorizationLabel, title: reportedIssue.title }
    : { label: "官方授权尚未预检/未知", title: "尚无账号服务返回的授权结果。" };
  const official = !app?.sv2AccountIndicatorEnabled
    ? `<span class="voice-inventory unknown" title="账号登录指示器已关闭；官方授权摘要不会继续显示。">${icon("shield", 13)} 官方授权探测已关闭</span>`
    : reportedIssue
      ? `<span class="voice-inventory unknown" title="${escapeHtml(unresolvedOfficial.title)}">${icon("audio", 13)} ${escapeHtml(unresolvedOfficial.label)}</span>`
      : verifiedCounts.length
      ? `<span class="voice-inventory confirmed" title="账号服务已确认声库授权。">${icon("check", 13)} 官方授权 ${Math.max(...verifiedCounts)} 个</span>`
      : `<span class="voice-inventory unknown" title="${escapeHtml(unresolvedOfficial.title)}">${icon("audio", 13)} ${escapeHtml(unresolvedOfficial.label)}</span>`;
  const manualCount = slot.voiceInventory.manuallyConfirmedVoices.length;
  const manual = manualCount
    ? `<span class="voice-inventory confirmed" title="手工确认记录仅用于工程路由，不替代官方授权。">${icon("audio", 13)} 手工确认 ${manualCount} 个声库</span>`
    : "";
  return official + manual;
}

function accountProbeIdentity(probe: Sv2AccountProbe): { name?: string; email?: string } {
  return {
    name: probe.accountDisplayName?.trim() || undefined,
    email: probe.accountEmail?.trim() || undefined,
  };
}

function officialAccountIdentity(slot: Sv2ProfileSlot): { name?: string; email?: string } {
  if (!app?.sv2AccountIndicatorEnabled) return {};
  const probes = slot.concurrent.ready
    ? [slot.accountProbe, slot.concurrentAccountProbe]
    : [slot.accountProbe];
  const identities = probes
    .filter((probe) => probe.sessionStatus !== "accountMismatch")
    .map(accountProbeIdentity);
  return {
    name: identities.find((identity) => identity.name)?.name,
    email: identities.find((identity) => identity.email)?.email,
  };
}

function accountIdentityLabels(slot: Sv2ProfileSlot): string[] {
  const official = officialAccountIdentity(slot);
  const values = [official.name, official.email, slot.username.trim(), slot.email.trim()]
    .filter((value): value is string => Boolean(value));
  return values.filter((value, index) =>
    values.findIndex((candidate) => candidate.toLocaleLowerCase() === value.toLocaleLowerCase()) === index);
}

type AccountUseTone = "clear" | "unknown" | "in-use";

function accountUseStateForSlot(slot: Sv2ProfileSlot): { tone: AccountUseTone; label: string } {
  const environments = accountProbeEnvironments(slot).filter((environment) => environment.launchEnabled);
  const allLocallyBlocked = environments.length > 0 && environments.every((environment) => environment.localBlocked);
  if (!app?.sv2AccountIndicatorEnabled) {
    return allLocallyBlocked
      ? { tone: "in-use", label: "所有可启动环境当前均被本机占用" }
      : { tone: "unknown", label: "账号登录指示器已关闭" };
  }

  const probes = environments.map((environment) => environment.probe);
  const reportedIssue = accountProbeIssue(probes.filter((probe) => probe.sessionStatus !== "missing"))
    ?? (probes.length > 0 && probes.every((probe) => probe.sessionStatus === "missing")
      ? accountProbeIssue(probes)
      : undefined);
  if (reportedIssue) {
    return {
      tone: reportedIssue.attention ? "in-use" : "unknown",
      label: reportedIssue.cardLabel,
    };
  }
  if (environments.some((environment) => environment.usable)) {
    return { tone: "clear", label: "至少一个启动环境可用" };
  }

  const hasBusyEnvironment = environments.some((environment) => environment.busy);
  const allUnavailable = environments.length > 0 && environments.every(environmentDefinitelyUnavailable);
  if (hasBusyEnvironment && allUnavailable) {
    return { tone: "in-use", label: "所有可启动环境当前均不可用" };
  }
  return { tone: "unknown", label: "账号服务占用状态未知" };
}

function accountUseDot(state: { tone: AccountUseTone; label: string }): string {
  return `<span class="account-use-dot ${state.tone}" role="img" aria-label="${escapeHtml(state.label)}" title="${escapeHtml(state.label)}"></span>`;
}

async function launchConcurrentSlot(slotId: string, prepare: boolean): Promise<void> {
  if (prepare) profiles = await api.prepareSv2ConcurrentProfile(slotId);
  setFeedback(await api.launchSv2ConcurrentProfile(slotId));
  profiles = await api.sv2ProfileState();
}

async function prepareConcurrentSlotsWhenEnabled(): Promise<number> {
  if (!app?.sv2ConcurrentEnabled || !profiles?.concurrentProvider.available) return 0;
  let prepared = 0;
  for (const slot of profiles.slots.filter((item) => !item.concurrent.ready)) {
    profiles = await api.prepareSv2ConcurrentProfile(slot.id);
    prepared += 1;
  }
  return prepared;
}

function renderOnboarding(): void {
  root.innerHTML = `<main class="onboarding">
    <div class="onboarding-glow one"></div><div class="onboarding-glow two"></div>
    <section class="onboarding-card">
      <div class="onboarding-brand"><div class="brand-mark"><img class="brand-logo" src="/assets/synthv-toolbox-logo.png" alt="SynthV Toolbox" /></div><span>SynthV Toolbox</span></div>
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
      <p class="privacy-note">${icon("plug", 16)} AI 模式只在你通过浏览器授权官方提供商后发起请求；OAuth token 不会显示在界面中。</p>
    </section>
  </main>${busy ? '<div class="busy-overlay"><span class="spinner"></span></div>' : ""}`;
}

function renderPage(): string {
  switch (page) {
    case "home": return renderHome();
    case "accounts": return renderAccounts();
    case "toolbox": return renderToolbox();
    case "lyrics": return renderLyricsPage();
    case "history": return renderHistoryPage();
    case "copilot": return renderCopilot();
    case "components": return renderComponents();
    case "bridge": return renderBridge();
    case "mcp": return renderMcp();
    case "settings": return renderSettings();
  }
}

function renderAccounts(): string {
  if (!profiles) {
    return "";
  }
  if (!profiles.supported) {
    return `<section class="panel quiet-panel"><span class="mode-icon slate">${icon("users", 24)}</span><div><h2>当前平台不支持账号槽位</h2><p>${escapeHtml(profiles.recoveryDetail)}</p></div></section>`;
  }
  const windowsExtensions = supportsWindowsSv2Extensions();
  const accountIndicatorEnabled = windowsExtensions && Boolean(app?.sv2AccountIndicatorEnabled);
  const blockerCount = profiles.blockers.length;
  const blockerPanel = profiles.blockers.length ? `<div class="warning-card profile-blockers"><span>${icon("plug", 23)}</span><div><strong>普通槽位暂时不能切换</strong><p>${windowsExtensions ? "请先关闭下列普通 SV2 / 插件进程；已经准备好的隔离实例仍可单独启动。" : "请先保存并关闭下列 SV2 / 插件进程；macOS v1 不会强制结束进程或多开 SV2。"}<br />${profiles.blockers.map((blocker) => `${escapeHtml(blocker.name)}${blocker.pid ? ` (PID ${blocker.pid})` : ""}：${escapeHtml(blocker.reason)}`).join("<br />")}</p></div></div>` : "";
  if (profiles.recoveryRequired) {
    return `${blockerPanel}<div class="warning-card recovery-card"><span>${icon("sync", 23)}</span><div><strong>槽位需要人工恢复</strong><p>${escapeHtml(profiles.recoveryDetail)}</p><p>工具箱没有删除或覆盖任何目录。请先备份下方路径，再检查目录实况。</p></div><button class="secondary" data-profile-refresh>${icon("sync", 16)} 重新检查</button></div>
      <section class="panel"><dl class="detail-list"><div><dt>官方路径</dt><dd><code>${escapeHtml(profiles.canonicalPath)}</code></dd></div><div><dt>保管区</dt><dd><code>${escapeHtml(profiles.vaultPath)}</code></dd></div></dl></section>`;
  }
  const concurrentProviderAvailable = windowsExtensions && profiles.concurrentProvider.available;
  const providerDetail = profiles.concurrentProvider.detail;
  const cards = profiles.slots.map((slot) => {
    const lastUsed = slot.lastActivatedAtUtc ? new Date(slot.lastActivatedAtUtc).toLocaleString("zh-CN") : "尚未启动";
    const initial = Array.from(slot.displayName)[0] ?? "S";
    const color = /^#[0-9a-f]{6}$/i.test(slot.color) ? slot.color : "#6D5CE7";
    const officialIdentity = windowsExtensions ? officialAccountIdentity(slot) : {};
    const identity = accountIdentityLabels(slot);
    const identityFromActiveSession = windowsExtensions && [slot.accountProbe, slot.concurrentAccountProbe]
      .some((probe) => probe.sessionStatus === "inUse" && (probe.accountDisplayName || probe.accountEmail));
    const identityTitle = officialIdentity.name || officialIdentity.email
      ? identityFromActiveSession
        ? "账号正在使用；姓名与邮箱来自上次预检，关闭客户端后可手工刷新。"
        : "账号姓名与邮箱优先显示本次预检读取的标准 JWT name/email 声明；其后为本地自定义标签。"
      : "当前仅显示本地自定义账号标签。";
    const useState = windowsExtensions
      ? accountUseStateForSlot(slot)
      : blockerCount
        ? { tone: "in-use" as const, label: "当前 SV2 环境正在本机使用" }
        : { tone: "unknown" as const, label: "仅管理本地数据槽位" };
    const concurrentRunning = windowsExtensions && slot.concurrent.runningPids.length > 0;
    const isolatedLabel = concurrentRunning ? "隔离运行中" : slot.concurrent.ready ? "隔离启动" : "准备隔离";
    const concurrentEnabled = windowsExtensions && Boolean(app?.sv2ConcurrentEnabled);
    const isolatedDisabled = concurrentRunning || !concurrentProviderAvailable || !concurrentEnabled;
    const isolatedTitle = concurrentRunning
      ? "该隔离实例已在运行"
      : !concurrentEnabled
        ? "隔离功能已在全局设置中关闭"
        : providerDetail;
    const localVoiceFact = slot.voiceInventory.manuallyConfirmedVoices.length
      ? `<span class="voice-inventory confirmed" title="手工确认记录仅用于工程路由，不替代官方授权。">${icon("audio", 13)} 手工确认 ${slot.voiceInventory.manuallyConfirmedVoices.length} 个声库</span>`
      : `<span class="voice-inventory unknown" title="macOS v1 不读取或解密登录缓存。">${icon("shield", 13)} 未读取账号授权</span>`;
    const windowsLaunchActions = concurrentEnabled && slot.concurrent.ready
      ? `<button class="primary" data-profile-concurrent-launch="${slot.id}" ${isolatedDisabled ? `disabled title="${escapeHtml(isolatedTitle)}"` : ""}>${icon("boxes", 16)} ${isolatedLabel}</button><button class="secondary" data-profile-launch="${slot.id}">${icon("play", 16)} ${slot.isActive ? "普通启动" : "切换并启动"}</button>`
      : `<button class="primary" data-profile-launch="${slot.id}">${icon("play", 16)} ${slot.isActive ? "普通启动" : "切换并启动"}</button><button class="secondary" data-profile-concurrent-prepare="${slot.id}" ${isolatedDisabled ? `disabled title="${escapeHtml(isolatedTitle)}"` : ""}>${icon("download", 16)} ${isolatedLabel}</button>`;
    const launchActions = windowsExtensions
      ? windowsLaunchActions
      : `<button class="primary" data-profile-launch="${slot.id}">${icon("play", 16)} ${slot.isActive ? "普通启动" : "切换并启动"}</button>`;
    return `<article class="account-launch-card ${slot.isActive ? "active" : ""}" style="--profile-color:${color}">
      <div class="account-card-main"><span class="profile-avatar compact">${escapeHtml(initial)}</span><div class="account-card-identity"><div class="profile-title-line"><h2>${escapeHtml(slot.displayName)}</h2>${accountUseDot(useState)}${slot.isActive ? '<span class="profile-active-badge">默认</span>' : ""}</div>${identity.length ? `<span class="profile-identity" title="${escapeHtml(identityTitle)}">${identity.map(escapeHtml).join(" · ")}</span>` : `<span class="profile-identity empty">${accountIndicatorEnabled ? "尚未读取 JWT 姓名/邮箱" : "未设置账号标签"}</span>`}</div><div class="account-card-actions">${windowsExtensions ? `<button class="icon-plain" data-profile-refresh-slot="${slot.id}" title="刷新此账号状态" aria-label="刷新 ${escapeHtml(slot.displayName)}">${icon("refresh", 18)}</button>` : ""}<button class="icon-plain" data-manage-slot="${slot.id}" title="设置" aria-label="设置 ${escapeHtml(slot.displayName)}">${icon("settings", 18)}</button><button class="icon-plain danger" data-delete-profile="${slot.id}" title="删除" aria-label="删除 ${escapeHtml(slot.displayName)}">${icon("trash", 18)}</button><button class="icon-plain" data-profile-activate="${slot.id}" title="切换默认账户" aria-label="将 ${escapeHtml(slot.displayName)} 设为默认账户" ${slot.isActive ? "disabled" : ""}>${icon("check", 18)}</button></div></div>
      <div class="account-card-facts">${windowsExtensions ? `${accountProbeBadge(slot)}${voiceInventoryBadge(slot)}` : localVoiceFact}<span>${icon("sync", 13)} ${escapeHtml(lastUsed)}</span>${concurrentRunning ? `<span class="running">${icon("plug", 13)} ${slot.concurrent.runningPids.length} 个隔离进程</span>` : ""}</div>
      <div class="account-launch-actions">${launchActions}</div>
    </article>`;
  }).join("");
  return `${blockerPanel}<div class="account-launch-grid">${cards || `<button class="empty-account-card" data-account-manager="add">${icon("plus", 22)}<strong>添加第一个账号</strong><span>导入当前环境或创建空槽位</span></button>`}</div>`;
}

function supportsWindowsSv2Extensions(): boolean {
  return app?.platform === "windows" || app?.platform === "preview";
}

function renderAccountManager(): string {
  if (!profiles) return "";
  const managedSlot = profiles.slots.find((slot) => slot.id === managedProfileSlotId)
    ?? profiles.slots.find((slot) => slot.isActive)
    ?? profiles.slots[0];
  if (managedSlot) managedProfileSlotId = managedSlot.id;
  let body = "";
  if (accountManagerSection === "profile" && !supportsWindowsSv2Extensions()) {
    body = managedSlot ? `<div class="account-manager-pane"><div class="manager-pane-heading"><div><h3>${escapeHtml(managedSlot.displayName)}</h3><p>macOS v1 只切换本机完整 SV2 数据目录；不会读取、解密或刷新登录缓存，也不会同时运行多个实例。</p></div>${managedSlot.isActive ? '<span class="profile-active-badge">当前默认</span>' : ""}</div>
      <form class="profile-identity-form compact-form" data-profile-identity-form="${managedSlot.id}"><label>自定义用户名标签<input name="username" value="${escapeHtml(managedSlot.username)}" maxlength="100" placeholder="用于区分槽位" /></label><label>自定义邮箱标签<input name="email" type="email" value="${escapeHtml(managedSlot.email)}" maxlength="254" placeholder="name@example.com" /></label><button class="secondary">保存标签</button><small>这些本地标签仅用于区分槽位，不会修改或推断 Dreamtonics 账号身份。</small></form>
      <form class="profile-rename compact-form" data-profile-rename-form="${managedSlot.id}"><label>槽位显示名称<input value="${escapeHtml(managedSlot.displayName)}" maxlength="64" required /></label><button class="secondary">重命名</button></form>
      <form class="voice-license-form" data-profile-voice-form="${managedSlot.id}"><div class="voice-license-heading"><div><strong>补充手工确认声库</strong><small>每行记录一个完整产品名称；仅用于补充工程路由，不替代官方授权。</small></div></div><textarea name="voices" rows="4" maxlength="16384" placeholder="例如：&#10;Mai 2&#10;SOLARIA">${escapeHtml(managedSlot.voiceInventory.manuallyConfirmedVoices.join("\n"))}</textarea><button class="secondary" type="submit">保存确认记录</button></form>
      <div class="manager-action-row">${managedSlot.isActive ? "" : `<button class="secondary" data-profile-activate="${managedSlot.id}">${icon("check", 15)} 设为默认账号</button>`}<button class="secondary" data-profile-folder="${managedSlot.id}">${icon("folder", 15)} 打开槽位数据目录</button><button class="secondary component-remove-action" data-delete-profile="${managedSlot.id}">${icon("trash", 15)} 删除账号</button></div>
      <dl class="profile-storage-list compact"><div><dt>槽位数据</dt><dd><code title="${escapeHtml(managedSlot.dataPath)}">${escapeHtml(managedSlot.dataPath)}</code></dd></div></dl></div>` : '<div class="empty-inline">尚无账号，请先添加一个槽位。</div>';
  } else if (accountManagerSection === "profile") {
    const authorizationProbe = managedSlot?.accountProbe.authorizationStatus === "verified"
      ? managedSlot.accountProbe
      : managedSlot?.concurrentAccountProbe.authorizationStatus === "verified"
        ? managedSlot.concurrentAccountProbe
        : undefined;
    const authorizations = authorizationProbe?.authorizedVoices ?? [];
    const authorizationStatus = authorizationProbe?.authorizationStatus === "verified";
    const managedProbes = managedSlot
      ? [managedSlot.accountProbe, ...(managedSlot.concurrent.ready ? [managedSlot.concurrentAccountProbe] : [])]
      : [];
    const managedIssue = accountProbeIssue(managedProbes.filter((probe) => probe.sessionStatus !== "missing"))
      ?? (managedProbes.length > 0 && managedProbes.every((probe) => probe.sessionStatus === "missing")
        ? accountProbeIssue(managedProbes)
        : undefined);
    const authorizationUnavailable = managedIssue?.authorizationLabel ?? "授权尚未预检或结果未知";
    const officialIdentity = managedSlot ? officialAccountIdentity(managedSlot) : {};
    const officialIdentitySummary = [
      officialIdentity.name ? `姓名：${officialIdentity.name}` : undefined,
      officialIdentity.email ? `邮箱：${officialIdentity.email}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
    const managedProbeSummary = managedSlot
      ? accountProbeEnvironments(managedSlot)
        .map((environment) => {
          const identity = accountProbeIdentity(environment.probe);
          const identitySummary = [
            identity.name ? `JWT 姓名：${identity.name}` : undefined,
            identity.email ? `JWT 邮箱：${identity.email}` : undefined,
          ].filter(Boolean).join("、");
          return `${environment.label}：${accountProbeEnvironmentSummary(environment)}${identitySummary ? `；${identitySummary}` : ""}`;
        })
        .join("；")
      : "";
    const authorizationSummary = authorizationStatus
      ? managedIssue
        ? `账号服务已确认 ${authorizations.length} 个声库授权；${managedIssue.authorizationLabel}。`
        : `账号服务已确认 ${authorizations.length} 个声库授权。`
      : authorizationUnavailable;
    const authorizationList = authorizationStatus
      ? authorizations.length
        ? `<div class="authorization-list">${authorizations.map((voice) => `<span>${icon("audio", 14)} ${escapeHtml(voice)}</span>`).join("")}</div>`
        : '<div class="empty-inline">当前账号没有可用声库授权。</div>'
      : `<div class="empty-inline">${escapeHtml(authorizationUnavailable)}。</div>`;
    body = managedSlot ? `<div class="account-manager-pane"><div class="manager-pane-heading"><div><h3>${escapeHtml(managedSlot.displayName)}</h3><p>${officialIdentitySummary ? `标准 JWT 身份：${escapeHtml(officialIdentitySummary)}` : "标准 JWT name/email 尚未读取；下方仅显示本地自定义标签。"}</p><p title="${escapeHtml(managedIssue?.title ?? managedProbeSummary)}">预检状态：${escapeHtml(managedProbeSummary)}</p></div>${managedSlot.isActive ? '<span class="profile-active-badge">当前默认</span>' : ""}</div>
      <form class="profile-identity-form compact-form" data-profile-identity-form="${managedSlot.id}"><label>自定义用户名标签<input name="username" value="${escapeHtml(managedSlot.username)}" maxlength="100" placeholder="${escapeHtml(officialIdentity.name ?? "用于区分账号")}" /></label><label>自定义邮箱标签<input name="email" type="email" value="${escapeHtml(managedSlot.email)}" maxlength="254" placeholder="${escapeHtml(officialIdentity.email ?? "name@example.com")}" /></label><button class="secondary">保存标签</button><small>标准 JWT 的 name/email 只读显示在上方；这些本地标签不会修改或冒充 Dreamtonics 账号身份。</small></form>
      <form class="profile-rename compact-form" data-profile-rename-form="${managedSlot.id}"><label>槽位显示名称<input value="${escapeHtml(managedSlot.displayName)}" maxlength="64" required /></label><button class="secondary">重命名</button></form>
      <section class="voice-license-form authorization-panel"><div class="voice-license-heading"><div><strong>可用授权</strong><small>${escapeHtml(authorizationSummary)}</small></div><span class="inventory-status ${authorizationStatus ? "verified" : "unknown"}">${authorizationStatus ? `${authorizations.length} 个授权` : "未读取"}</span></div>${authorizationList}</section>
      <form class="voice-license-form" data-profile-voice-form="${managedSlot.id}"><div class="voice-license-heading"><div><strong>补充手工确认声库</strong><small>每行记录一个完整产品名称；仅用于补充工程路由，不替代官方授权。</small></div></div><textarea name="voices" rows="4" maxlength="16384" placeholder="例如：&#10;Mai 2&#10;SOLARIA">${escapeHtml(managedSlot.voiceInventory.manuallyConfirmedVoices.join("\n"))}</textarea><button class="secondary" type="submit">保存确认记录</button></form>
      <div class="manager-action-row">${managedSlot.isActive ? "" : `<button class="secondary" data-profile-activate="${managedSlot.id}">${icon("check", 15)} 设为默认账号</button>`}<button class="secondary" data-profile-folder="${managedSlot.id}">${icon("folder", 15)} 打开普通数据目录</button>${managedSlot.concurrent.ready ? `<button class="secondary" data-profile-concurrent-folder="${managedSlot.id}">${icon("folder", 15)} 打开隔离目录</button>` : ""}<button class="secondary component-remove-action" data-delete-profile="${managedSlot.id}">${icon("trash", 15)} 删除账号</button></div>
      <dl class="profile-storage-list compact"><div><dt>普通数据</dt><dd><code title="${escapeHtml(managedSlot.dataPath)}">${escapeHtml(managedSlot.dataPath)}</code></dd></div>${managedSlot.concurrent.ready ? `<div><dt>隔离数据</dt><dd><code title="${escapeHtml(managedSlot.concurrent.dataPath)}">${escapeHtml(managedSlot.concurrent.dataPath)}</code></dd></div>` : ""}</dl></div>` : '<div class="empty-inline">尚无账号，请先添加一个槽位。</div>';
  } else if (accountManagerSection === "global" && !supportsWindowsSv2Extensions()) {
    body = `<section class="panel quiet-panel"><span class="mode-icon slate">${icon("shield", 24)}</span><div><h3>macOS 槽位范围</h3><p>当前版本只支持顺序切换数据槽位。账号登录预检、授权读取和并发隔离仍仅在 Windows 提供。</p></div></section>`;
  } else if (accountManagerSection === "global") {
    body = `<form id="sv2-global-settings-form" class="isolation-defaults-form manager-defaults"><div><strong>全局设置</strong><small>声库数据库由所有槽位和隔离实例共享；登录态、WebView 与应用设置仍分别隔离。</small></div><label class="fluent-switch"><input name="accountProbeEnabled" type="checkbox" ${app?.sv2AccountIndicatorEnabled ? "checked" : ""} /><span></span>启用账号登录指示器</label><label class="fluent-switch"><input name="concurrentEnabled" type="checkbox" ${app?.sv2ConcurrentEnabled ? "checked" : ""} /><span></span>启用隔离功能</label><button class="secondary" type="submit">保存全局设置</button></form>`;
  } else {
    body = `<div class="account-add-grid">${profiles.canImportCurrent ? `<section><span class="feature-icon emerald">${icon("folder", 20)}</span><h3>导入当前环境</h3><p>把现有官方数据目录纳入槽位，不移动账号文件。</p><form id="profile-import-form" class="profile-create-form"><input id="profile-import-name" maxlength="64" required placeholder="例如 主账号" /><button class="primary">导入</button></form></section>` : ""}<section><span class="feature-icon blue">${icon("plus", 20)}</span><h3>创建空槽位</h3><p>首次启动后，在 SV2 官方登录页面完成登录。</p><form id="profile-create-form" class="profile-create-form"><input id="profile-create-name" maxlength="64" required placeholder="例如 制作账号" /><button class="secondary">创建</button></form></section></div><div class="manager-safety">${icon("check", 17)}<span><strong>账号数据保持原样</strong><small>工具箱不会伪造登录或绕过联网验证。</small></span></div>`;
  }
  const tabs = "";
  return `<div class="dialog-backdrop account-manager-backdrop" role="presentation"><section class="account-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="account-manager-title"><header><div><span class="eyebrow">SV2 ACCOUNT MANAGER</span><h2 id="account-manager-title">${accountManagerSection === "profile" ? "账号设置" : "账号管理"}</h2></div><button class="icon-plain" data-close-account-manager title="关闭" aria-label="关闭账号管理">×</button></header>${tabs}<div class="account-manager-body">${body}</div></section></div>`;
}

function renderHome(): string {
  if (!app) return "";
  const current = app;
  const ready = app.components.filter((component) => component.installed).length;
  return `<div class="hero-panel">
      <div><span class="eyebrow">${app.mode === "ai" ? "AI workspace" : "Local utility workspace"}</span>
        <h2>${app.mode === "ai" ? "把重复操作交给 Copilot，创作判断留给你。" : "所有核心工具，集中在一个安静的工作区。"}</h2>
        <p>${app.mode === "ai" ? "从音频分析到 SynthV 工程操作，AI 只通过你启用的能力和 MCP 工具工作。" : "无需模型配置即可进行确定性的音频、MIDI、工程和 Bridge 操作。"}</p>
        <div class="hero-actions"><button class="primary" data-page="${app.mode === "ai" ? "copilot" : "toolbox"}">${icon(app.mode === "ai" ? "bot" : "toolbox", 18)} ${app.mode === "ai" ? "打开 Copilot" : "打开工具箱"}</button><button class="secondary" data-page="bridge">检查 Bridge</button></div>
      </div>
      <div class="hero-orb"><div><img class="brand-logo" src="/assets/synthv-toolbox-logo.png" alt="SynthV Toolbox" /></div><span>${app.mode === "ai" ? "COPILOT READY" : "LOCAL FIRST"}</span></div>
    </div>
    <div class="stats-grid">
      <article class="stat-card"><span>运行模式</span><strong>${app.mode === "ai" ? "AI 增强" : "纯工具箱"}</strong><small>${app.mode === "ai" ? aiConnectionSummary() : "模型运行时已停用"}</small></article>
      <article class="stat-card"><span>本地组件</span><strong>${ready} / ${app.components.length}</strong><small>已检测为可用</small></article>
      <article class="stat-card"><span>SynthV</span><strong>${app.installations.length ? "已发现" : "未发现"}</strong><small>${app.installations[0]?.displayName ?? "可手动选择 scripts 目录"}</small></article>
      <article class="stat-card"><span>工具连接</span><strong>${app.bridgeConnected ? "在线" : "离线"}</strong><small>${app.mode === "ai" ? `${app.mcpServers.filter((server) => server.enabled).length} 个 MCP 已启用` : "Bridge 可独立使用"}</small></article>
    </div>
    <section class="section-block"><div class="section-heading"><div><h2>快速开始</h2><p>继续最近的工作，或打开常用能力。</p></div></div>
      <div class="quick-grid">${features.filter((feature) => feature.homePriority !== undefined).sort((left, right) => (left.homePriority ?? 0) - (right.homePriority ?? 0)).slice(0, 3).map((feature) => {
        const availability = featureAvailability(feature, current);
        const target = availability.route ? `data-page="${availability.route}"` : `data-feature="${feature.id}"`;
        const detail = availability.tone === "ready" ? `${feature.base[0]} · ${feature.base[1]}` : availability.label;
        return `<button class="quick-card ${availability.tone}" ${target} ${availability.disabled ? "disabled" : ""}><span class="feature-icon ${feature.accent}">${icon(feature.icon, 23)}</span><span><strong>${feature.title}</strong><small>${escapeHtml(detail)}</small></span>${icon("arrow", 18)}</button>`;
      }).join("")}</div>
    </section>`;
}

function renderHistoryPage(): string {
  const history = creativeHistory.length
    ? creativeHistory.map((item) => `<article class="timeline-item"><span class="status-dot online"></span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.summary)}</small><code>${escapeHtml(new Date(item.createdAtUtc).toLocaleString("zh-CN"))}${item.outputPath ? ` · ${escapeHtml(item.outputPath)}` : ""}</code></div></article>`).join("")
    : '<div class="empty-inline">还没有工作流记录；完成一次工具操作后会自动出现在这里。</div>';
  const checkpoints = projectCheckpoints.length
    ? projectCheckpoints.map((item) => `<article class="checkpoint-item"><span class="feature-icon blue">${icon("shield", 17)}</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.sourcePath)}</small><code>SHA-256 ${escapeHtml(item.sourceSha256.slice(0, 16))}… · ${new Date(item.createdAtUtc).toLocaleString("zh-CN")}</code></div><button class="secondary compact" data-restore-checkpoint="${escapeHtml(item.id)}">恢复副本</button></article>`).join("")
    : '<div class="empty-inline">还没有工程检查点。</div>';
  return `<section class="panel history-intro"><span class="feature-icon blue">${icon("history", 22)}</span><div><span class="eyebrow">LOCAL HISTORY</span><h2>工作流记录默认开启</h2><p>本地保存参数摘要、执行结果和输出位置，方便回看；工程检查点需要你主动创建，恢复时只生成新副本。</p></div><span class="availability ready">默认记录</span></section>
    <div class="workflow-split history-checkpoint-grid"><section class="panel"><div class="section-heading"><div><h2>创建工程检查点</h2><p>为已保存的 .svp 建立带 SHA-256 的只读快照。</p></div></div><form id="checkpoint-form" class="workflow-form workflow-wide"><label>.svp 工程路径<input id="checkpoint-project" required /></label><label>检查点名称<input id="checkpoint-label" required maxlength="100" value="调声前" /></label><button class="primary">${icon("shield", 16)} 创建检查点</button></form></section><section class="panel"><div class="section-heading"><div><h2>工程检查点</h2><p>${projectCheckpoints.length} 个可恢复快照</p></div></div><div class="checkpoint-list">${checkpoints}</div></section></div>
    <section class="panel workflow-history"><div class="section-heading"><div><h2>工作流历史</h2><p>按时间保留工具输入摘要、组件结果和输出位置；较大的结果会自动截断历史副本。</p></div><button class="secondary compact" data-refresh-history>${icon("sync", 15)} 刷新</button></div><div class="timeline-list">${history}</div></section>`;
}

interface FeatureAvailability {
  label: string;
  tone: "ready" | "warning" | "blocked";
  actionLabel: string;
  route?: Page;
  disabled?: boolean;
}

function featureAvailability(feature: Feature, current: BootstrapState): FeatureAvailability {
  if (feature.windowsOnly && current.platform !== "windows" && current.platform !== "preview") {
    return { label: "仅 Windows", tone: "blocked", actionLabel: "当前平台不可用", disabled: true };
  }
  const missing = (feature.componentIds ?? [])
    .map((id) => current.components.find((component) => component.id === id))
    .filter((component) => !component?.installed);
  if (missing.length) {
    return { label: `缺少 ${missing.length} 个组件`, tone: "warning", actionLabel: "前往组件中心", route: "components" };
  }
  if (feature.requiresConnectedBridge && !current.bridgeConnected) {
    return { label: "Bridge 未连接", tone: "warning", actionLabel: "连接 Bridge", route: "bridge" };
  }
  return {
    label: "可直接使用",
    tone: "ready",
    actionLabel: "打开工具",
  };
}

function groupFeatures(group: ToolGroup): Feature[] {
  return group.featureIds.flatMap((id) => {
    const feature = features.find((item) => item.id === id);
    return feature ? [feature] : [];
  });
}

function featureTarget(feature: Feature, availability: FeatureAvailability): string {
  return availability.route ? `data-page="${availability.route}"` : `data-feature="${feature.id}"`;
}

function renderToolGroupGrid(current: BootstrapState): string {
  return `<div class="tool-group-grid">${toolGroups.map((group) => {
    const entries = groupFeatures(group).map((feature) => ({
      feature,
      availability: featureAvailability(feature, current),
    }));
    const directCount = entries.filter((entry) => entry.availability.tone === "ready").length;
    const primary = entries.find((entry) => entry.availability.tone === "ready")
      ?? entries.find((entry) => !entry.availability.disabled)
      ?? entries[0];
    if (!primary) return "";
    const tone = directCount > 0 ? "ready" : entries.some((entry) => entry.availability.tone === "warning") ? "warning" : "blocked";
    const status = directCount === entries.length ? `${entries.length} 项可用` : directCount ? `${directCount} / ${entries.length} 项可用` : primary.availability.label;
    const action = directCount > 0 ? `打开 ${group.title}` : primary.availability.actionLabel;
    return `<article class="tool-group-card ${tone}">
      <div class="tool-group-head"><span class="feature-icon ${group.accent}">${icon(group.icon, 25)}</span><span class="availability ${tone}">${escapeHtml(status)}</span></div>
      <h3>${escapeHtml(group.title)}</h3><p>${escapeHtml(group.description)}</p>
      <div class="tool-group-items">${entries.map(({ feature, availability }) => `<div class="tool-group-item ${availability.tone}"><span>${icon(availability.tone === "ready" ? "check" : availability.tone === "warning" ? "plug" : "shield", 14)}</span><strong>${escapeHtml(feature.title)}</strong><small>${escapeHtml(availability.label)}</small></div>`).join("")}</div>
      <button class="card-action ${tone !== "ready" ? "restricted" : ""}" ${featureTarget(primary.feature, primary.availability)} ${primary.availability.disabled ? "disabled" : ""}>${escapeHtml(action)} ${icon("arrow", 17)}</button>
    </article>`;
  }).join("")}</div>`;
}

function renderToolbox(): string {
  if (!app) return "";
  const current = app;
  return `${activeWorkflow ? renderWorkflowPanel(activeWorkflow) : ""}<section class="toolbox-section"><div class="section-heading"><div><h2>按任务选择</h2><p>常用本地能力默认可用；具体工具只在进入任务组后显示，Bridge、组件和平台限制仍会明确提示。</p></div><span class="tool-group-count">${toolGroups.length} 个任务组</span></div>
    ${renderToolGroupGrid(current)}</section>
    ${current.mode === "toolbox" ? `<div class="upgrade-banner"><span class="mode-icon purple">${icon("sparkles", 24)}</span><div><strong>需要自动纠正、置信度复核或高级参数微调？</strong><p>切换到 AI 模式即可在现有工具之上启用智能增强。</p></div><button class="secondary" data-enable-ai>了解 AI 模式</button></div>` : ""}`;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function resultMetric(label: string, value: unknown, tone = ""): string {
  return `<div class="result-metric ${tone}"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`;
}

function renderDiagnosticResult(data: JsonObject): string | undefined {
  const report = asObject(data.report) ?? data;
  if (typeof report.ok !== "boolean" || !Array.isArray(report.issues)) return undefined;
  const issues = report.issues.map(asObject).filter((item): item is JsonObject => Boolean(item));
  const errors = issues.filter((item) => item.severity === "error").length;
  const warnings = issues.filter((item) => item.severity === "warning").length;
  const inspected = typeof report.inspectedItems === "number" ? report.inspectedItems : 0;
  const list = issues.length ? `<div class="diagnostic-list">${issues.map((issue) => {
    const severity = issue.severity === "error" ? "error" : issue.severity === "warning" ? "warning" : "info";
    const severityLabel = severity === "error" ? "错误" : severity === "warning" ? "警告" : "提示";
    return `<article class="diagnostic-item ${severity}"><span>${severityLabel}</span><div><strong>${escapeHtml(issue.message ?? issue.code ?? "诊断项")}</strong>${issue.location ? `<code>${escapeHtml(issue.location)}</code>` : ""}${issue.suggestion ? `<small>${escapeHtml(issue.suggestion)}</small>` : ""}</div><code>${escapeHtml(issue.code ?? "")}</code></article>`;
  }).join("")}</div>` : `<div class="result-clear">${icon("shield", 18)} 未发现需要处理的问题。</div>`;
  return `<div class="result-dashboard">${resultMetric("检查项目", inspected)}${resultMetric("错误", errors, errors ? "error" : "")}${resultMetric("警告", warnings, warnings ? "warning" : "")}${resultMetric("结论", report.ok ? "通过" : "需处理", report.ok ? "success" : "error")}</div>${list}`;
}

function renderBatchResult(data: JsonObject): string | undefined {
  if (!Array.isArray(data.items) || typeof data.completed !== "number" || typeof data.failed !== "number") return undefined;
  const items = data.items.map(asObject).filter((item): item is JsonObject => Boolean(item));
  return `<div class="result-dashboard">${resultMetric("总计", items.length)}${resultMetric("完成", data.completed, "success")}${resultMetric("失败", data.failed, data.failed ? "error" : "")}</div><div class="batch-result-list">${items.map((item) => {
    const completed = item.status === "completed";
    const nested = asObject(item.result);
    return `<article class="batch-result-item ${completed ? "completed" : "failed"}"><span>${icon(completed ? "check" : "plug", 15)}</span><div><strong>${escapeHtml(item.inputPath ?? "未命名输入")}</strong><small>${escapeHtml(completed ? nested?.summary ?? "处理完成" : item.error ?? "处理失败")}</small></div><span>${completed ? "完成" : "失败"}</span></article>`;
  }).join("")}</div>`;
}

function renderScalarResult(data: JsonObject): string {
  const source = asObject(data.probe) ?? data;
  const definitions: Array<[string, string, (value: unknown) => unknown]> = [
    ["duration_sec", "时长", (value) => typeof value === "number" ? `${value} 秒` : value],
    ["bpm", "BPM", (value) => value],
    ["key_guess", "调性估计", (value) => value],
    ["peak_dbfs", "峰值", (value) => typeof value === "number" ? `${value} dBFS` : value],
    ["rms_dbfs", "RMS", (value) => typeof value === "number" ? `${value} dBFS` : value],
    ["clipped_sample_ratio", "削波样本", (value) => typeof value === "number" ? `${(value * 100).toFixed(3)}%` : value],
    ["silent_frame_ratio", "静音帧", (value) => typeof value === "number" ? `${(value * 100).toFixed(1)}%` : value],
    ["brightness_trend", "明亮度趋势", (value) => value],
    ["copied", "已复制", (value) => value],
    ["updated", "已更新", (value) => value],
    ["skipped", "已跳过", (value) => value],
    ["conflicts", "冲突", (value) => value],
  ];
  const metrics = definitions
    .filter(([key]) => source[key] !== undefined)
    .map(([key, label, format]) => resultMetric(label, format(source[key])))
    .join("");
  if (metrics) return `<div class="result-dashboard compact">${metrics}</div>`;
  const scalars = Object.entries(data)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 6);
  return scalars.length ? `<div class="result-dashboard compact">${scalars.map(([key, value]) => resultMetric(key, value)).join("")}</div>` : "";
}

function renderLyricTemplateResult(data: JsonObject): string | undefined {
  if (data.language !== "zh-CN" || !Array.isArray(data.sections) || typeof data.totalLines !== "number") return undefined;
  const sections = data.sections.map(asObject).filter((section): section is JsonObject => Boolean(section));
  const targets = asObject(data.rhymeTargets) ?? {};
  return `<div class="result-dashboard compact">${resultMetric("歌曲", data.title ?? "未命名歌曲")}${resultMetric("段落", sections.length)}${resultMetric("总行数", data.totalLines)}${resultMetric("韵脚", Object.entries(targets).filter(([, value]) => value).map(([key, value]) => `${key}:${value}`).join(" · ") || "自由")}</div><div class="lyric-template-preview">${sections.map((section) => {
    const lines = Array.isArray(section.lines) ? section.lines.map(asObject).filter((line): line is JsonObject => Boolean(line)) : [];
    return `<article><header><strong>${escapeHtml(section.label ?? "未命名段落")}</strong><span>${escapeHtml(section.rhymeScheme ?? "-")} · ${lines.length} 行</span></header>${lines.map((line) => `<div><span>${escapeHtml(line.lineNumber)}</span><p>${escapeHtml(line.placeholder ?? "填写歌词")}</p>${line.targetRhyme ? `<code>${escapeHtml(line.targetRhyme)}</code>` : ""}</div>`).join("")}</article>`;
  }).join("")}</div><button type="button" class="secondary" data-insert-lyric-template>${icon("plus", 15)} 把结构骨架加入歌词草稿</button>`;
}

function renderAbAudioResult(data: JsonObject): string | undefined {
  const metrics = asObject(data.metrics);
  if (metrics && typeof data.requestedStartSeconds === "number" && typeof data.requestedEndSeconds === "number") {
    return `<div class="result-dashboard compact">${resultMetric("范围", `${Number(data.requestedStartSeconds).toFixed(2)}–${Number(data.requestedEndSeconds).toFixed(2)} s`)}${resultMetric("时长", `${Number(metrics.durationSeconds ?? 0).toFixed(2)} s`)}${resultMetric("峰值", `${Number(metrics.peakDbfs ?? 0).toFixed(1)} dBFS`)}${resultMetric("RMS", `${Number(metrics.rmsDbfs ?? 0).toFixed(1)} dBFS`)}${resultMetric("边界误差", `±${Number(data.boundaryUncertaintyMs ?? 0).toFixed(0)} ms`)}${resultMetric("中断", data.discontinuities ?? 0, Number(data.discontinuities ?? 0) ? "error" : "success")}</div>`;
  }
  if (typeof data.correlation === "number" && typeof data.similarityPercent === "number") {
    const labels: Record<string, string> = {
      "near-identical": "几乎相同",
      "subtle-change": "细微变化",
      "material-change": "明显变化",
      "large-change-or-misalignment": "大幅变化 / 检查对齐",
    };
    return `<div class="result-dashboard compact">${resultMetric("分类", labels[String(data.classification)] ?? data.classification ?? "未知")}${resultMetric("相似度", `${Number(data.similarityPercent).toFixed(1)}%`)}${resultMetric("相关性", Number(data.correlation).toFixed(4))}${resultMetric("对齐偏移", `${Number(data.alignedLagMs ?? 0) >= 0 ? "+" : ""}${Number(data.alignedLagMs ?? 0).toFixed(1)} ms`)}${resultMetric("响度变化", `${Number(data.loudnessDeltaDb ?? 0) >= 0 ? "+" : ""}${Number(data.loudnessDeltaDb ?? 0).toFixed(2)} dB`)}${resultMetric("高频变化", `${Number(data.highFrequencyDeltaDb ?? 0) >= 0 ? "+" : ""}${Number(data.highFrequencyDeltaDb ?? 0).toFixed(2)} dB`)}</div>`;
  }
  return undefined;
}

function renderWorkflowResult(result: WorkflowResult, ai: boolean): string {
  const data = asObject(result.data) ?? {};
  const lyricTemplate = renderLyricTemplateResult(data);
  const abAudio = renderAbAudioResult(data);
  const diagnostic = renderDiagnosticResult(data);
  const batch = renderBatchResult(data);
  const scalar = renderScalarResult(data);
  const structured = lyricTemplate ?? abAudio ?? (diagnostic
    ? `${asObject(data.probe) ? scalar : ""}${diagnostic}`
    : batch ?? scalar);
  const raw = `<details class="raw-result"><summary>${icon("file", 14)} 查看原始结构化数据</summary><pre>${escapeHtml(JSON.stringify(result.data, null, 2))}</pre></details>`;
  const exportActions = `<div class="result-actions"><span>导出当前报告</span><button class="secondary" data-export-workflow="markdown">${icon("download", 15)} Markdown</button><button class="secondary" data-export-workflow="json">${icon("download", 15)} JSON</button></div>`;
  const review = result.aiReview
    ? `<div class="ai-review"><strong>${icon("sparkles", 15)} AI 复核</strong><p>${escapeHtml(result.aiReview)}</p></div>`
    : ai ? `<button class="secondary" data-review-workflow>${icon("sparkles", 16)} 用已配置模型复核结果</button>` : "";
  return `<section class="workflow-result"><div class="result-head"><div><span class="availability ready">运行完成</span><h3>${escapeHtml(result.summary)}</h3></div>${result.outputPath ? `<code>${escapeHtml(result.outputPath)}</code>` : ""}</div>${structured}${raw}${exportActions}${review}</section>`;
}

function renderRhymeLookupResult(): string {
  if (!lyricRhymeResult) return `<div class="lyric-empty">输入一个字（如“光”）或韵母（如 <code>ang</code>），这里会显示字典内全部同韵字。</div>`;
  const result = lyricRhymeResult;
  return `<section class="rhyme-results"><div class="rhyme-result-head"><div><span class="availability ready">${result.matchMode === "family" ? "同韵部" : "精确韵母"}</span><strong>${escapeHtml(result.rhymeKeys.join(" / "))}</strong></div><span>${result.total.toLocaleString()} 个字${result.queryPinyin.length ? ` · ${escapeHtml(result.queryPinyin.join(" / "))}` : ""}</span></div><div class="rhyme-character-grid">${result.characters.map((item) => `<button type="button" data-rhyme-character="${escapeHtml(item.character)}" title="${escapeHtml(item.pinyin.join(" / "))}">${escapeHtml(item.character)}</button>`).join("")}</div><small class="coverage-note">${escapeHtml(result.coverageNote)} 点击任一字可加入歌词草稿。</small></section>`;
}

function renderLyricCandidates(): string {
  if (!lyricCandidates) return `<div class="lyric-empty">填写创作意图或意象后，Copilot 会给出互不重复的原创候选；采用前仍由你决定。</div>`;
  return `<div class="lyric-candidate-list">${lyricCandidates.candidates.map((candidate, index) => `<article class="lyric-candidate ${candidate.rhymeMatched === false ? "off-rhyme" : ""}"><div><span>${candidate.rhymeMatched == null ? "未限定韵脚" : candidate.rhymeMatched ? `押 ${escapeHtml(lyricCandidates?.targetRhyme ?? "目标韵")}` : "句尾未命中"}</span>${candidate.rhymeFoot ? `<code>${escapeHtml(candidate.rhymeFoot)}</code>` : ""}</div><strong>${escapeHtml(candidate.text)}</strong>${candidate.note ? `<p>${escapeHtml(candidate.note)}</p>` : ""}<button type="button" class="secondary" data-use-lyric-candidate="${index}">${icon("plus", 14)} 加入草稿</button></article>`).join("")}</div>`;
}

function renderLyricStudio(ai: boolean): string {
  const sectionOptions = lyricSections.map((section) => `<option value="${escapeHtml(section.label)}" ${section.label === lyricCandidateSection ? "selected" : ""}>${escapeHtml(section.label)}</option>`).join("");
  const lineCount = lyricDraft.trim() ? lyricDraft.trim().split(/\r?\n/).length : 0;
  const projectOptions = lyricProjects.map((project) => `<option value="${escapeHtml(project.id)}" ${project.id === lyricProjectId ? "selected" : ""}>${escapeHtml(project.title)} · ${project.lineCount} 行 · r${project.revision}</option>`).join("");
  const projectStatus = lyricProjectId === undefined
    ? "未保存草稿"
    : lyricProjectHasUnsavedChanges()
      ? `本地项目 r${lyricProjectRevision} · 有未保存修改`
      : `本地项目 r${lyricProjectRevision} · 已保存`;
  const projectToolbar = `<section class="lyric-project-toolbar panel-inset"><div><span class="eyebrow">LOCAL SONG PROJECT</span><strong>${escapeHtml(projectStatus)}</strong><small>项目保存在本机；输入时的临时草稿仍会自动保存。</small></div><div class="lyric-project-actions"><button type="button" class="secondary compact" data-new-lyric-project>新项目</button><select id="lyric-project-select" ${lyricProjects.length ? "" : "disabled"}><option value="">${lyricProjects.length ? "选择已保存项目" : "尚无已保存项目"}</option>${projectOptions}</select><button type="button" class="secondary compact" data-load-lyric-project ${lyricProjects.length ? "" : "disabled"}>打开</button><button type="button" class="primary compact" data-save-lyric-project>${lyricProjectId === undefined ? "保存为项目" : "保存"}</button></div></section>`;
  const structureRows = lyricSections.map((section, index) => `<article class="lyric-section-row" data-lyric-section-id="${escapeHtml(section.id)}"><span class="section-index">${index + 1}</span><label>段落名称<input data-lyric-section-field="label" maxlength="60" value="${escapeHtml(section.label)}" /></label><label>行数<input data-lyric-section-field="lineCount" type="number" min="1" max="32" value="${section.lineCount}" /></label><label>格式<input data-lyric-section-field="rhymeScheme" maxlength="32" value="${escapeHtml(section.rhymeScheme)}" placeholder="可选，如 ABAB" /></label><input type="hidden" data-lyric-section-field="kind" value="${escapeHtml(section.kind)}" /><div class="lyric-row-actions"><button type="button" class="icon-plain" data-move-lyric-section="up" data-section-id="${escapeHtml(section.id)}" title="上移" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" class="icon-plain" data-move-lyric-section="down" data-section-id="${escapeHtml(section.id)}" title="下移" ${index === lyricSections.length - 1 ? "disabled" : ""}>↓</button><button type="button" class="icon-plain danger" data-remove-lyric-section="${escapeHtml(section.id)}" title="删除">×</button></div></article>`).join("");
  const copilot = ai ? `<section class="lyric-copilot panel-inset"><div class="lyric-subhead"><div><span class="eyebrow">COPILOT</span><h3>${icon("sparkles", 17)} 帮我续写</h3></div><span class="availability ready">只给候选，不会改稿</span></div><form id="lyric-candidate-form" class="lyric-candidate-form"><label class="wide">这一句 / 这一段想表达什么<textarea id="lyric-brief" rows="3" maxlength="2000" placeholder="例如：夜车离开故乡时，想起没说出口的告别">${escapeHtml(lyricCandidateBrief)}</textarea></label><label class="wide">画面或关键词<input id="lyric-imagery" maxlength="1000" value="${escapeHtml(lyricCandidateImagery)}" placeholder="月台、旧信、雨后的路灯、车窗倒影" /></label><label>写到哪一段<select id="lyric-candidate-section">${sectionOptions}</select></label><label>语气<input id="lyric-candidate-tone" maxlength="80" value="${escapeHtml(lyricCandidateTone)}" placeholder="克制、口语化、明亮" /></label><label>句尾提示（可空）<input id="lyric-candidate-rhyme" maxlength="24" value="${escapeHtml(lyricCandidateRhyme)}" placeholder="如：ang / 光" /></label><label>候选数量<select id="lyric-candidate-count">${[2, 3, 4, 5, 6].map((count) => `<option value="${count}" ${lyricCandidateCount === count ? "selected" : ""}>${count} 条</option>`).join("")}</select></label><button class="primary wide">${icon("sparkles", 16)} 给我几个写法</button></form>${renderLyricCandidates()}</section>` : `<section class="lyric-copilot locked panel-inset"><div class="lyric-subhead"><div><span class="eyebrow">COPILOT</span><h3>${icon("sparkles", 17)} 帮我续写</h3></div><span class="availability blocked">AI 模式</span></div><p>这里始终是你的草稿。开启 AI 后，可以为某一段索取原创写法，选择后再手动加入。</p><button type="button" class="secondary" data-enable-ai>开启 Copilot</button></section>`;
  return `<div class="lyric-mode-banner"><span class="feature-icon ${ai ? "violet" : "emerald"}">${icon(ai ? "sparkles" : "lyrics", 21)}</span><div><strong>把注意力放在歌词上</strong><p>草稿会自动保存在本机；结构、韵脚和 Copilot 都是按需打开的辅助工具。</p></div><span class="lyric-save-state">本机自动保存</span></div>${projectToolbar}<div class="lyric-workbench-grid lyric-writing-layout"><main class="lyric-editor panel-inset"><div class="lyric-editor-head"><label class="lyric-title">歌名<input id="lyric-song-title" maxlength="120" value="${escapeHtml(lyricSongTitle)}" placeholder="未命名歌词" /></label><div class="lyric-editor-actions"><button type="button" class="secondary compact" data-copy-lyric-draft ${lyricDraft.trim() ? "" : "disabled"}>复制</button><button type="button" class="secondary compact" data-clear-lyric-draft ${lyricDraft.trim() ? "" : "disabled"}>清空</button></div></div><label class="lyric-draft-label">歌词草稿<textarea id="lyric-draft" rows="22" spellcheck="false" placeholder="从这里开始写。\n\n你可以直接写完整歌词，也可以先写几个句子或画面。">${escapeHtml(lyricDraft)}</textarea></label><footer class="lyric-editor-footer"><span>${lineCount} 行 · ${lyricDraft.length.toLocaleString()} 字</span><span>输入时自动保存</span></footer></main><aside class="lyric-helper-stack">${copilot}<details class="lyric-tools panel-inset"><summary><span><span class="eyebrow">OPTIONAL TOOLS</span><strong>${icon("recipe", 16)} 段落结构</strong></span><small>${lyricSections.length} 段 · ${lyricSections.reduce((sum, section) => sum + section.lineCount, 0)} 行</small></summary><form id="lyric-structure-form"><div class="lyric-presets"><span>快速开始</span><button type="button" data-lyric-preset="compact">流行</button><button type="button" data-lyric-preset="pop">完整歌曲</button><button type="button" data-lyric-preset="rap">说唱</button><button type="button" data-lyric-preset="blank">空白</button></div><div class="lyric-section-list">${structureRows}</div><div class="lyric-structure-actions"><button type="button" class="secondary" data-add-lyric-section>${icon("plus", 15)} 添加段落</button><button class="primary">${icon("recipe", 15)} 插入段落骨架</button></div></form></details><details class="lyric-tools panel-inset"><summary><span><span class="eyebrow">OPTIONAL TOOLS</span><strong>${icon("pronunciation", 16)} 韵脚助手</strong></span><small>只在需要时查询</small></summary><form id="rhyme-lookup-form" class="rhyme-search"><input id="rhyme-query" required maxlength="24" value="${escapeHtml(lyricRhymeQuery)}" placeholder="输入一个字或韵母，如 光 / ang" /><select id="rhyme-match-mode"><option value="family" ${lyricRhymeMode === "family" ? "selected" : ""}>同韵部</option><option value="exact" ${lyricRhymeMode === "exact" ? "selected" : ""}>精确韵母</option></select><button class="secondary">查找同韵字</button></form>${renderRhymeLookupResult()}</details></aside></div>`;
}

function renderLyricsPage(): string {
  if (!app) return "";
  const templateResult = workflowResult?.kind === "lyric-template"
    ? `<section class="panel lyric-page-result">${renderWorkflowResult(workflowResult, app.mode === "ai")}</section>`
    : "";
  return `<div class="lyric-page">${renderLyricStudio(app.mode === "ai")}</div>${templateResult}`;
}

function syncLyricDraftFromDom(): void {
  lyricSongTitle = document.querySelector<HTMLInputElement>("#lyric-song-title")?.value ?? lyricSongTitle;
  lyricDraft = document.querySelector<HTMLTextAreaElement>("#lyric-draft")?.value ?? lyricDraft;
  document.querySelectorAll<HTMLInputElement>("[data-rhyme-target]").forEach((input) => {
    const label = input.dataset.rhymeTarget;
    if (label) lyricRhymeTargets[label] = input.value.trim();
  });
  const sectionRows = [...document.querySelectorAll<HTMLElement>("[data-lyric-section-id]")];
  if (sectionRows.length) {
    lyricSections = sectionRows.map((row) => ({
      id: row.dataset.lyricSectionId ?? "",
      kind: (row.querySelector<HTMLSelectElement>("[data-lyric-section-field='kind']")?.value ?? "custom") as LyricSectionRequest["kind"],
      label: row.querySelector<HTMLInputElement>("[data-lyric-section-field='label']")?.value.trim() ?? "",
      lineCount: Number(row.querySelector<HTMLInputElement>("[data-lyric-section-field='lineCount']")?.value ?? 4),
      rhymeScheme: row.querySelector<HTMLInputElement>("[data-lyric-section-field='rhymeScheme']")?.value.trim() ?? "-",
    }));
  }
  lyricCandidateBrief = document.querySelector<HTMLTextAreaElement>("#lyric-brief")?.value ?? lyricCandidateBrief;
  lyricCandidateImagery = document.querySelector<HTMLInputElement>("#lyric-imagery")?.value ?? lyricCandidateImagery;
  lyricCandidateSection = document.querySelector<HTMLSelectElement>("#lyric-candidate-section")?.value ?? lyricCandidateSection;
  lyricCandidateTone = document.querySelector<HTMLInputElement>("#lyric-candidate-tone")?.value ?? lyricCandidateTone;
  lyricCandidateRhyme = document.querySelector<HTMLInputElement>("#lyric-candidate-rhyme")?.value ?? lyricCandidateRhyme;
  lyricCandidateCount = Number(document.querySelector<HTMLSelectElement>("#lyric-candidate-count")?.value ?? lyricCandidateCount);
  persistLyricWorkspace();
}

function renderWorkflowPanel(id: string): string {
  if (!app) return "";
  const current = app;
  const ai = current.mode === "ai";
  const feature = features.find((item) => item.id === id);
  const group = toolGroups.find((item) => item.featureIds.includes(id));
  let form = "";
  if (id === "media-import") {
    const sourcePreview = mediaSourcePreview
      ? `<section class="media-source-preview"><div><span class="availability ready">${escapeHtml(mediaSourcePreview.platform)}</span><h3>${escapeHtml(mediaSourcePreview.title)}</h3><p>${escapeHtml(mediaSourcePreview.uploader)} · ${mediaSourcePreview.durationSeconds ? `${Math.round(mediaSourcePreview.durationSeconds)} 秒` : "时长未知"}</p><code>${escapeHtml(mediaSourcePreview.canonicalUrl)}</code></div></section>`
      : `<div class="mode-limit">支持裸 BV 号、Bilibili URL、YouTube URL 与 youtu.be 短链接。不会读取浏览器 Cookie、播放列表或付费内容。</div>`;
    const taskCards = mediaTasks.filter((item) => item.kind === "media-import").slice(-5).reverse().map((task) => {
      const result = asObject(task.result) ?? {};
      const audioPath = typeof result.audioPath === "string" ? result.audioPath : "";
      const action = ["queued", "running", "cancelling"].includes(task.status)
        ? `<button class="secondary compact" data-cancel-media-task="${escapeHtml(task.id)}" ${task.status === "cancelling" ? "disabled" : ""}>${task.status === "cancelling" ? "终止中…" : "取消"}</button>`
        : ["failed", "cancelled"].includes(task.status)
          ? `<button class="secondary compact" data-retry-media-task="${escapeHtml(task.id)}">重试</button>`
          : "";
      return `<article class="download-item ${task.status}"><span class="component-status ${task.status === "completed" ? "ready" : ""}">${icon(task.status === "failed" ? "plug" : "download", 17)}</span><div><div class="download-title"><strong>平台音频导入</strong><span>${escapeHtml(task.status)}</span></div><div class="progress-track"><span style="width:${Math.max(2, Math.min(100, task.progress))}%"></span></div><small>${escapeHtml(task.error || task.detail)}</small>${audioPath ? `<small>WAV：${escapeHtml(audioPath)}</small>` : ""}</div>${action}</article>`;
    }).join("");
    const taskList = taskCards ? `<section class="download-queue"><div class="section-heading"><div><h3>媒体任务</h3><p>状态会持久化；取消会终止 yt-dlp 及其帮助进程。</p></div></div><div class="download-list">${taskCards}</div></section>` : "";
    form = `<form id="media-import-form" class="workflow-form workflow-wide"><label>BV 或媒体 URL<input id="media-source" required value="${escapeHtml(mediaSourceInput)}" placeholder="BV1... 或 https://www.youtube.com/watch?v=..." /></label><label class="checkbox workflow-check"><input id="media-rights" type="checkbox" /> 我拥有该内容或已取得足够授权，并会遵守来源平台规则</label><div class="button-row"><button class="secondary" value="preview">${icon("waveform", 16)} 预览来源</button><button class="primary" value="import" ${mediaSourcePreview ? "" : "disabled"}>${icon("download", 16)} 下载受管 WAV</button></div></form>${sourcePreview}${taskList}`;
  } else if (id === "source-separation") {
    const taskCards = mediaTasks.filter((item) => item.kind === "source-separation").slice(-5).reverse().map((task) => {
      const wrapped = asObject(task.result) ?? {};
      const data = asObject(wrapped.data) ?? {};
      const vocalPath = typeof data.vocalPath === "string" ? data.vocalPath : "";
      const instrumentalPath = typeof data.instrumentalPath === "string" ? data.instrumentalPath : "";
      const action = ["queued", "running", "cancelling"].includes(task.status)
        ? `<button class="secondary compact" data-cancel-media-task="${escapeHtml(task.id)}" ${task.status === "cancelling" ? "disabled" : ""}>${task.status === "cancelling" ? "终止中…" : "取消"}</button>`
        : ["failed", "cancelled"].includes(task.status)
          ? `<button class="secondary compact" data-retry-media-task="${escapeHtml(task.id)}">重试</button>`
          : "";
      const outputs = vocalPath && instrumentalPath ? `<small>Vocals：${escapeHtml(vocalPath)}</small><small>Inst：${escapeHtml(instrumentalPath)}</small>` : "";
      return `<article class="download-item ${task.status}"><span class="component-status ${task.status === "completed" ? "ready" : ""}">${icon(task.status === "failed" ? "plug" : "audio", 17)}</span><div><div class="download-title"><strong>人声伴奏分离</strong><span>${escapeHtml(task.status)}</span></div><div class="progress-track"><span style="width:${Math.max(2, Math.min(100, task.progress))}%"></span></div><small>${escapeHtml(task.error || task.detail)}</small>${outputs}</div>${action}</article>`;
    }).join("");
    const taskList = taskCards ? `<section class="download-queue"><div class="section-heading"><div><h3>分离任务</h3><p>状态会持久化；取消会终止 Python、Demucs 及模型帮助进程。</p></div></div><div class="download-list">${taskCards}</div></section>` : "";
    form = `<div class="mode-limit">首次运行会由 Demucs 获取 htdemucs 模型；输出始终写入 Toolbox 受管目录，不覆盖源音频。</div><form id="source-separation-form" class="workflow-form workflow-wide"><label>混音音频路径<input id="separation-source" required placeholder="选择平台导入的 source.wav 或其他本地音频" /></label><button class="primary">${icon("audio", 16)} 分离 vocals / inst</button></form>${taskList}`;
  } else if (id === "audio-insight") {
    form = `<form id="audio-probe-form" class="workflow-form">
      <label>音频文件路径<input id="audio-path" required placeholder="选择待分析的 WAV、FLAC、MP3、M4A、AAC、OGG 或 OPUS" /></label>
      ${ai ? `<label class="checkbox workflow-check"><input id="audio-advanced" type="checkbox" checked /> 启用音符统计、PANNs 乐器/风格倾向和人声置信判断</label>` : `<div class="mode-limit">纯工具箱只输出 BPM、调性、能量与频谱趋势；不下载或运行高级模型。</div>`}
      <button class="primary">${icon(ai ? "sparkles" : "play", 16)} 开始分析</button>
    </form>`;
  } else if (id === "score-to-synthv") {
    form = `<div class="mode-limit"><strong>转换范围：</strong>把单声部 MIDI / MusicXML 写入当前打开的 SynthV 工程；不会跨版本直译 SV1 / SV2 的歌手、唱法或参数，也不会代替你保存 .svp。</div>
      <form id="score-to-synthv-form" class="workflow-form workflow-wide">
        <label>曲谱文件路径<input id="score-source-path" required placeholder="本地 .mid、.midi、.xml、.musicxml 或 .mxl 文件" /></label>
        <div class="workflow-pair"><label>目标轨道编号<input id="score-target-track" type="number" min="1" max="10000" value="1" required /></label><label>音符组名称<input id="score-group-name" maxlength="200" value="Imported Score" required /></label></div>
        <label class="checkbox workflow-check"><input id="score-rights" type="checkbox" /> 我确认有权把这份本地曲谱导入当前工程</label>
        <button class="primary" ${app.bridgeConnected ? "" : "disabled"}>${icon("file", 16)} ${app.bridgeConnected ? "转换并导入当前工程" : "请先连接 Bridge"}</button>
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
    form = `<div class="mode-limit">这个入口已经合并 MIDI 导出与 SynthV 导入：默认只生成标准 MIDI；连接 Bridge 后可选择继续写入当前工程。</div>
      <form id="audio-to-project-form" class="workflow-form workflow-wide">
        <div class="workflow-pair"><label>演唱版音频路径<input id="pipeline-vocal" required placeholder="包含目标演唱的音频" /></label><label>伴奏版音频路径<input id="pipeline-inst" required placeholder="同版本、同时间轴的伴奏" /></label></div>
        <div class="workflow-pair"><label>输出 MIDI 文件名<input id="pipeline-output" required value="audio_to_project.mid" /></label>${ai ? `<label>匹配容差（秒）<input id="pipeline-tolerance" type="number" min="0.02" max="0.25" step="0.01" value="0.08" /></label>` : '<input id="pipeline-tolerance" type="hidden" value="0.08" />'}</div>
        ${ai ? `<label class="checkbox workflow-check"><input id="pipeline-advanced" type="checkbox" checked /> 启用多参数寻优与低置信音符纠正</label>` : ""}
        <label class="checkbox workflow-check"><input id="pipeline-import" type="checkbox" ${app.bridgeConnected ? "" : "disabled"} /> 提取完成后通过 Bridge 导入当前 SynthV 工程${app.bridgeConnected ? "" : "（Bridge 未连接）"}</label>
        <div id="pipeline-import-options" class="workflow-nested" hidden><div class="workflow-pair"><label>目标轨道编号<input id="pipeline-track" type="number" min="1" max="10000" value="1" required disabled /></label><label>SynthV 音符组名称<input id="pipeline-group-name" required value="Toolbox Audio Import" maxlength="200" disabled /></label></div><label class="checkbox workflow-check"><input id="pipeline-rights" type="checkbox" disabled /> 我确认有权使用这些本地素材及生成的 MIDI</label></div>
        <button class="primary" id="pipeline-submit">${icon("pipeline", 16)} 提取并导出 MIDI</button>
      </form>`;
  } else if (id === "project-doctor") {
    form = `<div class="mode-limit">完全离线、只读检查已保存的 .svp；不会调用模型或修改工程。</div><form id="project-doctor-form" class="workflow-form workflow-wide"><label>.svp 工程路径<input id="doctor-project" required placeholder="选择需要体检的工程" /></label><button class="primary">${icon("doctor", 16)} 开始只读体检</button></form>`;
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
  } else if (id === "ab-audition") {
    const captureSupported = audioCaptureCapability?.supported === true;
    const targetOptions = audioCaptureTargets.map((target) => `<option value="${target.processId}" ${abProcessId === target.processId ? "selected" : ""}>PID ${target.processId} · ${escapeHtml(target.name)}</option>`).join("");
    const targetControl = !audioCaptureCapability
      ? `<div class="mode-limit">正在检查 Windows 进程级音频捕获能力…</div>`
      : !captureSupported
        ? `<div class="mode-limit">${escapeHtml(audioCaptureCapability.detail)}</div>`
        : targetOptions
      ? `<label>SynthV 实例<select id="ab-process"><option value="">自动（仅一个实例时）</option>${targetOptions}</select></label>`
      : `<div class="mode-limit">没有发现 SynthV standalone 进程。请启动 SynthV 2 Pro 后刷新实例。</div>`;
    form = `<div class="mode-limit">捕获器只接收所选 SynthV 进程树的输出。开始前必须停止播放；完成后会恢复原播放头。A 可复用，连续优化时只需重新捕获 B。</div>
      <form id="ab-capture-form" class="workflow-form workflow-wide">
        <div class="workflow-pair">${targetControl}<label>片段标签<input id="ab-label" maxlength="40" value="局部优化" /></label></div>
        <div class="workflow-pair"><label>起点（秒）<input id="ab-start" type="number" min="0" max="86400" step="0.01" value="${abStartSeconds}" required /></label><label>终点（秒）<input id="ab-end" type="number" min="0.01" max="86400" step="0.01" value="${abEndSeconds}" required /></label></div>
        <div class="workflow-pair"><label>前置保护区（秒）<input id="ab-preroll" type="number" min="0" max="2" step="0.05" value="${abPreRollSeconds}" required /></label><label>后置保护区（秒）<input id="ab-postroll" type="number" min="0" max="2" step="0.05" value="${abPostRollSeconds}" required /></label></div>
        <div class="button-row"><button type="button" class="secondary" data-refresh-capture-targets ${captureSupported ? "" : "disabled"}>${icon("sync", 15)} 刷新实例</button><button class="secondary" value="baseline" ${captureSupported && audioCaptureTargets.length ? "" : "disabled"}>${icon("audio", 15)} 捕获 A 基线</button><button class="primary" value="candidate" ${captureSupported && audioCaptureTargets.length ? "" : "disabled"}>${icon("play", 15)} 捕获 B 候选</button></div>
      </form>
      <div class="ab-capture-paths"><div><span>A 基线</span><code>${escapeHtml(abBaselinePath || "尚未捕获")}</code></div><div><span>B 候选</span><code>${escapeHtml(abCandidatePath || "尚未捕获")}</code></div></div>
      <form id="ab-compare-form" class="workflow-form workflow-wide"><div class="workflow-pair"><label>A WAV 路径<input id="ab-baseline-path" required value="${escapeHtml(abBaselinePath)}" /></label><label>B WAV 路径<input id="ab-candidate-path" required value="${escapeHtml(abCandidatePath)}" /></label></div><label>最大自动对齐偏移（ms）<input id="ab-max-lag" type="number" min="0" max="1000" step="1" value="250" /></label><button class="primary">${icon("compare", 16)} 对齐并比较 A/B</button></form>`;
  } else if (id === "pronunciation-doctor") {
    form = `<div class="mode-limit">可检查已保存工程，也可直接粘贴歌词；两种输入只填写一种。首版聚焦空歌词、多音节拥挤、混合文字和极短音符。</div><form id="pronunciation-form" class="workflow-form workflow-wide"><label>.svp 工程路径（可选）<input id="pronunciation-project" placeholder="填写工程路径时不要再粘贴歌词" /></label><label>歌词文本（可选）<textarea id="pronunciation-lyrics" rows="8" placeholder="逐行粘贴歌词；填写歌词时不要再填写工程路径"></textarea></label><button class="primary">${icon("pronunciation", 16)} 运行发音诊断</button></form>`;
  } else if (id === "render-review") {
    form = `<div class="mode-limit">复用本地 pi-audio 探测结果检查静音、时长、BPM 与音高事件；不会上传渲染音频。</div><form id="render-review-form" class="workflow-form workflow-wide"><label>渲染音频路径<input id="render-audio" required /></label><div class="workflow-pair"><label>预期时长（秒，可选）<input id="render-duration" type="number" min="0.01" step="0.01" /></label><label>预期 BPM（可选）<input id="render-bpm" type="number" min="1" max="1000" step="0.01" /></label></div><label class="checkbox workflow-check"><input id="render-notes" type="checkbox" /> 要求探测到音高事件</label>${ai ? '<label class="checkbox workflow-check"><input id="render-advanced" type="checkbox" /> 启用高级音频分析</label>' : ""}<button class="primary">${icon("shield", 16)} 开始交付复检</button></form>`;
  } else {
    const catalogFeature = features.find((item) => item.id === id);
    form = catalogFeature ? `<div class="mode-limit"><strong>能力入口已就绪</strong><br />${escapeHtml(catalogFeature.base.join(" · "))}。后端工作流接入后会在这里显示参数与执行结果；当前不会对工程或音频执行写入。</div>` : "";
  }
  const switcher = group ? `<nav class="workflow-tool-tabs" aria-label="${escapeHtml(group.title)}中的工具">${groupFeatures(group).map((item) => {
    const availability = featureAvailability(item, current);
    const active = item.id === id;
    return `<button class="workflow-tool-tab ${active ? "active" : ""} ${availability.tone}" ${active ? 'aria-current="page"' : ""} ${featureTarget(item, availability)} ${availability.disabled ? "disabled" : ""}><span>${icon(item.icon, 15)} ${escapeHtml(item.title)}</span><small>${active ? "当前工具" : escapeHtml(availability.label)}</small></button>`;
  }).join("")}</nav>` : "";
  const result = workflowResult ? renderWorkflowResult(workflowResult, ai) : "";
  return `<section class="panel workflow-panel"><div class="workflow-heading"><span class="feature-icon ${feature?.accent ?? "violet"}">${icon(feature?.icon ?? "toolbox", 25)}</span><div><span class="eyebrow">${escapeHtml(group?.title ?? "ACTIVE WORKFLOW")}</span><h2>${escapeHtml(feature?.title ?? "工作流")}</h2><p>${escapeHtml(feature?.description ?? "")}</p></div><button class="icon-plain" data-close-workflow title="关闭">×</button></div>${switcher}${form}${result}</section>`;
}

function renderToolboxUpdateResult(): string {
  if (!toolboxUpdate) return "";
  const result = toolboxUpdate;
  const sameVersion = result.latestVersion === result.currentVersion;
  const status = result.updateAvailable ? "发现新版本" : sameVersion ? "已是最新版本" : "当前版本较新";
  const published = result.publishedAtUtc ? new Date(result.publishedAtUtc).toLocaleString("zh-CN") : "发布时间未知";
  const checked = new Date(result.checkedAtUtc).toLocaleString("zh-CN");
  const notes = result.releaseNotes.trim()
    ? `<pre class="update-release-notes">${escapeHtml(result.releaseNotes)}</pre>`
    : '<div class="empty-inline">这个版本没有提供发布说明。</div>';
  return `<section class="update-check-result ${result.updateAvailable ? "available" : "current"}"><div class="update-status"><span class="feature-icon ${result.updateAvailable ? "orange" : "emerald"}">${icon(result.updateAvailable ? "download" : "check", 22)}</span><div><span class="availability ${result.updateAvailable ? "warning" : "ready"}">${status}</span><h3>${escapeHtml(result.releaseName)}</h3><small>发布于 ${escapeHtml(published)} · 检查于 ${escapeHtml(checked)}</small></div></div><div class="result-dashboard compact">${resultMetric("当前版本", `v${result.currentVersion}`)}${resultMetric("最新稳定版", `v${result.latestVersion}`, result.updateAvailable ? "warning" : "success")}</div><div class="update-notes-heading"><strong>发布说明</strong><span>内容来自官方 GitHub Release</span></div>${notes}<div class="result-actions"><span>${result.updateAvailable ? "下载安装由你在官方页面中确认" : "也可以查看全部历史版本"}</span><button class="secondary" data-open-toolbox-releases>${icon("arrow", 15)} 打开官方发布页</button></div></section>`;
}

function renderCopilot(): string {
  const messages = conversation?.messages.filter((message) => message.role === "user" || message.role === "assistant") ?? [];
  return `<div class="copilot-layout">
    <aside class="sessions-panel"><button class="primary full" data-new-conversation>${icon("plus", 17)} 新建对话</button><span class="nav-label">历史对话</span><div class="session-list">${conversations.length ? conversations.map((item) => `<button class="session-item ${conversation?.id === item.id ? "active" : ""}" data-conversation="${escapeHtml(item.id)}"><strong>${escapeHtml(item.title)}</strong><small>${item.messageCount} 条消息 · ${escapeHtml(item.updatedAt.slice(0, 10))}</small></button>`).join("") : '<p class="empty-small">还没有历史对话</p>'}</div></aside>
    <section class="chat-panel">
      <div class="chat-header"><div><strong>${escapeHtml(conversation?.title ?? "新对话")}</strong><small>Copilot 只会调用已启用的能力</small></div><span class="mode-pill ai">${icon("sparkles", 14)} AI</span></div>
      <div class="messages">${messages.length ? messages.map(renderMessage).join("") : `<div class="empty-chat"><span class="mode-icon purple">${icon("bot", 30)}</span><h2>今天想完成什么？</h2><p>可以从分析音频、检查工程或连接 SynthV 开始。</p><div class="prompt-chips"><button data-prompt="分析这段音频的 BPM、调性和能量变化">分析音频特征</button><button data-prompt="检查当前 SynthV 工程并总结轨道结构">检查 SynthV 工程</button><button data-prompt="帮我规划从演唱音频到 MIDI 或 SynthV 工程的工作流">规划音频到 SynthV</button></div></div>`}</div>
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
  const statusLabel = { queued: "排队中", downloading: "aria2 下载中", installing: "安装中", completed: "已完成", failed: "失败", cancelled: "已取消" } as const;
  const activeDownloads = app.downloads.filter((item) => item.status !== "completed");
  const queue = activeDownloads.length ? `<section class="download-queue panel">
    <div class="section-heading"><div><h2>下载队列</h2><p>队列串行执行；远程组件固定版本并由 aria2 + SHA-256 校验。</p></div><span class="queue-count">${activeDownloads.length}</span></div>
    <div class="download-list">${activeDownloads.map((item) => `<article class="download-item ${item.status}">
      <span class="component-status ${item.status === "completed" ? "ready" : ""}">${item.status === "failed" ? icon("plug", 17) : icon("download", 17)}</span>
      <div><div class="download-title"><strong>${escapeHtml(item.displayName)}</strong><span>${statusLabel[item.status]}</span></div><div class="progress-track"><span style="width:${Math.max(2, Math.min(100, item.progress))}%"></span></div><small>${escapeHtml(item.detail)}</small></div>
      ${item.status === "queued" ? `<button class="secondary compact" data-cancel-component-task="${escapeHtml(item.id)}">取消</button>` : ["failed", "cancelled"].includes(item.status) ? `<button class="secondary compact" data-retry-component-task="${escapeHtml(item.id)}">重试</button>` : ""}
    </article>`).join("")}</div>
  </section>` : "";
  return `${queue}<div class="section-heading"><div><h2>本地组件</h2><p>下载任务会加入队列；无固定来源与 SHA-256 的组件会拒绝安装。</p></div></div>
    <div class="component-list">${app.components.map((component) => {
      const task = app?.downloads.find((item) => item.componentId === component.id && ["queued", "downloading", "installing"].includes(item.status));
      const isRemoving = removingComponentId === component.id;
      let actionButton: string;
      if (isRemoving) {
        actionButton = `<button class="secondary component-remove-action" disabled>删除中…</button>`;
      } else if (task) {
        actionButton = `<button class="secondary" disabled>${statusLabel[task.status]}</button>`;
      } else if (component.removable) {
        actionButton = `<button class="secondary component-remove-action" data-remove-component="${escapeHtml(component.id)}">${icon("trash", 16)} ${component.installed ? "删除" : "清理残留"}</button>`;
      } else if (component.installed) {
        actionButton = `<button class="secondary" disabled>已就绪</button>`;
      } else if (component.downloaded) {
        actionButton = `<button class="secondary" data-open-component-download="${escapeHtml(component.id)}">打开安装包位置</button>`;
      } else if (component.installable) {
        actionButton = `<button class="secondary" data-install-component="${escapeHtml(component.id)}">加入队列</button>`;
      } else {
        actionButton = `<button class="secondary" disabled>当前平台不可用</button>`;
      }
      return `<article class="component-row"><span class="component-status ${component.installed || component.downloaded ? "ready" : ""}">${component.installed ? icon("check", 18) : icon("download", 18)}</span><div><h3>${escapeHtml(component.displayName)}</h3><p>${escapeHtml(component.description)}</p><div class="tags"><span>${escapeHtml(component.audience)}</span><span>${escapeHtml(component.status)}</span></div></div>${actionButton}</article>`;
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
  const shortcuts = synthvShortcutProfile ?? { bridgeStart: "F13", bridgeStop: "F14", detail: "正在读取快捷键配置…" };
  const processList = synthvProcesses.length
    ? synthvProcesses.map((process) => `<article class="synthv-process-row"><div><strong>${escapeHtml(process.name)}</strong><small>PID ${process.processId} · ${escapeHtml(process.command)}</small></div><div class="button-row"><button class="primary compact" data-auto-connect-synthv="${process.processId}">F13 启动并连接</button><button class="secondary compact" data-send-synthv-stop="${process.processId}">F14 停止</button></div></article>`).join("")
    : '<div class="empty-inline compact-empty">没有发现正在运行的 SynthV 进程。</div>';
  const processControls = `<section class="panel"><div class="panel-heading"><span class="feature-icon violet">${icon("bridge", 25)}</span><div><h2>运行中的 SynthV</h2><p>${escapeHtml(shortcuts.detail)}</p></div><button class="secondary compact" data-refresh-synthv-processes>${icon("sync", 16)} 刷新</button></div><div class="shortcut-tags"><span>启动 / 重连：${escapeHtml(shortcuts.bridgeStart)}</span><span>停止：${escapeHtml(shortcuts.bridgeStop)}</span></div><div class="synthv-process-list">${processList}</div></section>`;
  return `<div class="bridge-grid"><section class="panel"><div class="panel-heading"><span class="feature-icon orange">${icon("bridge", 25)}</span><div><h2>Synthesizer V 探测</h2><p>Windows 与 macOS 使用各自的标准路径，只进行只读检查。</p></div><button class="secondary compact" data-scan>${icon("sync", 16)} 重新探测</button></div>
    <div class="detection-groups">
      <section class="detection-group"><div class="detection-group-title"><strong>应用安装</strong><span>${applicationLocations.length}</span></div><div class="installation-list">${applicationList}</div></section>
      <section class="detection-group"><div class="detection-group-title"><strong>Scripts 目录</strong><span>${scriptsLocations.length}</span></div><p class="detection-group-help">选择一个目录后，会填入右侧的 Bridge 安装目标。</p><div class="installation-list">${scriptsList}</div></section>
    </div></section>
    <section class="panel"><div class="panel-heading"><span class="feature-icon blue">${icon("plug", 25)}</span><div><h2>Bridge 管理</h2><p>安装器只写入你指定的 scripts 目录，不开放网络端口。</p></div></div>
      <form id="bridge-form" class="form-stack"><label>Scripts 目录<input id="scripts-path" value="${escapeHtml(app.scriptsPath ?? app.installations.find((item) => item.scriptsPath)?.scriptsPath ?? "")}" placeholder="选择或粘贴 SynthV scripts 目录" /></label><div class="button-row"><button class="primary" value="install">安装 / 更新</button><button class="secondary" value="diagnose">检查安装</button><button class="secondary" value="connect">测试连接</button></div></form>
      <div class="inline-status"><span class="status-dot ${app.bridgeBundled ? "online" : ""}"></span><span>${app.bridgeBundled ? "内置 Bridge 资源已就绪" : "当前构建未包含 Bridge 资源"}</span></div>
    </section>${processControls}</div>`;
}

function renderMcp(): string {
  if (!app) return "";
  return `<div class="warning-card"><span>${icon("server", 23)}</span><div><strong>MCP 服务器可以启动本地进程</strong><p>只添加你信任的命令。服务器必须显式启用后才会向 Copilot 暴露工具。</p></div></div>
    <div class="mcp-layout"><section class="panel"><div class="section-heading"><div><h2>已配置服务器</h2><p>${app.mcpServers.length} 个配置</p></div></div><div class="mcp-list">${app.mcpServers.length ? app.mcpServers.map((server) => `<article><span class="server-icon">${icon("server", 20)}</span><div><strong>${escapeHtml(server.name)}</strong><code>${escapeHtml([server.command, ...server.args].join(" "))}</code></div><span class="availability">${server.enabled ? "已启用" : "已停用"}</span><button class="icon-plain" data-test-mcp="${escapeHtml(server.id)}" title="测试">${icon("sync", 17)}</button><button class="icon-plain danger" data-delete-mcp="${escapeHtml(server.id)}" title="删除">${icon("trash", 17)}</button></article>`).join("") : '<div class="empty-inline">尚未添加外部 MCP 服务器。</div>'}</div></section>
    <section class="panel"><div class="section-heading"><div><h2>添加 stdio MCP</h2><p>进程通过私有 stdin/stdout 与 Rust 后端通信。</p></div></div><form id="mcp-form" class="form-stack"><label>显示名称<input id="mcp-name" required placeholder="例如 Filesystem tools" /></label><label>命令<input id="mcp-command" required placeholder="例如 npx、node 或绝对路径" /></label><label>参数（每行一个）<textarea id="mcp-args" rows="4" placeholder="-y\n@modelcontextprotocol/server-filesystem\n/path/to/workspace"></textarea></label><label class="checkbox"><input id="mcp-enabled" type="checkbox" checked /> 保存后立即启用</label><button class="primary">添加服务器</button></form></section></div>`;
}

function fallbackAiProviders(): AiProviderSummary[] {
  return [{
    id: "anthropic",
    displayName: "Claude 官方订阅",
    description: "通过浏览器授权 Claude 账号，并使用官方订阅提供的模型。",
    active: true,
    connected: false,
    healthyAccounts: 0,
    totalAccounts: 0,
    model: "",
    models: [],
    accounts: [],
  }, {
    id: "openai-codex",
    displayName: "Codex 官方订阅",
    description: "通过浏览器授权 ChatGPT 账号，并使用账号可用的 Codex 模型。",
    active: false,
    connected: false,
    healthyAccounts: 0,
    totalAccounts: 0,
    model: "",
    models: [],
    accounts: [],
  }];
}

function aiProviders(): AiProviderSummary[] {
  return app?.model?.providers?.length ? app.model.providers : fallbackAiProviders();
}

function parseAiProviderId(value: string | undefined): AiProviderId | undefined {
  return value === "anthropic" || value === "openai-codex" ? value : undefined;
}

function isActiveAiProvider(provider: AiProviderSummary): boolean {
  return provider.active || app?.model?.activeProvider === provider.id;
}

function activeAiProvider(): AiProviderSummary | undefined {
  return aiProviders().find(isActiveAiProvider);
}

function aiConnectionSummary(): string {
  const provider = activeAiProvider();
  if (!provider?.connected) return "等待浏览器授权模型提供商";
  if (provider.healthyAccounts === 0) return `${provider.displayName} · 已授权，首次使用时验证`;
  return `${provider.displayName}${provider.model ? ` · ${provider.model}` : ""}`;
}

function aiAccountExpiry(expiresAt: number): string {
  const timestamp = expiresAt > 0 && expiresAt < 10_000_000_000 ? expiresAt * 1000 : expiresAt;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN") : "未知";
}

function renderAiProviderCard(provider: AiProviderSummary): string {
  const expanded = expandedAiProvider === provider.id;
  const active = isActiveAiProvider(provider);
  const tone = provider.connected ? (provider.healthyAccounts > 0 ? "ready" : "warning") : "off";
  const stateLabel = provider.connected
    ? provider.healthyAccounts > 0 ? "已绑定" : "已授权，待验证"
    : "未绑定";
  const knownModels = [...new Set([
    ...provider.models.filter(Boolean),
    ...(provider.model ? [provider.model] : []),
  ])];
  const modelOptions = knownModels.length
    ? knownModels.map((model) => `<option value="${escapeHtml(model)}" ${model === provider.model ? "selected" : ""}>${escapeHtml(model)}</option>`).join("")
    : '<option value="">授权后加载可用模型</option>';
  const isAuthorizing = authorizingAiProvider === provider.id;
  const accounts = provider.accounts.length
    ? provider.accounts.map((account) => {
      const awaitingConfirmation = pendingAiAccountRemoval?.provider === provider.id
        && pendingAiAccountRemoval.accountId === account.id;
      const accountState = account.healthy ? "healthy" : account.authorized ? "pending" : "unhealthy";
      const accountLabel = account.healthy
        ? `授权可用${account.expiresAt > 0 ? ` · 会话到期：${escapeHtml(aiAccountExpiry(account.expiresAt))}` : ""}`
        : account.authorized ? "凭据已安全保存，首次使用时验证并续期" : "凭据缺失，需要重新授权";
      const removalLabel = awaitingConfirmation
        ? `确认移除 ${account.label}`
        : `移除账号 ${account.label}`;
      return `<article class="ai-provider-account ${accountState}">
        <span class="ai-account-state" aria-label="${account.healthy ? "账号可用" : account.authorized ? "账号待验证" : "账号不可用"}"></span>
        <div><strong>${escapeHtml(account.label)}</strong><small>${accountLabel}</small></div>
        <button type="button" class="secondary compact ai-account-remove ${awaitingConfirmation ? "confirm" : ""}" data-remove-ai-account="${escapeHtml(account.id)}" data-ai-provider="${provider.id}" aria-label="${escapeHtml(removalLabel)}" ${busy ? "disabled" : ""}>${awaitingConfirmation ? "确认移除" : "移除账号"}</button>
        ${awaitingConfirmation ? `<span class="visually-hidden" role="status" aria-live="assertive">再次点击以确认移除 ${escapeHtml(account.label)}；确认将在五秒后取消。</span>` : ""}
      </article>`;
    }).join("")
    : '<div class="ai-provider-empty">尚未授权账号。点击“浏览器授权”，在官方页面完成登录。</div>';

  return `<article class="ai-provider-card ${active ? "active" : ""} ${expanded ? "expanded" : ""}">
    <div class="ai-provider-row">
      <span class="ai-provider-state ${tone}" aria-label="${stateLabel}"></span>
      <span class="ai-provider-mark ${provider.id === "anthropic" ? "claude" : "codex"}">${provider.id === "anthropic" ? "C" : "O"}</span>
      <div class="ai-provider-copy"><strong>${escapeHtml(provider.displayName)}</strong><small>${escapeHtml(provider.description)}</small></div>
      <div class="ai-provider-badges">
        <span class="ai-provider-badge ${active ? "active" : ""}">${active ? "当前使用" : "可切换"}</span>
        <span class="ai-provider-badge ${tone}">${escapeHtml(stateLabel)}</span>
        <span class="ai-provider-badge">${provider.healthyAccounts}/${provider.totalAccounts} 个账号可用</span>
        <span class="ai-provider-badge mono">${provider.models.length} 个模型</span>
      </div>
      <button type="button" class="secondary compact ai-provider-toggle" data-toggle-ai-provider="${provider.id}" aria-expanded="${expanded}">${expanded ? "完成" : "配置"}</button>
    </div>
    ${expanded ? `<div class="ai-provider-details">
      <div class="ai-provider-auth-row"><div><strong>官方浏览器 OAuth</strong><small>将在系统浏览器中打开官方授权页，OAuth token 只由本机后端保管。</small></div><button type="button" class="primary" data-authorize-ai-provider="${provider.id}" ${busy ? "disabled" : ""}>${isAuthorizing ? "等待授权…" : `浏览器授权${provider.id === "anthropic" ? " Claude" : " ChatGPT"}`}</button></div>
      <div class="ai-provider-account-list">${accounts}</div>
      <form class="ai-provider-model-form" data-ai-provider-form="${provider.id}">
        <label>模型<select name="model" ${!provider.connected || !knownModels.length ? "disabled" : ""}>${modelOptions}</select></label>
        <button class="primary" ${!provider.connected || !knownModels.length || busy ? "disabled" : ""}>${active ? "保存模型" : "使用此提供商"}</button>
      </form>
    </div>` : ""}
  </article>`;
}

function renderAiProviderSettings(): string {
  if (!openCodeCatalog && !openCodeCatalogLoading && !openCodeCatalogError) {
    void loadOpenCodeCatalog(false);
  }
  const legacyWarning = app?.model?.legacyConfigured
    ? `<div class="ai-legacy-warning">${icon("shield", 17)}<span><strong>检测到旧版 API token 配置</strong><small>旧配置不会作为 OAuth 账号展示。请完成浏览器授权；后端迁移完成前仍会保留旧配置。</small></span></div>`
    : "";
  const activeProvider = activeAiProvider();
  const activeVerified = Boolean(activeProvider?.connected && activeProvider.healthyAccounts > 0);
  const activeStatus = activeVerified ? "OAuth 已就绪" : activeProvider?.connected ? "已授权，待验证" : "等待授权";
  const catalogStatus = openCodeCatalog
    ? `${openCodeCatalog.providers.length} 个提供商`
    : openCodeCatalogLoading ? "正在获取…" : "获取失败";
  const catalogOptions = openCodeCatalog?.providers.map((provider) =>
    `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)} · ${escapeHtml(provider.id)} · ${provider.modelCount} 个模型</option>`
  ).join("") ?? "";
  return `<section class="panel ai-provider-panel"><div class="section-heading"><div><h2>模型提供商</h2><p>使用 IRIS 同款官方订阅接入；授权、续期与账号凭据均由 Rust 后端处理。</p></div><span class="availability ${activeVerified ? "ready" : "warning"}">${activeStatus}</span></div>
    ${legacyWarning}<div class="ai-provider-list">${aiProviders().map(renderAiProviderCard).join("")}</div>
    <div class="opencode-catalog-row"><div><strong>OpenCode 提供商目录</strong><small>${openCodeCatalogError ? escapeHtml(openCodeCatalogError) : openCodeCatalog ? `已自动获取 ${openCodeCatalog.providers.length} 个提供商。` : "正在从 models.dev 自动获取目录。"}</small></div>${catalogOptions ? `<label><span class="visually-hidden">OpenCode 提供商</span><select aria-label="OpenCode 提供商目录">${catalogOptions}</select></label>` : `<span class="availability ${openCodeCatalogError ? "warning" : ""}">${catalogStatus}</span>`}<button type="button" class="secondary compact" data-refresh-opencode-catalog ${openCodeCatalogLoading || busy ? "disabled" : ""}>${icon("sync", 15)} 刷新</button></div>
  </section>`;
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
    ${app.mode === "ai" ? renderAiProviderSettings() : `<section class="panel quiet-panel"><span class="mode-icon slate">${icon("bot", 24)}</span><div><h2>AI 运行时已关闭</h2><p>当前不会显示 Copilot、模型或 MCP 设置，也不会向模型端点发送请求。</p></div></section>`}
    ${showSvpRouting ? `<section class="panel smart-route-settings"><div class="section-heading"><div><h2>智能 .svp 启动</h2><p>根据工程所需声库，从空闲账号中建议最合适的启动槽位。</p></div><label class="fluent-switch large"><input id="svp-routing-enabled" type="checkbox" ${app.smartSvpLaunchEnabled ? "checked" : ""} ${association.supported ? "" : "disabled"} aria-label="启用智能 .svp 启动" /><span></span>${app.smartSvpLaunchEnabled ? "已开启" : "已关闭"}</label></div><div class="smart-route-state ${association.isDefault ? "ready" : "pending"}"><span class="feature-icon ${association.isDefault ? "emerald" : "blue"}">${icon("file", 20)}</span><div><strong>${escapeHtml(associationLabel)}</strong><p>${escapeHtml(association.detail)}</p></div><button class="secondary compact" data-open-svp-default-apps ${association.supported ? "" : "disabled"}>打开默认应用设置</button></div><div class="smart-route-boundary">${icon("shield", 17)}<span><strong>智能路由只在工具箱已经运行时生效</strong><small>冷启动或关闭此功能时，工具箱会把工程透明转交给原始 .svp 处理程序；不会监控、终止或劫持已经启动的 SV2。路由优先采用账号服务返回的授权摘要，并以你的确认记录作为补充；任何未知结果都必须由你选择账号。</small></span></div></section>` : ""}
    <section class="panel app-update-settings"><div class="section-heading"><div><h2>应用更新</h2><p>按需检查官方 GitHub Releases；不会自动下载或安装。</p></div></div><div class="update-check-actions"><div><small>当前版本</small><strong>v${escapeHtml(app.appVersion)}</strong></div><button class="secondary" data-check-toolbox-update>${icon("sync", 16)} ${toolboxUpdate ? "重新检查" : "检查更新"}</button></div>${renderToolboxUpdateResult()}</section>
    <section class="panel"><div class="section-heading"><div><h2>数据与平台</h2><p>配置和历史使用统一的跨平台用户目录。</p></div></div><dl class="detail-list"><div><dt>平台</dt><dd>${escapeHtml(app.platform)}</dd></div><div><dt>配置</dt><dd><code>${escapeHtml(app.configPath)}</code></dd></div><div><dt>应用版本</dt><dd>${escapeHtml(app.appVersion)}</dd></div></dl></section></div>`;
}

function wireForms(): void {
  document.querySelector<HTMLFormElement>("#media-import-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    const action = submitter?.value ?? "preview";
    const source = document.querySelector<HTMLInputElement>("#media-source")?.value.trim() ?? "";
    const rightsConfirmed = document.querySelector<HTMLInputElement>("#media-rights")?.checked ?? false;
    mediaSourceInput = source;
    void run(async () => {
      if (action === "import") {
        const task = await api.queueMediaImport(source, rightsConfirmed);
        mediaTasks = [...mediaTasks.filter((item) => item.id !== task.id), task];
        notice = "平台音频导入已加入可取消任务队列。";
      } else {
        mediaSourcePreview = await api.previewMediaSource(source);
        notice = `已读取《${mediaSourcePreview.title}》的来源元数据。`;
      }
    });
  });
  document.querySelector<HTMLFormElement>("#audio-probe-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const audioPath = document.querySelector<HTMLInputElement>("#audio-path")?.value.trim() ?? "";
    const advanced = app?.mode === "ai" && (document.querySelector<HTMLInputElement>("#audio-advanced")?.checked ?? false);
    void run(async () => { workflowResult = await api.runAudioProbe(audioPath, advanced); notice = workflowResult.summary; });
  });
  document.querySelector<HTMLFormElement>("#source-separation-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const audioPath = document.querySelector<HTMLInputElement>("#separation-source")?.value.trim() ?? "";
    void run(async () => {
      const task = await api.queueMediaSeparation(audioPath);
      mediaTasks = [...mediaTasks.filter((item) => item.id !== task.id), task];
      notice = "人声伴奏分离已加入可取消任务队列。";
    });
  });
  document.querySelector<HTMLFormElement>("#score-to-synthv-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const scorePath = document.querySelector<HTMLInputElement>("#score-source-path")?.value.trim() ?? "";
    const trackIndex = Number(document.querySelector<HTMLInputElement>("#score-target-track")?.value ?? "1");
    const groupName = document.querySelector<HTMLInputElement>("#score-group-name")?.value.trim() ?? "Imported Score";
    const rightsConfirmed = document.querySelector<HTMLInputElement>("#score-rights")?.checked ?? false;
    void run(async () => { workflowResult = await api.runScoreToSynthv(scorePath, trackIndex, groupName, rightsConfirmed); notice = workflowResult.summary; });
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
  const pipelineImport = document.querySelector<HTMLInputElement>("#pipeline-import");
  const pipelineImportOptions = document.querySelector<HTMLElement>("#pipeline-import-options");
  const pipelineSubmit = document.querySelector<HTMLButtonElement>("#pipeline-submit");
  const syncPipelineMode = () => {
    const enabled = pipelineImport?.checked ?? false;
    if (pipelineImportOptions) {
      pipelineImportOptions.hidden = !enabled;
      pipelineImportOptions.querySelectorAll<HTMLInputElement>("input").forEach((input) => { input.disabled = !enabled; });
    }
    if (pipelineSubmit) pipelineSubmit.innerHTML = `${icon("pipeline", 16)} ${enabled ? "提取并导入 SynthV" : "提取并导出 MIDI"}`;
  };
  pipelineImport?.addEventListener("change", syncPipelineMode);
  syncPipelineMode();
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
  document.querySelector<HTMLFormElement>("#ab-capture-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    const slot = submitter?.value === "baseline" ? "baseline" : "candidate";
    const processValue = document.querySelector<HTMLSelectElement>("#ab-process")?.value ?? "";
    abProcessId = processValue ? Number(processValue) : undefined;
    abStartSeconds = Number(document.querySelector<HTMLInputElement>("#ab-start")?.value ?? "0");
    abEndSeconds = Number(document.querySelector<HTMLInputElement>("#ab-end")?.value ?? "5");
    abPreRollSeconds = Number(document.querySelector<HTMLInputElement>("#ab-preroll")?.value ?? "0.4");
    abPostRollSeconds = Number(document.querySelector<HTMLInputElement>("#ab-postroll")?.value ?? "0.25");
    const label = document.querySelector<HTMLInputElement>("#ab-label")?.value.trim() || "局部优化";
    void run(async () => {
      workflowResult = await api.captureSynthvClip(abProcessId, abStartSeconds, abEndSeconds, abPreRollSeconds, abPostRollSeconds, `${label}-${slot === "baseline" ? "A" : "B"}`);
      if (slot === "baseline") abBaselinePath = workflowResult.outputPath ?? "";
      else abCandidatePath = workflowResult.outputPath ?? "";
      notice = workflowResult.summary;
    });
  });
  document.querySelector<HTMLFormElement>("#ab-compare-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    abBaselinePath = document.querySelector<HTMLInputElement>("#ab-baseline-path")?.value.trim() ?? "";
    abCandidatePath = document.querySelector<HTMLInputElement>("#ab-candidate-path")?.value.trim() ?? "";
    const maxLagMs = Number(document.querySelector<HTMLInputElement>("#ab-max-lag")?.value ?? "250");
    void run(async () => { workflowResult = await api.compareSynthvClips(abBaselinePath, abCandidatePath, maxLagMs); notice = workflowResult.summary; });
  });
  document.querySelector<HTMLFormElement>("#rhyme-lookup-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    syncLyricDraftFromDom();
    lyricRhymeQuery = document.querySelector<HTMLInputElement>("#rhyme-query")?.value.trim() ?? "";
    lyricRhymeMode = (document.querySelector<HTMLSelectElement>("#rhyme-match-mode")?.value ?? "family") as RhymeMatchMode;
    void run(async () => {
      lyricRhymeResult = await api.lookupChineseRhyme(lyricRhymeQuery, lyricRhymeMode);
      notice = `已找到 ${lyricRhymeResult.total.toLocaleString()} 个 ${lyricRhymeResult.rhymeKeys.join(" / ")} 同韵字。`;
    });
  });
  document.querySelector<HTMLFormElement>("#lyric-structure-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    syncLyricDraftFromDom();
    void run(async () => {
      workflowResult = await api.buildLyricTemplate("zh-CN", lyricSongTitle, lyricSections, lyricRhymeTargets);
      notice = workflowResult.summary;
    });
  });
  document.querySelector<HTMLFormElement>("#lyric-candidate-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    syncLyricDraftFromDom();
    void run(async () => {
      lyricCandidates = await withAiProviderStateRefresh(() => api.generateLyricCandidates({
        language: "zh-CN",
        brief: lyricCandidateBrief,
        imagery: lyricCandidateImagery,
        sectionLabel: lyricCandidateSection,
        tone: lyricCandidateTone,
        targetRhyme: lyricCandidateRhyme,
        candidateCount: lyricCandidateCount,
      }));
      notice = `Copilot 已生成 ${lyricCandidates.candidates.length} 条原创候选，尚未写入草稿。`;
    });
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
    void run(async () => {
      profiles = await api.importCurrentSv2Profile(displayName);
      const prepared = await prepareConcurrentSlotsWhenEnabled();
      await refreshAccountUsage();
      notice = `已导入“${displayName}”。${prepared ? "已自动准备隔离数据。" : ""}`;
    });
  });
  document.querySelector<HTMLFormElement>("#profile-create-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const displayName = document.querySelector<HTMLInputElement>("#profile-create-name")?.value.trim() ?? "";
    if (!displayName) return;
    void run(async () => {
      profiles = await api.createSv2Profile(displayName);
      const prepared = await prepareConcurrentSlotsWhenEnabled();
      await refreshAccountUsage();
      notice = `已创建“${displayName}”。${prepared ? "已自动准备隔离数据。" : ""}`;
    });
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
        : "已清除用户确认记录；只有官方许可结果会显示为账号授权。";
    });
  }));
  document.querySelector<HTMLFormElement>("#sv2-global-settings-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const concurrentEnabled = form.querySelector<HTMLInputElement>('[name="concurrentEnabled"]')?.checked ?? false;
    const accountProbeEnabled = form.querySelector<HTMLInputElement>('[name="accountProbeEnabled"]')?.checked ?? false;
    if (accountProbeEnabled && !app?.sv2AccountIndicatorEnabled) {
      pendingAccountIndicatorConsent = { refreshAfterEnable: true, concurrentEnabled };
      accountManagerOpen = false;
      render();
      return;
    }
    void run(async () => {
      app = await api.setSv2ConcurrentEnabled(concurrentEnabled);
      const prepared = await prepareConcurrentSlotsWhenEnabled();
      app = await api.setSv2AccountIndicator(accountProbeEnabled);
      if (!accountProbeEnabled) profiles = await api.sv2ProfileState();
      notice = `全局设置已保存。${prepared ? `已自动准备 ${prepared} 个隔离数据目录。` : ""}`;
    });
  });
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
  document.querySelectorAll<HTMLFormElement>("[data-ai-provider-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const provider = parseAiProviderId(form.dataset.aiProviderForm);
      const model = form.querySelector<HTMLSelectElement>("select[name='model']")?.value.trim() ?? "";
      if (!provider || !model || busy) return;
      clearPendingAiAccountRemoval();
      void run(async () => {
        app = await api.selectAiProvider(provider, model);
        expandedAiProvider = provider;
        notice = "当前 AI 提供商与模型已更新。";
      });
    });
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
    const added = await withAiProviderStateRefresh(() => api.sendMessage(input));
    conversation.messages = conversation.messages.filter((message) => message !== optimistic);
    conversation.messages.push(...added);
    conversations = await api.listConversations();
  });
}

async function refreshAiProviderSummary(): Promise<void> {
  if (app?.mode === "ai") app.model = await api.aiProviderState();
}

async function loadOpenCodeCatalog(force: boolean): Promise<void> {
  if (openCodeCatalogLoading || app?.mode !== "ai") return;
  openCodeCatalogLoading = true;
  openCodeCatalogError = "";
  try {
    openCodeCatalog = await api.opencodeProviderCatalog(force);
  } catch (reason) {
    openCodeCatalogError = reason instanceof Error ? reason.message : String(reason);
  } finally {
    openCodeCatalogLoading = false;
    render();
  }
}

async function withAiProviderStateRefresh<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } finally {
    try {
      await refreshAiProviderSummary();
    } catch {
      // Preserve the original model request result/error. The next bootstrap or
      // provider-state refresh will retry this best-effort status update.
    }
  }
}

document.addEventListener("input", (event) => {
  const target = event.target as HTMLElement;
  if (!target.closest(".lyric-workbench-grid")) return;
  if (lyricPersistTimer !== undefined) window.clearTimeout(lyricPersistTimer);
  lyricPersistTimer = window.setTimeout(() => {
    lyricPersistTimer = undefined;
    syncLyricDraftFromDom();
  }, 250);
});

document.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("button, [data-page], [data-onboarding]");
  if (!target || target.hasAttribute("disabled")) return;
  if (page === "lyrics" && document.querySelector(".lyric-workbench-grid")) syncLyricDraftFromDom();
  if (target.hasAttribute("data-toggle-sidebar")) {
    sidebarCollapsed = !sidebarCollapsed;
    try { localStorage.setItem("pi.sidebar.collapsed", String(sidebarCollapsed)); } catch { /* preference remains in memory */ }
    render();
    return;
  }
  if (target.hasAttribute("data-copy-lyric-draft")) {
    const draft = document.querySelector<HTMLTextAreaElement>("#lyric-draft");
    if (!draft?.value.trim()) return;
    void navigator.clipboard.writeText(draft.value).then(() => {
      notice = "歌词已复制到剪贴板。";
      render();
    }).catch(() => {
      error = "无法访问剪贴板，请直接从草稿框复制。";
      render();
    });
    return;
  }
  if (target.hasAttribute("data-new-lyric-project")) {
    if (lyricProjectHasUnsavedChanges() && !window.confirm("当前项目有未保存修改。新建项目会清空当前工作区，是否继续？")) return;
    startNewLyricProject();
    notice = "已建立新的本地歌词草稿；保存后会成为独立歌曲项目。";
    render();
    return;
  }
  if (target.hasAttribute("data-save-lyric-project")) {
    void run(async () => {
      syncLyricDraftFromDom();
      const project = lyricProjectId
        ? await api.saveLyricProject(lyricProjectId, lyricSongTitle, lyricDraft, lyricSections, lyricRhymeTargets)
        : await api.createLyricProject(lyricSongTitle, lyricDraft, lyricSections, lyricRhymeTargets);
      applyLyricProject(project);
      lyricProjects = await api.listLyricProjects();
      notice = `《${project.title}》已保存到本机项目（r${project.revision}）。`;
    });
    return;
  }
  if (target.hasAttribute("data-load-lyric-project")) {
    const id = document.querySelector<HTMLSelectElement>("#lyric-project-select")?.value;
    if (!id) {
      error = "请选择要打开的歌词项目。";
      render();
      return;
    }
    if (lyricProjectHasUnsavedChanges() && !window.confirm("当前项目有未保存修改。打开其他项目会丢弃这些修改，是否继续？")) return;
    void run(async () => {
      const project = await api.loadLyricProject(id);
      applyLyricProject(project);
      notice = `已打开《${project.title}》的本地项目。`;
    });
    return;
  }
  if (target.hasAttribute("data-clear-lyric-draft")) {
    const draft = document.querySelector<HTMLTextAreaElement>("#lyric-draft");
    if (!draft?.value.trim()) return;
    if (!window.confirm("清空当前歌词草稿？此操作只能通过撤销或重新输入恢复。")) return;
    lyricDraft = "";
    persistLyricWorkspace();
    notice = "歌词草稿已清空。";
    render();
    return;
  }
  if (target.hasAttribute("data-refresh-capture-targets")) {
    void run(async () => {
      audioCaptureCapability = await api.audioCaptureCapability();
      audioCaptureTargets = audioCaptureCapability.supported ? await api.listSynthvCaptureTargets() : [];
      if (!audioCaptureTargets.some((item) => item.processId === abProcessId)) abProcessId = audioCaptureTargets[0]?.processId;
      notice = !audioCaptureCapability.supported
        ? audioCaptureCapability.detail
        : audioCaptureTargets.length
          ? `发现 ${audioCaptureTargets.length} 个 SynthV standalone 实例。`
          : "没有发现运行中的 SynthV standalone 实例。";
    });
    return;
  }
  if (target.hasAttribute("data-refresh-opencode-catalog")) {
    void loadOpenCodeCatalog(true);
    return;
  }
  const lyricPreset = target.dataset.lyricPreset as "compact" | "pop" | "rap" | "blank" | undefined;
  if (lyricPreset) {
    syncLyricDraftFromDom();
    lyricSections = createLyricPreset(lyricPreset);
    lyricCandidateSection = lyricSections.find((section) => section.kind === "chorus")?.label ?? lyricSections[0]?.label ?? "";
    workflowResult = undefined;
    persistLyricWorkspace();
    render();
    return;
  }
  if (target.hasAttribute("data-add-lyric-section")) {
    syncLyricDraftFromDom();
    lyricSections.push(createLyricSection("custom", `段落 ${lyricSections.length + 1}`, 4, "AAAA"));
    persistLyricWorkspace();
    render();
    return;
  }
  if (target.dataset.removeLyricSection) {
    syncLyricDraftFromDom();
    if (lyricSections.length <= 1) {
      error = "歌曲结构至少需要一个段落。";
    } else {
      lyricSections = lyricSections.filter((section) => section.id !== target.dataset.removeLyricSection);
      error = "";
    }
    persistLyricWorkspace();
    render();
    return;
  }
  if (target.dataset.moveLyricSection && target.dataset.sectionId) {
    syncLyricDraftFromDom();
    const index = lyricSections.findIndex((section) => section.id === target.dataset.sectionId);
    const nextIndex = target.dataset.moveLyricSection === "up" ? index - 1 : index + 1;
    if (index >= 0 && nextIndex >= 0 && nextIndex < lyricSections.length) {
      [lyricSections[index], lyricSections[nextIndex]] = [lyricSections[nextIndex], lyricSections[index]];
    }
    persistLyricWorkspace();
    render();
    return;
  }
  if (target.dataset.rhymeCharacter) {
    const draft = document.querySelector<HTMLTextAreaElement>("#lyric-draft");
    if (draft) {
      const start = draft.selectionStart;
      const end = draft.selectionEnd;
      draft.setRangeText(target.dataset.rhymeCharacter, start, end, "end");
      lyricDraft = draft.value;
      persistLyricWorkspace();
      draft.focus();
    }
    return;
  }
  if (target.dataset.useLyricCandidate !== undefined && lyricCandidates) {
    syncLyricDraftFromDom();
    const candidate = lyricCandidates.candidates[Number(target.dataset.useLyricCandidate)];
    if (candidate) {
      lyricDraft = `${lyricDraft.trimEnd()}${lyricDraft.trim() ? "\n" : ""}${candidate.text}`;
      persistLyricWorkspace();
      notice = "候选已加入草稿；原候选仍保留。";
      render();
    }
    return;
  }
  if (target.hasAttribute("data-insert-lyric-template") && workflowResult?.kind === "lyric-template") {
    syncLyricDraftFromDom();
    const data = asObject(workflowResult.data);
    const sections = Array.isArray(data?.sections) ? data.sections.map(asObject).filter((section): section is JsonObject => Boolean(section)) : [];
    const skeleton = sections.map((section) => {
      const lines = Array.isArray(section.lines) ? section.lines.map(asObject).filter((line): line is JsonObject => Boolean(line)) : [];
      return `[${String(section.label ?? "未命名段落")}]\n${lines.map((line) => `（${String(line.placeholder ?? "填写歌词")}）`).join("\n")}`;
    }).join("\n\n");
    lyricDraft = `${lyricDraft.trimEnd()}${lyricDraft.trim() ? "\n\n" : ""}${skeleton}`;
    persistLyricWorkspace();
    notice = "结构骨架已加入歌词草稿。";
    render();
    return;
  }
  if (target.hasAttribute("data-cancel-svp-route")) {
    pendingSvpRoute = undefined;
    render();
    return;
  }
  if (target.hasAttribute("data-cancel-account-indicator")) {
    pendingAccountIndicatorConsent = undefined;
    render();
    return;
  }
  if (target.hasAttribute("data-confirm-account-indicator")) {
    const consent = pendingAccountIndicatorConsent;
    if (!consent) return;
    pendingAccountIndicatorConsent = undefined;
    void run(async () => {
      if (consent.concurrentEnabled !== undefined) {
        app = await api.setSv2ConcurrentEnabled(consent.concurrentEnabled);
        await prepareConcurrentSlotsWhenEnabled();
      }
      app = await api.setSv2AccountIndicator(true, true);
      if (consent.refreshAfterEnable) await refreshAccountUsage(consent.refreshSlotId);
      notice = "账号登录指示器已开启，access JWT 已按需自动续期并完成首次预检。";
    });
    return;
  }
  if (target.hasAttribute("data-request-account-indicator")) {
    pendingAccountIndicatorConsent = { refreshAfterEnable: true };
    render();
    return;
  }
  if (target.hasAttribute("data-disable-account-indicator")) {
    void run(async () => {
      app = await api.setSv2AccountIndicator(false);
      profiles = await api.sv2ProfileState();
      notice = "账号登录指示器已关闭；之后进入账号页不会探测官方登录接口。";
    });
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
  if (target.dataset.deleteProfile) {
    pendingProfileDeletionId = target.dataset.deleteProfile;
    render();
    return;
  }
  if (target.hasAttribute("data-cancel-profile-deletion")) {
    pendingProfileDeletionId = undefined;
    render();
    return;
  }
  if (target.hasAttribute("data-confirm-profile-deletion")) {
    const slotId = pendingProfileDeletionId;
    if (!slotId) return;
    pendingProfileDeletionId = undefined;
    void run(async () => {
      profiles = await api.deleteSv2Profile(slotId);
      managedProfileSlotId = profiles.slots.find((slot) => slot.isActive)?.id ?? profiles.slots[0]?.id;
      accountManagerOpen = false;
      notice = "账号槽位及其本机数据已删除。";
    });
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
    clearPendingAiAccountRemoval();
    const enteringAccounts = targetPage === "accounts" && page !== "accounts";
    page = targetPage;
    if (page === "lyrics" && workflowResult?.kind !== "lyric-template") workflowResult = undefined;
    if (page === "toolbox" && workflowResult?.kind === "lyric-template") workflowResult = undefined;
    accountManagerOpen = false;
    notice = "";
    error = "";
    if (page === "copilot") void run(async () => { conversations = await api.listConversations(); });
    else if (page === "history") void run(async () => { [creativeHistory, projectCheckpoints] = await Promise.all([api.listCreativeHistory(), api.listProjectCheckpoints()]); });
    else if (enteringAccounts && (app?.platform === "windows" || app?.platform === "macos" || app?.platform === "preview")) void run(async () => {
      if (supportsWindowsSv2Extensions() && app?.sv2AccountIndicatorEnabled) await refreshAccountUsage();
      else profiles = await api.sv2ProfileState();
    });
    else render();
    resetContentScroll();
    return;
  }
  const onboarding = target.dataset.onboarding as AppMode | undefined;
  if (onboarding) { void run(async () => { app = await api.completeOnboarding(onboarding); page = "home"; }); return; }
  const mode = target.dataset.setMode as AppMode | undefined;
  if (mode) { void run(async () => { app = await api.setMode(mode); notice = `已切换到${mode === "ai" ? " AI 模式" : "纯工具箱模式"}。`; }); return; }
  if (target.hasAttribute("data-enable-ai")) { page = "settings"; render(); return; }
  const toggledProvider = parseAiProviderId(target.dataset.toggleAiProvider);
  if (target.dataset.toggleAiProvider !== undefined) {
    if (!toggledProvider) return;
    expandedAiProvider = expandedAiProvider === toggledProvider ? undefined : toggledProvider;
    clearPendingAiAccountRemoval();
    render();
    return;
  }
  const authorizedProvider = parseAiProviderId(target.dataset.authorizeAiProvider);
  if (target.dataset.authorizeAiProvider !== undefined) {
    if (!authorizedProvider || busy || authorizingAiProvider) return;
    authorizingAiProvider = authorizedProvider;
    void run(async () => {
      try {
        app = await api.authorizeAiProvider(authorizedProvider);
        expandedAiProvider = authorizedProvider;
        notice = "官方账号授权已更新。";
      } finally {
        authorizingAiProvider = undefined;
      }
    });
    return;
  }
  if (target.dataset.removeAiAccount && target.dataset.aiProvider) {
    const provider = parseAiProviderId(target.dataset.aiProvider);
    const accountId = target.dataset.removeAiAccount;
    if (!provider || busy) return;
    const confirmed = pendingAiAccountRemoval?.provider === provider
      && pendingAiAccountRemoval.accountId === accountId;
    if (!confirmed) {
      armAiAccountRemoval(provider, accountId);
      render();
      focusAiAccountRemovalButton(provider, accountId);
      return;
    }
    clearPendingAiAccountRemoval();
    void run(async () => {
      app = await api.removeAiProviderAccount(provider, accountId);
      expandedAiProvider = provider;
      notice = "账号授权已从本机移除。";
    });
    return;
  }
  if (target.hasAttribute("data-check-toolbox-update")) {
    void run(async () => {
      toolboxUpdate = await api.checkToolboxUpdate();
      notice = toolboxUpdate.updateAvailable
        ? `发现新版本 v${toolboxUpdate.latestVersion}。`
        : toolboxUpdate.latestVersion === toolboxUpdate.currentVersion
          ? "当前已是最新稳定版。"
          : "当前应用版本高于最新稳定版。";
    });
    return;
  }
  if (target.hasAttribute("data-open-toolbox-releases")) {
    void run(async () => { setFeedback(await api.openToolboxReleases()); });
    return;
  }
  if (target.dataset.feature) {
    page = "toolbox";
    activeWorkflow = target.dataset.feature;
    workflowResult = undefined;
    syncManifest = undefined;
    notice = "";
    const featureId = target.dataset.feature;
    if (featureId === "batch-recipes") void run(async () => { workflowRecipes = await api.listWorkflowRecipes(); });
    else if (featureId === "ab-audition") void run(async () => {
      audioCaptureCapability = await api.audioCaptureCapability();
      audioCaptureTargets = audioCaptureCapability.supported ? await api.listSynthvCaptureTargets() : [];
      if (!audioCaptureTargets.some((item) => item.processId === abProcessId)) abProcessId = audioCaptureTargets[0]?.processId;
    });
    else if (featureId === "selective-sync") void run(async () => {
      [syncCategories, profiles] = await Promise.all([api.sv2SyncCategories(), api.sv2ProfileState()]);
      const slots = profiles?.slots ?? [];
      if (!slots.some((slot) => slot.id === syncSourceSlotId)) syncSourceSlotId = slots[0]?.id ?? "";
      if (!slots.some((slot) => slot.id === syncTargetSlotId) || syncTargetSlotId === syncSourceSlotId) {
        syncTargetSlotId = slots.find((slot) => slot.id !== syncSourceSlotId)?.id ?? "";
      }
      syncSelectedCategories = syncCategories.map((category) => category.id);
    });
    else render();
    resetContentScroll();
    return;
  }
  if (target.hasAttribute("data-close-workflow")) { activeWorkflow = undefined; workflowResult = undefined; render(); return; }
  if (target.hasAttribute("data-review-workflow") && workflowResult) {
    const currentResult = workflowResult;
    void run(async () => {
      currentResult.aiReview = await withAiProviderStateRefresh(() =>
        api.reviewWorkflow(currentResult.kind, currentResult.data));
    });
    return;
  }
  const exportFormat = target.dataset.exportWorkflow as "markdown" | "json" | undefined;
  if (exportFormat && workflowResult) {
    const currentResult = workflowResult;
    void run(async () => {
      const exported = await api.exportWorkflowReport(currentResult.kind, currentResult.summary, currentResult.data, exportFormat);
      notice = `${exported.summary} ${exported.detail}`;
    });
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
  if (target.hasAttribute("data-refresh-synthv-processes")) {
    void run(async () => {
      [synthvProcesses, synthvShortcutProfile] = await Promise.all([api.listSynthvProcesses(), api.synthvShortcutProfile()]);
      notice = synthvProcesses.length ? `发现 ${synthvProcesses.length} 个运行中的 SynthV 进程。` : "没有发现运行中的 SynthV 进程。";
    });
    return;
  }
  if (target.dataset.autoConnectSynthv) {
    const processId = Number(target.dataset.autoConnectSynthv);
    if (Number.isInteger(processId) && processId > 0) {
      void run(async () => {
        setFeedback(await api.autoConnectSynthvBridge(processId));
        await refresh();
      });
    }
    return;
  }
  if (target.dataset.sendSynthvStop) {
    const processId = Number(target.dataset.sendSynthvStop);
    if (Number.isInteger(processId) && processId > 0) {
      void run(async () => {
        setFeedback(await api.sendSynthvBridgeShortcut(processId, "stop"));
        synthvProcesses = await api.listSynthvProcesses();
      });
    }
    return;
  }
  if (target.hasAttribute("data-profile-refresh")) {
    if (!app?.sv2AccountIndicatorEnabled) {
      pendingAccountIndicatorConsent = { refreshAfterEnable: true };
      render();
    } else {
      void run(async () => {
        await refreshAccountUsage();
        notice = "账号槽位、JWT 续期与登录冲突状态已刷新。";
      });
    }
    return;
  }
  if (target.dataset.profileRefreshSlot) {
    const slotId = target.dataset.profileRefreshSlot;
    if (!app?.sv2AccountIndicatorEnabled) {
      pendingAccountIndicatorConsent = { refreshAfterEnable: true, refreshSlotId: slotId };
      render();
    } else {
      void run(async () => {
        await refreshAccountUsage(slotId);
        const slot = profiles?.slots.find((item) => item.id === slotId);
        const failed = slot
          ? [slot.accountProbe, ...(slot.concurrent.ready ? [slot.concurrentAccountProbe] : [])]
            .filter((probe) => probe.sessionStatus === "syncFailed")
          : [];
        if (failed.length) {
          error = `此账号刷新后仍未同步：${failed.map((probe) => probe.detail).filter(Boolean).join("；")}`;
        } else {
          notice = "此账号的 JWT、授权与登录冲突状态已刷新。";
        }
      });
    }
    return;
  }
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
  if (target.hasAttribute("data-cancel-component-removal")) {
    pendingComponentRemovalId = undefined;
    render();
    return;
  }
  if (target.hasAttribute("data-confirm-component-removal")) {
    const componentId = pendingComponentRemovalId;
    if (!componentId) return;
    pendingComponentRemovalId = undefined;
    removingComponentId = componentId;
    void run(async () => {
      const result = await api.removeLocalComponent(componentId);
      if (result.succeeded) await refresh();
      setFeedback(result);
    }).finally(() => {
      if (removingComponentId === componentId) removingComponentId = undefined;
      render();
    });
    return;
  }
  if (target.dataset.removeComponent) {
    const component = app?.components.find((item) => item.id === target.dataset.removeComponent);
    if (!busy && component?.removable) {
      pendingComponentRemovalId = component.id;
      render();
    }
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
  if (target.dataset.cancelComponentTask) {
    void run(async () => {
      if (app) app.downloads = await api.cancelComponentInstall(target.dataset.cancelComponentTask ?? "");
      notice = "排队中的组件任务已取消。";
    });
    return;
  }
  if (target.dataset.retryComponentTask) {
    void run(async () => {
      if (app) app.downloads = await api.retryComponentInstall(target.dataset.retryComponentTask ?? "");
      notice = "组件任务已重新加入队列。";
    });
    return;
  }
  if (target.dataset.cancelMediaTask) {
    void run(async () => {
      const task = await api.cancelMediaTask(target.dataset.cancelMediaTask ?? "");
      mediaTasks = mediaTasks.map((item) => item.id === task.id ? task : item);
      notice = task.status === "cancelled" ? "媒体任务已取消。" : "正在终止媒体进程树。";
    });
    return;
  }
  if (target.dataset.retryMediaTask) {
    void run(async () => {
      const task = await api.retryMediaTask(target.dataset.retryMediaTask ?? "");
      mediaTasks = mediaTasks.map((item) => item.id === task.id ? task : item);
      notice = "媒体任务已重新加入队列。";
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
    root.innerHTML = `<div class="fatal"><div class="brand-mark"><img class="brand-logo" src="/assets/synthv-toolbox-logo.png" alt="SynthV Toolbox" /></div><h1>无法启动 SynthV Toolbox</h1><pre>${escapeHtml(formatError(reason))}</pre><p>请确认应用由 Tauri 运行，而不是直接打开前端页面。</p></div>`;
  }
})();
