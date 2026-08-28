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
let activeWorkflow: Feature["id"] | undefined;
let workflowResult: WorkflowResult | undefined;

const pageMeta: Record<Page, { title: string; subtitle: string }> = {
  home: { title: "概览", subtitle: "查看环境状态与常用能力" },
  accounts: { title: "SV2 账号", subtitle: "像游戏启动器一样选择默认账号环境" },
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
    </div>`;
  wireForms();
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
  const blockerPanel = profiles.blockers.length ? `<div class="warning-card profile-blockers"><span>${icon("plug", 23)}</span><div><strong>切换前需要关闭这些程序</strong><p>${profiles.blockers.map((blocker) => `${escapeHtml(blocker.name)}${blocker.pid ? ` (PID ${blocker.pid})` : ""}：${escapeHtml(blocker.reason)}`).join("<br />")}</p></div></div>` : "";
  const providerPanel = profiles.concurrentProvider.available
    ? `<section class="panel concurrent-provider ready"><span class="feature-icon violet">${icon("boxes", 23)}</span><div><strong>实验性并发隔离已可用</strong><p>${escapeHtml(profiles.concurrentProvider.detail)} 每个槽位使用独立文件、注册表和 IPC 命名空间；当前仅启动 standalone。网络不被工具箱拦截，账号与工程同步是否可用由 Dreamtonics 官方服务决定。</p></div></section>`
    : `<section class="panel concurrent-provider"><span class="feature-icon orange">${icon("boxes", 23)}</span><div><strong>实验性并发隔离尚不可用</strong><p>${escapeHtml(profiles.concurrentProvider.detail)}</p></div></section>`;
  const concurrentProviderAvailable = profiles.concurrentProvider.available;
  if (profiles.recoveryRequired) {
    return `${blockerPanel}<div class="warning-card recovery-card"><span>${icon("refresh", 23)}</span><div><strong>槽位需要人工恢复</strong><p>${escapeHtml(profiles.recoveryDetail)}</p><p>工具箱没有删除或覆盖任何目录。请先备份下方路径，再检查目录实况。</p></div><button class="secondary" data-profile-refresh>${icon("refresh", 16)} 重新检查</button></div>
      <section class="panel"><dl class="detail-list"><div><dt>官方路径</dt><dd><code>${escapeHtml(profiles.canonicalPath)}</code></dd></div><div><dt>保管区</dt><dd><code>${escapeHtml(profiles.vaultPath)}</code></dd></div></dl></section>`;
  }
  const cards = profiles.slots.map((slot) => {
    const lastUsed = slot.lastActivatedAtUtc ? new Date(slot.lastActivatedAtUtc).toLocaleString("zh-CN") : "尚未启动";
    const initial = Array.from(slot.displayName)[0] ?? "S";
    const color = /^#[0-9a-f]{6}$/i.test(slot.color) ? slot.color : "#6D5CE7";
    const concurrentRunning = slot.concurrent.runningPids.length > 0;
    const concurrentControls = slot.concurrent.ready
      ? `<button class="secondary concurrent-launch" data-profile-concurrent-launch="${slot.id}" ${concurrentProviderAvailable && !concurrentRunning ? "" : "disabled"}>${icon("boxes", 16)} ${concurrentRunning ? "隔离实例运行中" : "并发启动"}</button><button class="icon-plain" data-profile-concurrent-folder="${slot.id}" title="打开隔离副本目录">${icon("folder", 17)}</button>`
      : `<button class="secondary" data-profile-concurrent-prepare="${slot.id}" ${concurrentProviderAvailable ? "" : "disabled"}>${icon("download", 16)} 准备并发副本</button>`;
    return `<article class="profile-card ${slot.isActive ? "active" : ""}" style="--profile-color:${color}">
      <div class="profile-card-head"><span class="profile-avatar">${escapeHtml(initial)}</span><div><span class="eyebrow">${slot.isActive ? "CURRENT DEFAULT" : "SV2 PROFILE"}</span><h2>${escapeHtml(slot.displayName)}</h2></div>${slot.isActive ? '<span class="profile-active-badge">当前默认</span>' : ""}</div>
      <div class="profile-meta"><span>${slot.sessionCached ? `${icon("check", 14)} 会话缓存存在` : `${icon("plug", 14)} 首次启动需登录`}</span><span>最近使用：${escapeHtml(lastUsed)}</span></div>
      <div class="profile-actions"><button class="primary" data-profile-launch="${slot.id}">${icon("play", 16)} ${slot.isActive ? "启动 SV2" : "使用并启动"}</button>${slot.isActive ? "" : `<button class="secondary" data-profile-activate="${slot.id}">设为默认</button>`}<button class="icon-plain profile-folder" data-profile-folder="${slot.id}" title="打开数据目录">${icon("folder", 18)}</button></div>
      <div class="profile-concurrent ${slot.concurrent.ready ? "ready" : ""}"><div><span>EXPERIMENTAL CONCURRENT</span>${concurrentRunning ? `<strong>${icon("plug", 13)} ${slot.concurrent.runningPids.length} 个隔离进程</strong>` : ""}</div><p>${escapeHtml(slot.concurrent.detail)}</p><div class="profile-concurrent-actions">${concurrentControls}</div>${slot.concurrent.ready ? `<code title="${escapeHtml(slot.concurrent.dataPath)}">${escapeHtml(slot.concurrent.boxName)}</code>` : ""}</div>
      <form class="profile-rename" data-profile-rename-form="${slot.id}"><label>槽位名称<input value="${escapeHtml(slot.displayName)}" maxlength="64" required /></label><button class="secondary">保存名称</button></form>
      <code class="profile-path" title="${escapeHtml(slot.dataPath)}">${escapeHtml(slot.dataPath)}</code>
    </article>`;
  }).join("");
  const importPanel = profiles.canImportCurrent ? `<section class="panel profile-setup"><div class="panel-heading"><span class="feature-icon emerald">${icon("folder", 24)}</span><div><h2>导入当前 SV2 环境</h2><p>现有官方数据目录尚未纳入槽位；导入不会移动账号文件。</p></div></div><form id="profile-import-form" class="profile-create-form"><input id="profile-import-name" maxlength="64" required placeholder="例如 主账号" /><button class="primary">导入为第一个槽位</button></form></section>` : "";
  const createPanel = `<section class="panel profile-setup"><div class="panel-heading"><span class="feature-icon blue">${icon("plus", 24)}</span><div><h2>新建账号槽位</h2><p>创建空环境；首次“使用并启动”后在 Dreamtonics 官方页面登录。</p></div></div><form id="profile-create-form" class="profile-create-form"><input id="profile-create-name" maxlength="64" required placeholder="例如 制作账号" /><button class="secondary">创建空槽位</button></form></section>`;
  return `<div class="profile-intro"><div><span class="eyebrow">ACCOUNT LAUNCHER</span><h2>选择账号环境，再启动 SynthV</h2><p>直接启动 SV2 或双击 .svp 时会继续使用“当前默认”槽位。工具箱不读取账号邮箱、密码或 session 内容。</p></div><button class="secondary" data-profile-refresh>${icon("refresh", 16)} 刷新状态</button></div>
    ${providerPanel}
    ${blockerPanel}
    <div class="profile-grid">${cards || '<div class="empty-inline">还没有账号槽位。请导入当前环境或创建一个空槽位。</div>'}</div>
    <div class="profile-setup-grid">${importPanel}${createPanel}</div>
    <section class="panel profile-safety"><span>${icon("check", 18)}</span><div><strong>完整环境隔离</strong><p>每个槽位包含 license、WebView2、设置、数据库、缓存和脚本。切换只在相关进程全部退出后进行，失败时绝不覆盖目录。</p></div></section>`;
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

function renderToolbox(): string {
  if (!app) return "";
  const current = app;
  return `${activeWorkflow ? renderWorkflowPanel(activeWorkflow) : ""}<div class="section-heading"><div><h2>创作能力</h2><p>基础流程在两种模式下都可用；带 ${icon("sparkles", 14)} 的能力由后端限定为 AI 模式。</p></div></div>
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
  return `<div class="section-heading"><div><h2>本地组件</h2><p>所有组件都安装在用户数据目录；无可信来源的组件会拒绝下载。</p></div></div>
    <div class="component-list">${app.components.map((component) => `<article class="component-row"><span class="component-status ${component.installed ? "ready" : ""}">${component.installed ? icon("check", 18) : icon("download", 18)}</span><div><h3>${escapeHtml(component.displayName)}</h3><p>${escapeHtml(component.description)}</p><div class="tags"><span>${escapeHtml(component.audience)}</span><span>${escapeHtml(component.status)}</span></div></div><button class="secondary" data-install-component="${escapeHtml(component.id)}" ${component.installed ? "disabled" : ""}>${component.installed ? "已就绪" : "安装"}</button></article>`).join("")}</div>`;
}

function renderBridge(): string {
  if (!app) return "";
  return `<div class="bridge-grid"><section class="panel"><div class="panel-heading"><span class="feature-icon orange">${icon("bridge", 25)}</span><div><h2>Synthesizer V 探测</h2><p>Windows 与 macOS 使用各自的标准路径，只进行只读检查。</p></div><button class="secondary compact" data-scan>${icon("refresh", 16)} 重新探测</button></div>
    <div class="installation-list">${app.installations.length ? app.installations.map((item) => `<button data-scripts="${escapeHtml(item.scriptsPath ?? "")}"><span class="status-dot online"></span><span><strong>${escapeHtml(item.displayName)}</strong><small>${escapeHtml(item.scriptsPath ?? item.installPath ?? item.source)}</small></span></button>`).join("") : '<div class="empty-inline">没有自动发现 SynthV；可以手动填写 scripts 目录。</div>'}</div></section>
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
  const targetPage = target.dataset.page as Page | undefined;
  if (targetPage) {
    page = targetPage;
    notice = "";
    error = "";
    if (page === "copilot") void run(async () => { conversations = await api.listConversations(); });
    else if (page === "accounts") void run(async () => { profiles = await api.sv2ProfileState(); });
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
    render();
    return;
  }
  if (target.hasAttribute("data-close-workflow")) { activeWorkflow = undefined; workflowResult = undefined; render(); return; }
  if (target.hasAttribute("data-review-workflow") && workflowResult) {
    void run(async () => { if (workflowResult) workflowResult.aiReview = await api.reviewWorkflow(workflowResult.kind, workflowResult.data); });
    return;
  }
  if (target.hasAttribute("data-scan")) { void run(async () => { if (app) app.installations = await api.scanSynthV(); notice = "探测完成。"; }); return; }
  if (target.hasAttribute("data-profile-refresh")) { void run(async () => { profiles = await api.sv2ProfileState(); notice = "账号槽位状态已刷新。"; }); return; }
  if (target.dataset.profileLaunch) { void run(async () => { setFeedback(await api.launchSv2Profile(target.dataset.profileLaunch ?? "")); profiles = await api.sv2ProfileState(); }); return; }
  if (target.dataset.profileActivate) { void run(async () => { profiles = await api.activateSv2Profile(target.dataset.profileActivate ?? ""); notice = "默认账号槽位已切换。"; }); return; }
  if (target.dataset.profileFolder) { void run(async () => { setFeedback(await api.openSv2ProfileFolder(target.dataset.profileFolder ?? "")); }); return; }
  if (target.dataset.profileConcurrentPrepare) { void run(async () => { profiles = await api.prepareSv2ConcurrentProfile(target.dataset.profileConcurrentPrepare ?? ""); notice = "隔离副本已准备，可以并发启动。"; }); return; }
  if (target.dataset.profileConcurrentLaunch) { void run(async () => { setFeedback(await api.launchSv2ConcurrentProfile(target.dataset.profileConcurrentLaunch ?? "")); profiles = await api.sv2ProfileState(); }); return; }
  if (target.dataset.profileConcurrentFolder) { void run(async () => { setFeedback(await api.openSv2ConcurrentFolder(target.dataset.profileConcurrentFolder ?? "")); }); return; }
  if (target.dataset.scripts !== undefined) {
    const input = document.querySelector<HTMLInputElement>("#scripts-path");
    if (input && target.dataset.scripts) input.value = target.dataset.scripts;
    return;
  }
  if (target.dataset.installComponent) { void run(async () => { setFeedback(await api.installComponent(target.dataset.installComponent ?? "")); await refresh(); }); return; }
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
