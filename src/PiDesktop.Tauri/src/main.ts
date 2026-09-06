import "./styles.css";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { registerModelAuthElement } from "@model-auth/vue/custom-element";
import { mountModelAuthDialog, type ModelAuthAction } from "./modelAuthDialog";
import { api } from "./api";
import { evaluateAccountEnvironment } from "./accountStatus";
import { instanceAccount, instanceProjectTitle } from "./sv2Instances";
import { findVoiceMetadata } from "./voiceCatalog";
import { icon } from "./icons";
import { featureCatalog, toolGroups, type FeatureCatalogItem, type ToolGroup } from "./featureCatalog";
import { mountShell, type ShellController } from "./vue/shell";
import { locale, setLocale, t } from "./i18n";
import "./i18nAccounts";
import type {
  AiProviderId,
  AgentWorkMode,
  AgentFileApproval,
  AiProviderSummary,
  AiLoadStrategy,
  AppMode,
  AudioCaptureCapability,
  AudioCaptureTarget,
  AudioJobSnapshot,
  AudioPrepareRequest,
  AudioSampleFormat,
  AudioWritePlan,
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
  LoudnessNormalizeRequest,
  LoudnessReport,
  FfmpegRuntimeStatus,
  MediaProbe,
  MediaSourcePreview,
  MediaTaskSnapshot,
  McpServerConfig,
  HttpApiStatus,
  OperationResult,
  ProjectCheckpoint,
  ProjectBackupState,
  RhymeMatchMode,
  Sv2AccountProbe,
  Sv2AuthorizedVoiceProduct,
  Sv2CachedVoice,
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
  TuningProfile,
  WorkflowRecipe,
  WorkflowResult,
} from "./types";

registerModelAuthElement();

const root = document.querySelector<HTMLDivElement>("#app")!;
if (!root) throw new Error("Missing #app root");

type Page = "home" | "accounts" | "import" | "quality" | "lyrics" | "history" | "copilot" | "components" | "bridge" | "connections" | "settings";
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
let fileApprovals: AgentFileApproval[] = [];
let profiles: Sv2ProfilesState | undefined;
let activeWorkflow: Feature["id"] | undefined;
let workflowResult: WorkflowResult | undefined;
let mediaSourceInput = "";
let mediaSourcePreview: MediaSourcePreview | undefined;
let mediaTasks: MediaTaskSnapshot[] = [];
let tuningProfiles: TuningProfile[] = [];
let audioCaptureCapability: AudioCaptureCapability | undefined;
let audioCaptureTargets: AudioCaptureTarget[] = [];
let synthvProcesses: SynthVProcess[] = [];
let instanceRefreshInFlight = false;
let instanceRefreshGeneration = 0;
const instanceRefreshOptions = [0, 5000, 10000, 30000, 60000];
let instanceRefreshInterval = readInstanceRefreshInterval();
let instanceRefreshTimer: number | undefined;
let synthvShortcutProfile: SynthVShortcutProfile | undefined;
let httpApiStatus: HttpApiStatus = {
  enabled: false,
  agentEnabled: false,
  running: false,
  port: 17831,
  endpoint: null,
  agentEndpoint: null,
  lastError: null,
};
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
let projectBackupState: ProjectBackupState | undefined;
let historyRefreshTimer: number | undefined;
let historyRefreshGeneration = 0;
let historyLoadState: "idle" | "loading" | "ready" | "error" = "idle";
let historyLoadError = "";
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
let pendingInstanceTermination: SynthVProcess | undefined;
let pendingAccountIndicatorConsent: PendingAccountIndicatorConsent | undefined;
let removingComponentId: string | undefined;
let aiProviderPickerOpen = false;
let modelAuthDialog: ReturnType<typeof mountModelAuthDialog> | undefined;
let downloadPollTimer: number | undefined;
let mediaTaskPollTimer: number | undefined;
let toastDismissTimer: number | undefined;
let toastSignature = "";
let accountUsageRefreshInFlight: Promise<void> | undefined;
let accountUsageRefreshScope: string | undefined;
let accountUsageRefreshPageGeneration: number | undefined;
let accountPageGeneration = 0;
let cachedAccountProfiles: Sv2ProfilesState | undefined;
let aiCatalogRefreshInFlight: Promise<void> | undefined;
let lyricPersistTimer: number | undefined;
let sidebarCollapsed = (() => {
  try { return localStorage.getItem("pi.sidebar.collapsed") === "true"; }
  catch { return false; }
})();
let accountManagerOpen = false;
let accountManagerSection: AccountManagerSection = "global";
let managedProfileSlotId: string | undefined;
let sv2VoiceCatalog: Sv2CachedVoice[] | undefined;
let sv2VoiceCatalogLoading = false;
let shellController: ShellController | undefined;
let lastWiredMarkup = "";

// Keep navigation available while a cancellable FFmpeg job runs.
type AudioJobKind = "prepare" | "normalize";
type AudioPrepareForm = Required<Pick<AudioPrepareRequest, "inputPath" | "sampleFormat">> & Omit<AudioPrepareRequest, "inputPath" | "sampleFormat">;
type LoudnessNormalizeForm = Required<LoudnessNormalizeRequest>;

const audioApi = api;
let audioRuntime: FfmpegRuntimeStatus | undefined;
let audioProbe: MediaProbe | undefined;
let audioPrepareForm: AudioPrepareForm = { inputPath: "", sampleFormat: "s24" };
let audioNormalizeForm: LoudnessNormalizeForm = { inputPath: "", integratedLufs: -16, truePeakDbtp: -1.5, loudnessRange: 11 };
let audioLoudness: LoudnessReport | undefined;
let pendingAudioPlan: { kind: AudioJobKind; request: AudioPrepareForm | LoudnessNormalizeForm; plan: AudioWritePlan } | undefined;
let audioJob: AudioJobSnapshot | undefined;
let audioJobPollTimer: number | undefined;
let audioJobPollGeneration = 0;
let audioInputGeneration = 0;
let audioPlanRequestGeneration = 0;
let audioRuntimeRequestGeneration = 0;
let audioPlanRequestInFlight = false;
let audioStartInFlight = false;
let audioLoudnessAnalysisInFlight = false;
let audioLoudnessAnalysisGeneration = 0;
let audioArtifactActionInFlight = false;
let audioCancelInFlight = false;
let audioUiError = "";
let audioUiNotice = "";
let audioPreviewUrl = "";
let audioSourcePreviewUrl = "";

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

function pageMeta(target: Page): { title: string; subtitle: string } {
  return { title: t(`pages.${target}.0`), subtitle: t(`pages.${target}.1`) };
}

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

function optionalFinite(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : undefined;
}

function formatAudioNumber(value: number | undefined, suffix = ""): string {
  return value === undefined || !Number.isFinite(value) ? "未知" : `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${suffix}`;
}

function beginAudioArtifactAction(): boolean {
  if (audioArtifactActionInFlight) return false;
  audioUiError = "";
  audioArtifactActionInFlight = true;
  render();
  return true;
}

function finishAudioArtifactAction(): void {
  audioArtifactActionInFlight = false;
  render();
}

function isTerminalAudioJob(snapshot: AudioJobSnapshot | undefined): boolean {
  return ["completed", "failed", "cancelled"].includes(snapshot?.status ?? "");
}

function mergeAudioJobSnapshot(
  current: AudioJobSnapshot | undefined,
  incoming: AudioJobSnapshot,
): AudioJobSnapshot {
  // Once a terminal state has been observed for this job, an older in-flight
  // request must not move the UI back to queued/running/cancelling.
  if (current?.id === incoming.id && isTerminalAudioJob(current)) return current;
  return incoming;
}

function clearAudioJobPoll(): void {
  audioJobPollGeneration += 1;
  if (audioJobPollTimer !== undefined) {
    window.clearTimeout(audioJobPollTimer);
    audioJobPollTimer = undefined;
  }
}

function scheduleAudioJobPoll(jobId: string): void {
  clearAudioJobPoll();
  const generation = audioJobPollGeneration;
  const poll = async () => {
    if (generation !== audioJobPollGeneration || audioJob?.id !== jobId || isTerminalAudioJob(audioJob)) return;
    try {
      const snapshot = await audioApi.audioJobSnapshot(jobId);
      // Ignore a late result from an older job.  This prevents a completed
      // previous operation from overwriting the currently displayed state.
      if (generation !== audioJobPollGeneration || audioJob?.id !== jobId) return;
      const merged = mergeAudioJobSnapshot(audioJob, snapshot);
      audioJob = merged;
      if (isTerminalAudioJob(merged)) {
        clearAudioJobPoll();
        audioUiNotice = merged.status === "completed" ? "音频任务已完成。" : "音频任务已结束。";
      } else {
        audioJobPollTimer = window.setTimeout(() => { void poll(); }, 800);
      }
    } catch (reason) {
      if (generation !== audioJobPollGeneration || audioJob?.id !== jobId) return;
      audioUiError = formatError(reason);
      audioJobPollTimer = window.setTimeout(() => { void poll(); }, 1000);
    }
    if (page === "import" && activeWorkflow === "audio-preparation") render();
  };
  audioJobPollTimer = window.setTimeout(() => { void poll(); }, 800);
}

function refreshAudioRuntimeStatus(): void {
  const generation = ++audioRuntimeRequestGeneration;
  void audioApi.ffmpegStatus().then((status) => {
    if (generation !== audioRuntimeRequestGeneration) return;
    audioRuntime = status;
    if (page === "import" && activeWorkflow === "audio-preparation") render();
  }).catch((reason) => {
    if (generation !== audioRuntimeRequestGeneration) return;
    audioRuntime = { available: false, detail: formatError(reason) };
    if (page === "import" && activeWorkflow === "audio-preparation") render();
  });
}

function refreshAudioPreparationIfSelected(): void {
  if (page === "import" && activeWorkflow === "audio-preparation") refreshAudioRuntimeStatus();
}

function syncAudioPreparationFormsFromDom(): void {
  const rate = optionalFinite(document.querySelector<HTMLInputElement>("#audio-prep-rate")?.value ?? "");
  const channels = optionalFinite(document.querySelector<HTMLSelectElement>("#audio-prep-channels")?.value ?? "");
  const format = document.querySelector<HTMLSelectElement>("#audio-prep-format")?.value;
  const start = optionalFinite(document.querySelector<HTMLInputElement>("#audio-prep-start")?.value ?? "");
  const duration = optionalFinite(document.querySelector<HTMLInputElement>("#audio-prep-duration")?.value ?? "");
  audioPrepareForm = { ...audioPrepareForm, sampleRate: rate, channels, sampleFormat: (format ?? audioPrepareForm.sampleFormat) as AudioSampleFormat, startSeconds: start, durationSeconds: duration };
  const lufs = optionalFinite(document.querySelector<HTMLInputElement>("#audio-normalize-lufs")?.value ?? "");
  const peak = optionalFinite(document.querySelector<HTMLInputElement>("#audio-normalize-peak")?.value ?? "");
  const lra = optionalFinite(document.querySelector<HTMLInputElement>("#audio-normalize-lra")?.value ?? "");
  audioNormalizeForm = { ...audioNormalizeForm, integratedLufs: lufs ?? audioNormalizeForm.integratedLufs, truePeakDbtp: peak ?? audioNormalizeForm.truePeakDbtp, loudnessRange: lra ?? audioNormalizeForm.loudnessRange };
}

function requestAudioPlan(kind: AudioJobKind): void {
  const request = kind === "prepare"
    ? { ...audioPrepareForm }
    : { ...audioNormalizeForm };
  const inputPath = request.inputPath;
  const inputGeneration = audioInputGeneration;
  const planGeneration = ++audioPlanRequestGeneration;
  pendingAudioPlan = undefined;
  audioPlanRequestInFlight = true;
  audioUiError = "";
  audioUiNotice = "正在生成安全写入计划…";
  render();
  void (async () => {
    try {
      const plan = kind === "prepare"
        ? await audioApi.planAudioPrepare(request as AudioPrepareForm)
        : await audioApi.planLoudnessNormalize(request as LoudnessNormalizeForm);
      if (planGeneration !== audioPlanRequestGeneration || inputGeneration !== audioInputGeneration || audioPrepareForm.inputPath !== inputPath) return;
      audioPlanRequestInFlight = false;
      audioUiNotice = "";
      pendingAudioPlan = { kind, request, plan };
      render();
    } catch (reason) {
      if (planGeneration !== audioPlanRequestGeneration || inputGeneration !== audioInputGeneration || audioPrepareForm.inputPath !== inputPath) return;
      audioPlanRequestInFlight = false;
      audioUiNotice = "";
      audioUiError = formatError(reason);
      render();
    }
  })();
}

function startPlannedAudioJob(): void {
  const pending = pendingAudioPlan;
  if (!pending) return;
  audioPlanRequestGeneration += 1;
  audioPlanRequestInFlight = false;
  pendingAudioPlan = undefined;
  audioStartInFlight = true;
  audioJob = undefined;
  audioPreviewUrl = "";
  audioUiError = "";
  audioUiNotice = "正在建立受控音频任务…";
  // The one-use confirmation is now consumed locally.  Render immediately so
  // the modal disappears and input controls cannot be used while the backend
  // is installing the job record.
  render();
  void (async () => {
    try {
      audioJob = pending.kind === "prepare"
        ? await audioApi.startAudioPrepare(pending.request as AudioPrepareForm, pending.plan.token)
        : await audioApi.startLoudnessNormalize(pending.request as LoudnessNormalizeForm, pending.plan.token);
      if (!isTerminalAudioJob(audioJob)) {
        audioUiNotice = "音频任务已开始；可继续浏览其他页面。";
        scheduleAudioJobPoll(audioJob.id);
      }
      else audioUiNotice = audioJob.status === "completed" ? "音频任务已完成。" : "音频任务已结束。";
    } catch (reason) {
      audioUiNotice = "";
      audioUiError = formatError(reason);
    } finally {
      audioStartInFlight = false;
      render();
    }
  })();
}

function selectAudioPreparationInput(path: string): void {
  const trimmed = path.trim();
  if (!trimmed) return;
  if (audioPlanRequestInFlight || pendingAudioPlan) {
    audioUiError = "请先完成或取消当前写入确认，再更换输入文件。";
    render();
    return;
  }
  if (audioStartInFlight || (audioJob && !isTerminalAudioJob(audioJob))) {
    audioUiError = "当前有一个音频写入任务正在运行；完成或取消后才能更换输入。";
    render();
    return;
  }
  if (audioLoudnessAnalysisInFlight) {
    audioUiError = "正在检查当前文件响度；完成后才能更换输入文件。";
    render();
    return;
  }
  const generation = ++audioInputGeneration;
  audioPlanRequestGeneration += 1;
  audioPlanRequestInFlight = false;
  pendingAudioPlan = undefined;
  clearAudioJobPoll();
  audioJob = undefined;
  audioPrepareForm = { ...audioPrepareForm, inputPath: trimmed };
  audioNormalizeForm = { ...audioNormalizeForm, inputPath: trimmed };
  audioProbe = undefined;
  audioLoudness = undefined;
  audioPreviewUrl = "";
  audioSourcePreviewUrl = "";
  audioUiError = "";
  audioUiNotice = "正在读取媒体信息…";
  void (async () => {
    try {
      const probe = await audioApi.probeMedia(trimmed);
      if (generation !== audioInputGeneration || audioPrepareForm.inputPath !== trimmed) return;
      audioProbe = probe;
      audioUiNotice = "媒体信息已读取。";
    } catch (reason) {
      if (generation !== audioInputGeneration || audioPrepareForm.inputPath !== trimmed) return;
      audioUiError = formatError(reason);
      audioUiNotice = "";
    }
    render();
  })();
  render();
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
  instanceRefreshGeneration += 1;
  if (page === "accounts") accountPageGeneration += 1;
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
  [lyricProjects, synthvProcesses, synthvShortcutProfile, mediaTasks, tuningProfiles, httpApiStatus] = await Promise.all([
    api.listLyricProjects(),
    api.listSynthvProcesses(),
    api.synthvShortcutProfile(),
    api.mediaTasks(),
    api.listTuningProfiles(),
    api.getHttpApiStatus(),
  ]);
}

async function refreshAccountUsage(slotId?: string, pageGeneration = accountPageGeneration): Promise<void> {
  if (!app?.sv2AccountIndicatorEnabled) return;
  if (page !== "accounts" || pageGeneration !== accountPageGeneration) return;
  const scope = slotId ?? "all";
  if (accountUsageRefreshInFlight) {
    if (accountUsageRefreshScope === scope && accountUsageRefreshPageGeneration === pageGeneration) return accountUsageRefreshInFlight;
    const inFlight = accountUsageRefreshInFlight;
    try {
      await inFlight;
    } catch {
      // A queued refresh must still run after an older page's request fails.
    }
    if (accountUsageRefreshInFlight === inFlight) {
      accountUsageRefreshInFlight = undefined;
      accountUsageRefreshScope = undefined;
      accountUsageRefreshPageGeneration = undefined;
    }
    return refreshAccountUsage(slotId, pageGeneration);
  }
  const request = (async () => {
    try {
      const snapshot = slotId
        ? await api.sv2AccountUsageSnapshotForSlot(slotId)
        : await api.sv2AccountUsageSnapshot();
      if (page === "accounts" && pageGeneration === accountPageGeneration) profiles = snapshot.profiles;
    } finally {
      if (page === "accounts" && pageGeneration === accountPageGeneration) render();
    }
  })();
  accountUsageRefreshInFlight = request;
  accountUsageRefreshScope = scope;
  accountUsageRefreshPageGeneration = pageGeneration;
  try {
    await request;
  } finally {
    if (accountUsageRefreshInFlight === request) {
      accountUsageRefreshInFlight = undefined;
      accountUsageRefreshScope = undefined;
      accountUsageRefreshPageGeneration = undefined;
    }
  }
}

function refreshAccountPageInBackground(pageGeneration: number): void {
  const request = supportsWindowsSv2Extensions() && app?.sv2AccountIndicatorEnabled
    ? refreshAccountUsage(undefined, pageGeneration)
    : api.sv2ProfileState().then((snapshot) => {
      if (page === "accounts" && pageGeneration === accountPageGeneration) {
        profiles = snapshot;
        render();
      }
    });
  void request.catch((reason) => {
    if (page === "accounts" && pageGeneration === accountPageGeneration) {
      error = formatError(reason);
      render();
    }
  });
}

function loadCachedAccountPage(pageGeneration: number): void {
  if (profiles) {
    refreshAccountPageInBackground(pageGeneration);
    return;
  }
  const previousProfiles = profiles;
  void api.sv2CachedProfileState()
    .then((snapshot) => {
      if (page === "accounts" && pageGeneration === accountPageGeneration && profiles === previousProfiles) {
        cachedAccountProfiles = snapshot;
        profiles = snapshot;
        render();
      }
    })
    .catch(() => undefined)
    .finally(() => {
      if (page === "accounts" && pageGeneration === accountPageGeneration) refreshAccountPageInBackground(pageGeneration);
    });
}

function readInstanceRefreshInterval(): number {
  try {
    const saved = localStorage.getItem("pi.synthv.instanceRefreshMs");
    if (saved !== null && instanceRefreshOptions.includes(Number(saved))) return Number(saved);
  } catch { /* preference remains in memory */ }
  return 5000;
}

function setInstanceRefreshInterval(interval: number): void {
  if (!instanceRefreshOptions.includes(interval)) return;
  instanceRefreshInterval = interval;
  instanceRefreshGeneration += 1;
  if (instanceRefreshTimer !== undefined) window.clearInterval(instanceRefreshTimer);
  instanceRefreshTimer = interval > 0
    ? window.setInterval(() => { void refreshVisibleSynthvInstances(); }, interval)
    : undefined;
  try { localStorage.setItem("pi.synthv.instanceRefreshMs", String(interval)); } catch { /* preference remains in memory */ }
}

async function refreshVisibleSynthvInstances(): Promise<void> {
  if (busy || document.hidden || instanceRefreshInFlight || (page !== "accounts" && page !== "bridge")) return;
  const refreshPage = page;
  const generation = instanceRefreshGeneration;
  instanceRefreshInFlight = true;
  try {
    const [nextProcesses, nextProfiles] = await Promise.all([
      api.listSynthvProcesses(),
      page === "accounts" ? api.sv2ProfileState() : Promise.resolve(profiles),
    ]);
    if (busy || page !== refreshPage || generation !== instanceRefreshGeneration) return;
    const previousRows = refreshPage === "accounts" ? renderSv2InstanceRows() : renderBridgeProcessRows();
    synthvProcesses = nextProcesses;
    if (nextProfiles) {
      profiles = nextProfiles;
      refreshAuthorizedVoiceEntries();
    }
    const nextRows = refreshPage === "accounts" ? renderSv2InstanceRows() : renderBridgeProcessRows();
    if (previousRows !== nextRows) {
      const list = document.querySelector<HTMLElement>(refreshPage === "accounts"
        ? ".account-instances-panel .synthv-process-list" : ".bridge-instances-panel .synthv-process-list");
      if (list) {
        const expanded = [...list.querySelectorAll<HTMLDetailsElement>("details[open]")].map((item) => item.closest<HTMLElement>(".synthv-process-row")?.dataset.processId).filter(Boolean);
        list.innerHTML = nextRows;
        for (const processId of expanded) list.querySelector<HTMLElement>(`.synthv-process-row[data-process-id="${processId}"] details`)?.setAttribute("open", "");
      }
    }
  } catch {
    // Background discovery must not replace a visible action error.
  } finally {
    instanceRefreshInFlight = false;
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

function navItem(target: Page, label: string, glyph: Parameters<typeof icon>[0]): string {
  return `<button class="nav-item ${page === target ? "active" : ""}" data-page="${target}" title="${label}" aria-label="${label}" ${page === target ? 'aria-current="page"' : ""}>
    ${icon(glyph, 19)}<span>${label}</span>
  </button>`;
}

function renderSidebar(): string {
  if (!app) return "";
  return `<div class="brand" data-page="home" title="返回概览">
      <div class="brand-mark small"><img class="brand-logo" src="/assets/synthv-toolbox-logo.svg" alt="Synthesizer V Toolbox" /></div>
      <div><strong>Synthesizer V Toolbox</strong><span>Creative utility suite</span></div>
    </div>
    <nav class="nav" aria-label="主导航">
      <span class="nav-label">${t("nav.workspace")}</span>
      ${navItem("home", t("nav.home"), "home")}
      ${app.platform === "windows" || app.platform === "macos" || app.platform === "preview" ? navItem("accounts", t("nav.accounts"), "users") : ""}
      ${navItem("import", t("nav.import"), "pipeline")}
      ${navItem("quality", t("nav.quality"), "doctor")}
      ${navItem("lyrics", t("nav.lyrics"), "lyrics")}
      ${navItem("history", t("nav.history"), "history")}
      ${app.mode === "ai" ? navItem("copilot", t("nav.copilot"), "bot") : ""}
      <span class="nav-label">${t("nav.system")}</span>
      ${navItem("components", t("nav.components"), "boxes")}
      ${navItem("bridge", t("nav.bridge"), "bridge")}
      ${navItem("connections", t("nav.connections"), "server")}
    </nav>
    <div class="sidebar-footer">
      <span class="version">v${escapeHtml(app.appVersion)} · ${escapeHtml(app.platform)}</span>
      <button class="nav-item sidebar-toggle" data-toggle-sidebar title="${sidebarCollapsed ? t("nav.expand") : t("nav.collapse")}" aria-label="${sidebarCollapsed ? t("nav.expand") : t("nav.collapse")}" aria-expanded="${!sidebarCollapsed}">${icon("arrow", 18)}<span>${sidebarCollapsed ? t("nav.expand") : t("nav.collapse")}</span></button>
      ${navItem("settings", t("nav.settings"), "settings")}
    </div>`;
}

function render(): void {
  if (!app) return;
  if (app.settingsLoadError) {
    root.innerHTML = `<main class="fatal settings-recovery" role="alert">
      <div class="brand-mark"><img class="brand-logo" src="/assets/synthv-toolbox-logo.svg" alt="Synthesizer V Toolbox" /></div>
      <span class="eyebrow">设置恢复保护模式</span>
      <h1>配置需要修复，原文件尚未被覆盖</h1>
      <p>工具箱检测到设置文件无法安全读取，因此已停用所有设置写入。OAuth 凭据和账号映射不会被默认配置替换。</p>
      <pre>${escapeHtml(app.settingsLoadError)}</pre>
      <div class="settings-recovery-path"><strong>配置文件</strong><code>${escapeHtml(app.configPath)}</code></div>
      <p>请修复 JSON 与 <code>schemaVersion</code>，或从备份恢复此文件，然后重新启动 Synthesizer V Toolbox。</p>
    </main>`;
    return;
  }
  if (!app.onboardingCompleted) {
    renderOnboarding();
    wireForms();
    return;
  }
  if (app.mode !== "ai" && page === "copilot") page = "home";
  const meta = pageMeta(page);
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
  const overlayHtml = pendingInstanceTermination ? renderInstanceTerminationDialog() : pendingComponentRemovalId ? renderComponentRemovalDialog() : pendingProfileDeletionId ? renderProfileDeletionDialog() : pendingBlockedSwitchSlot ? renderBlockedSwitchDialog() : pendingConcurrentLaunchSlot ? renderConcurrentDisclaimer() : pendingSvpRoute ? renderSvpRouteDialog() : pendingAccountIndicatorConsent ? renderAccountIndicatorConsent() : accountManagerOpen && page === "accounts" ? renderAccountManager() : pendingAudioPlan ? renderAudioPlanDialog() : "";
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
  syncModelAuthDialog();
  scheduleDownloadPoll();
  scheduleMediaTaskPoll();
}

function renderAudioPlanDialog(): string {
  const pending = pendingAudioPlan;
  if (!pending) return "";
  const plan = pending.plan;
  const expiry = new Date(plan.expiresAt);
  const expiryText = Number.isNaN(expiry.getTime()) ? plan.expiresAt : expiry.toLocaleString("zh-CN");
  return `<div class="dialog-backdrop" role="presentation">
    <section class="fluent-dialog audio-plan-dialog" role="dialog" aria-modal="true" aria-labelledby="audio-plan-title">
      <span class="dialog-icon route">${icon("audio", 24)}</span>
      <div><span class="eyebrow">AUDIO WRITE CONFIRMATION</span><h2 id="audio-plan-title">确认${pending.kind === "prepare" ? "生成 PCM WAV" : "响度标准化"}</h2></div>
      <p>工具箱将只按以下已审核计划写入一个新文件。源文件不会修改，确认令牌只能使用一次。</p>
      <dl class="audio-plan-details"><div><dt>输入</dt><dd><code>${escapeHtml(plan.inputPath)}</code></dd></div><div><dt>输出</dt><dd><code>${escapeHtml(plan.outputPath)}</code></dd></div><div><dt>全部参数</dt><dd>${plan.parameters.length ? plan.parameters.map(escapeHtml).join(" · ") : "默认参数"}</dd></div><div><dt>令牌有效至</dt><dd>${escapeHtml(expiryText)}</dd></div></dl>
      ${plan.warnings.length ? `<div class="audio-plan-warnings" role="status"><strong>注意</strong><ul>${plan.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>` : ""}
      <div class="dialog-actions"><button class="secondary" data-cancel-audio-plan>取消</button><button class="primary" data-confirm-audio-plan>${icon("check", 16)} 确认并开始</button></div>
    </section>
  </div>`;
}

function renderConcurrentDisclaimer(): string {
  const slot = profiles?.slots.find((item) => item.id === pendingConcurrentLaunchSlot);
  return `<div class="dialog-backdrop" role="presentation">
    <section class="fluent-dialog" role="alertdialog" aria-modal="true" aria-labelledby="concurrent-warning-title">
      <span class="dialog-icon">${icon("boxes", 24)}</span>
      <div><span class="eyebrow">${t("accounts.concurrentTitle")}</span><h2 id="concurrent-warning-title">${t("accounts.concurrentTitle")}</h2></div>
      <p>${t("accountUi.concurrentLaunchDescription", { name: escapeHtml(slot?.displayName ?? t("accountUi.thisSlot")) })}</p>
      <p class="dialog-choice-note">${t("accountUi.toolboxDoesNotModifySvBypassAccountRestrictionsOr")}</p>
      <div class="dialog-actions"><button class="secondary" data-cancel-concurrent>${t("accounts.cancel")}</button><button class="primary" data-accept-concurrent>${t("accounts.concurrentContinue")}</button></div>
    </section>
  </div>`;
}

function renderAccountIndicatorConsent(): string {
  return `<div class="dialog-backdrop" role="presentation">
    <section class="fluent-dialog account-indicator-consent" role="alertdialog" aria-modal="true" aria-labelledby="account-indicator-consent-title">
      <span class="dialog-icon route">${icon("shield", 24)}</span>
      <div><span class="eyebrow">${t("accountUi.signInIndicator")}</span><h2 id="account-indicator-consent-title">${t("accounts.consentTitle")}</h2></div>
      <p>${t("accounts.consentDescription")}</p>
      <ul>
        <li>${t("accountUi.theCheckReadsOfficialAuthorizationsIfTheSessionHas")}</li>
        <li>${t("accountUi.accountSettingsShowTheOfficialNameAndEmailAs")}</li>
      </ul>
      <p class="dialog-choice-note">${t("accountUi.toolboxWillNotLaunchTheClientModifySvOr")}</p>
      <div class="dialog-actions"><button class="secondary" data-cancel-account-indicator>${t("accounts.cancel")}</button><button class="primary" data-confirm-account-indicator>${icon("check", 16)} ${t("accounts.consentConfirm")}</button></div>
    </section>
  </div>`;
}

function renderInstanceTerminationDialog(): string {
  const process = pendingInstanceTermination;
  if (!process) return "";
  return `<div class="dialog-backdrop" role="presentation"><section class="fluent-dialog" role="alertdialog" aria-modal="true" aria-labelledby="terminate-instance-title"><h2 id="terminate-instance-title">终止这个实例？</h2><p>${escapeHtml(instanceProjectTitle(process.windowTitle))} · PID ${process.processId}</p><p>未保存的工程修改会丢失。请确认已保存；其他实例会继续运行。</p><div class="dialog-actions"><button class="secondary" data-cancel-instance-termination>取消</button><button class="danger-action" data-confirm-instance-termination>终止实例</button></div></section></div>`;
}

function renderProfileDeletionDialog(): string {
  const slot = profiles?.slots.find((item) => item.id === pendingProfileDeletionId);
  if (!slot) return "";
  const hasReplacement = profiles!.slots.some((item) => item.id !== slot.id);
  const defaultNote = slot.isActive
    ? hasReplacement
      ? t("accountUi.thisIsTheDefaultAccountAnotherAccountWillBecome")
      : t("accountUi.thisIsTheLastAccountDesktopShortcutsAndSvp")
    : t("accountUi.thisDoesNotAffectTheCurrentDefaultAccount");
  return `<div class="dialog-backdrop" role="presentation">
    <section class="fluent-dialog component-removal-dialog" role="alertdialog" aria-modal="true" aria-labelledby="profile-deletion-title">
      <span class="dialog-icon danger">${icon("trash", 24)}</span>
      <div><span class="eyebrow">${t("accounts.manager")}</span><h2 id="profile-deletion-title">${t("accounts.deleteTitle", { name: escapeHtml(slot.displayName) })}</h2></div>
      <p>${t("accounts.deleteDescription")}</p>
      <p class="dialog-choice-note">${defaultNote}</p>
      <div class="dialog-actions"><button class="secondary" data-cancel-profile-deletion>${t("accounts.cancel")}</button><button class="danger-action" data-confirm-profile-deletion>${icon("trash", 16)} ${t("accounts.deleteConfirm")}</button></div>
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
      <p>此操作会删除 Synthesizer V Toolbox 管理的本地运行环境与对应配置。依赖此组件的工作流在重新安装前将不可用。</p>
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
        <div><span class="eyebrow">${t("accountUi.runningProgramsDetected")}</span><h2 id="blocked-switch-title">${t("accountUi.blockedSwitchTitle", { name: escapeHtml(slot?.displayName ?? t("accountUi.thisSlot")) })}</h2></div>
        <p>${t("accountUi.saveYourWorkAndExitTheProgramsBelowThen")}</p>
        <div class="dialog-process-list">${blockers.map((blocker) => `<div><span><strong>${escapeHtml(blocker.name)}</strong><small>${escapeHtml(blocker.reason)}</small></span><code>${blocker.pid ? `PID ${blocker.pid}` : t("accountUi.pidUnavailable")}</code></div>`).join("")}</div>
        <div class="dialog-actions"><button class="primary" data-cancel-profile-switch>${t("accountUi.gotIt")}</button></div>
      </section>
    </div>`;
  }
  const provider = profiles?.concurrentProvider;
  const concurrentRunning = Boolean(slot?.concurrent.runningPids.length);
  const canRunConcurrent = Boolean(provider?.available);
  const concurrentLabel = slot?.concurrent.ready ? t("accountUi.runConcurrently") : t("accountUi.prepareAConcurrentCopyAndRun");
  return `<div class="dialog-backdrop" role="presentation">
    <section class="fluent-dialog switch-dialog" role="alertdialog" aria-modal="true" aria-labelledby="blocked-switch-title">
      <span class="dialog-icon danger">${icon("plug", 24)}</span>
      <div><span class="eyebrow">${t("accountUi.runningProgramsDetected")}</span><h2 id="blocked-switch-title">${t("accountUi.blockedSwitchTitle", { name: escapeHtml(slot?.displayName ?? t("accountUi.thisSlot")) })}</h2></div>
      <p>${t("accountUi.theseProgramsAreUsingTheCurrentSvSlotSave")}</p>
      <div class="dialog-process-list">${blockers.map((blocker) => `<div><span><strong>${escapeHtml(blocker.name)}</strong><small>${escapeHtml(blocker.reason)}</small></span><code>${blocker.pid ? `PID ${blocker.pid}` : t("accountUi.pidUnavailable")}</code></div>`).join("")}</div>
      <p class="dialog-choice-note">${canRunConcurrent ? t("accountUi.isReady", { p0: escapeHtml(provider?.name ?? "Sandboxie"), p1: slot?.concurrent.ready ? t("accountUi.theIsolatedInstanceWillLaunchDirectly") : t("accountUi.theIsolatedEnvironmentWillBePreparedBeforeLaunchingThe") }) : concurrentRunning ? t("accountUi.aConcurrentInstanceOfThisSlotIsAlreadyRunning") : t("accountUi.concurrentModeUnavailable", { p0: escapeHtml(provider?.detail ?? t("accountUi.noIsolationProviderDetected")) })}</p>
      <div class="dialog-actions"><button class="secondary" data-cancel-profile-switch>${t("accountUi.cancel")}</button><button class="secondary" data-run-blocked-concurrent ${canRunConcurrent ? "" : "disabled"}>${concurrentLabel}</button><button class="danger-action" data-force-profile-switch>${t("accountUi.forceSwitchAndLaunch")}</button></div>
    </section>
  </div>`;
}

function renderSvpRouteDialog(): string {
  if (!pendingSvpRoute) return "";
  const plan = pendingSvpRoute;
  const fileName = plan.projectPath.split(/[\\/]/).pop() || plan.projectPath;
  const requirements = plan.requiredVoices.length
    ? plan.requiredVoices.map((voice) => `<span title="${escapeHtml([voice.backendType, voice.version].filter(Boolean).join(" · "))}">${icon("audio", 14)} ${escapeHtml(voice.name)}${voice.version ? ` <small>v${voice.version}</small>` : ""}</span>`).join("")
    : `<span class="muted">${t("accountUi.noRecognizableVoiceRequirementsWereFoundInThisProject")}</span>`;
  const candidates = plan.candidates.map((candidate) => renderSvpRouteCandidate(candidate, plan)).join("");
  return `<div class="dialog-backdrop" role="presentation">
    <section class="fluent-dialog svp-route-dialog" role="dialog" aria-modal="true" aria-labelledby="svp-route-title">
      <span class="dialog-icon route">${icon("file", 24)}</span>
      <div><span class="eyebrow">${t("settings.smartRoute")}</span><h2 id="svp-route-title">${t("accountUi.chooseAnAccountToOpenTheProject")}</h2><p class="dialog-subtitle" title="${escapeHtml(plan.projectPath)}">${escapeHtml(fileName)}</p></div>
      <div class="svp-route-summary"><strong>${escapeHtml(plan.summary)}</strong><p>${escapeHtml(plan.detail)}</p></div>
      <div class="svp-route-requirements"><span>${t("accountUi.voicesRequiredByTheProject")}</span><div>${requirements}</div></div>
      ${plan.requiresConfirmation ? `<div class="route-confirmation-note">${icon("shield", 17)}<span><strong>${t("accountUi.yourConfirmationIsRequired")}</strong><small>${t("accountUi.toolboxWillNotSilentlyChooseAnAccountWhenAccount")}</small></span></div>` : ""}
      <div class="svp-route-candidates">${candidates || `<div class="empty-inline">${t("accountUi.noAccountsAreAvailableCloseRunningSvInstancesOr")}</div>`}</div>
      <div class="dialog-actions"><button class="secondary" data-cancel-svp-route>${t("accountUi.cancelOpening")}</button></div>
    </section>
  </div>`;
}

function renderSvpRouteCandidate(candidate: SvpRouteCandidate, plan: SvpRoutePlan): string {
  const selectable = candidate.idle && candidate.remoteUse !== "detected" && Boolean(candidate.launchMode);
  const selected = candidate.slotId === plan.selectedSlotId && candidate.launchMode === plan.selectedLaunchMode;
  const modeLabel = candidate.launchMode === "concurrent" ? t("accountUi.sandboxieConcurrent") : candidate.launchMode === "normal" ? t("accountUi.standardSwitch") : t("accountUi.cannotLaunch");
  const sessionLabel = candidate.remoteUse === "detected"
    ? t("accountUi.theAccountServiceReportsThisAccountIsInUse")
    : candidate.remoteUse === "clear" && candidate.sessionStatus === "ready"
      ? t("accountUi.theAccountServiceReportsNoRemoteUsage")
      : candidate.sessionStatus === "inUse"
        ? t("accountUi.cachedSessionIsInUseOnThisComputer")
        : t("accountUi.usageUnknown", { p0: accountProbeSessionLabel(candidate.sessionStatus) });
  const authorizationLabel = candidate.authorizationSource === "session" ? t("accountUi.officialAuthorization") : t("accountUi.authorizationUnknown");
  const matchLabel = candidate.exactAuthorizationMatch
    ? t("accountUi.matchesAllRequiredVoices", { p0: icon("check", 14), p1: authorizationLabel })
    : candidate.matchedVoices.length
      ? t("accountUi.matchedUnknown", { p0: authorizationLabel, p1: candidate.matchedVoices.length, p2: candidate.missingOrUnknownVoices.length })
      : t("accountUi.authorizationUnknownManualConfirmationRequired");
  const needsConfirmation = candidate.remoteUse === "unknown" || candidate.sessionStatus !== "ready" || !candidate.exactAuthorizationMatch;
  const actionLabel = plan.requiresConfirmation || needsConfirmation ? t("accountUi.confirmThisAccount") : t("accountUi.openWithThisAccount");
  return `<article class="svp-route-candidate ${selected ? "recommended" : ""} ${selectable ? "" : "disabled"}">
    <div class="route-candidate-heading"><span class="profile-avatar compact">${escapeHtml(Array.from(candidate.displayName)[0] ?? "S")}</span><div><strong>${escapeHtml(candidate.displayName)}</strong><small>${escapeHtml(modeLabel)} · ${escapeHtml(sessionLabel)}${selected ? t("accountUi.recommended") : ""}</small></div><span class="route-match ${candidate.exactAuthorizationMatch ? "exact" : "unknown"}">${matchLabel}</span></div>
    <p>${escapeHtml(candidate.reason)}</p>
    ${candidate.missingOrUnknownVoices.length ? `<div class="route-missing" title="${t("accountUi.unmatchedOrUnknown")}">${candidate.missingOrUnknownVoices.map((voice) => `<span>${escapeHtml(voice)}</span>`).join("")}</div>` : ""}
    <button class="${selected ? "primary" : "secondary"}" data-launch-svp-route="${escapeHtml(candidate.slotId)}" data-svp-route-mode="${escapeHtml(candidate.launchMode ?? "normal")}" ${selectable ? "" : "disabled"}>${candidate.launchMode === "concurrent" ? icon("boxes", 16) : icon("play", 16)} ${actionLabel}</button>
  </article>`;
}

function accountProbeSessionLabel(status: SvpRouteCandidate["sessionStatus"]): string {
  const labels: Record<SvpRouteCandidate["sessionStatus"], string> = {
    ready: t("accountUi.cachedSessionAvailable"),
    missing: t("accountUi.signInRequired"),
    inUse: t("accountUi.cachedSessionIsInUseOnThisComputer"),
    expired: t("accountUi.accessCredentialsExpiredAwaitingRenewal"),
    loginRequired: t("accountUi.accountSignInRequired"),
    invalid: t("accountUi.cachedSessionInvalid"),
    syncFailed: t("accountUi.sessionSynchronizationFailedRepairRequired"),
    accountMismatch: t("accountUi.accountCopiesDoNotMatch"),
    unsupported: t("accountUi.sessionFormatNotSupportedYet"),
    offline: t("accountUi.accountServiceOffline"),
  };
  return labels[status];
}

interface AccountProbeIssuePresentation {
  cardLabel: string;
  authorizationLabel: string;
  title: string;
  attention: boolean;
}

function accountProbeIssueRules(): Array<[
  Sv2AccountProbe["sessionStatus"],
  AccountProbeIssuePresentation,
]> {
  return [
    ["syncFailed", {
      cardLabel: t("accountUi.sessionSynchronizationFailedRepairRequired"),
      authorizationLabel: t("accountUi.sessionSynchronizationFailedSlotAuthorizationsWereNotRead"),
      title: t("accountUi.accountCredentialsOrDeviceIdentityCouldNotBeSafely"),
      attention: true,
    }],
    ["accountMismatch", {
      cardLabel: t("accountUi.accountCopiesDoNotMatch"),
      authorizationLabel: t("accountUi.accountIdentitiesDoNotMatchSlotAuthorizationsWereNot"),
      title: t("accountUi.theAccountIdentitiesReadFromThisSlotDoNot"),
      attention: true,
    }],
    ["inUse", {
      cardLabel: t("accountUi.accountInUseOnThisComputer"),
      authorizationLabel: t("accountUi.accountInUseAuthorizationsWereNotReadThisTime"),
      title: t("accountUi.theClientIsUsingThisSessionTheLastRedacted"),
      attention: false,
    }],
    ["loginRequired", {
      cardLabel: t("accountUi.accountNeedsToSignInAgain"),
      authorizationLabel: t("accountUi.noUsableSignInCredentialsAuthorizationsWereNotRead"),
      title: t("accountUi.signInToThisAccountInSynthvThenRefresh"),
      attention: true,
    }],
    ["expired", {
      cardLabel: t("accountUi.sessionExpiredAwaitingRenewal"),
      authorizationLabel: t("accountUi.refreshTheAccountToReadAuthorizationsAgain"),
      title: t("accountUi.refreshTheAccountStatusToolboxWillRenewTheSession"),
      attention: true,
    }],
    ["invalid", {
      cardLabel: t("accountUi.signInCacheInvalid"),
      authorizationLabel: t("accountUi.signInCacheInvalidAuthorizationsWereNotRead"),
      title: t("accountUi.theLocalSignInCacheCannotBeSafelyVerified"),
      attention: true,
    }],
    ["offline", {
      cardLabel: t("accountUi.accountServiceTemporarilyOffline"),
      authorizationLabel: t("accountUi.accountServiceTemporarilyOfflineAuthorizationsUnavailable"),
      title: t("accountUi.theLocalSessionWasReadButTheAccountService"),
      attention: false,
    }],
    ["unsupported", {
      cardLabel: t("accountUi.sessionFormatNotSupportedYet"),
      authorizationLabel: t("accountUi.sessionFormatUnsupportedAuthorizationsWereNotRead"),
      title: t("accountUi.thisVersionCannotSafelyParseTheSignInCache"),
      attention: false,
    }],
    ["missing", {
      cardLabel: t("accountUi.notSignedInYet"),
      authorizationLabel: t("accountUi.noSignInCacheAuthorizationsWereNotRead"),
      title: t("accountUi.noSignInCacheFoundSignInToSv"),
      attention: false,
    }],
  ];
}

function accountProbeIssue(probes: Sv2AccountProbe[]): AccountProbeIssuePresentation | undefined {
  for (const [status, presentation] of accountProbeIssueRules()) {
    if (probes.some((probe) => probe.sessionStatus === status)) return presentation;
  }
  return undefined;
}

interface AccountProbeEnvironmentState {
  label: string;
  probe: Sv2AccountProbe;
  launchEnabled: boolean;
  localBlocked: boolean;
  localBlockLabel: string;
  usable: boolean;
  busy: boolean;
}

function accountProbeEnvironments(slot: Sv2ProfileSlot): AccountProbeEnvironmentState[] {
  const normalRecovery = slot.sessionProtection.status === "recoveryPending";
  const normalProcessBlocked = !slot.isActive && Boolean(profiles?.blockers.length);
  const environments: AccountProbeEnvironmentState[] = [{
    label: t("accountUi.standard"),
    probe: slot.accountProbe,
    launchEnabled: true,
    localBlocked: normalRecovery || normalProcessBlocked,
    localBlockLabel: normalRecovery ? t("accountUi.signInCacheAwaitingRecovery") : normalProcessBlocked ? t("accountUi.closeStandardInstancesBeforeSwitchingTheAccountPath") : "",
    usable: false,
    busy: false,
  }];

  if (slot.concurrent.ready) {
    const concurrentRecovery = slot.concurrentSessionProtection.status === "recoveryPending";
    environments.push({
      label: t("accountUi.isolated"),
      probe: slot.concurrentAccountProbe,
      launchEnabled: Boolean(app?.sv2ConcurrentEnabled && profiles?.concurrentProvider.available),
      localBlocked: concurrentRecovery,
      localBlockLabel: concurrentRecovery ? t("accountUi.signInCacheAwaitingRecovery") : "",
      usable: false,
      busy: false,
    });
  }

  for (const environment of environments) {
    const availability = evaluateAccountEnvironment({
      launchEnabled: environment.launchEnabled,
      localBlocked: environment.localBlocked,
      sessionStatus: environment.probe.sessionStatus,
      remoteUse: environment.probe.remoteUse,
      authorizationStatus: environment.probe.authorizationStatus,
    });
    environment.usable = availability.available;
    environment.busy = availability.busy;
  }
  return environments;
}

function accountProbeEnvironmentSummary(environment: AccountProbeEnvironmentState): string {
  if (!environment.launchEnabled) return t("accountUi.cannotLaunchNowIsolationOrProviderUnavailable");
  if (environment.localBlocked) return environment.localBlockLabel;
  const probe = environment.probe;
  const session = probe.remoteUse === "detected"
    ? t("accountUi.inUseRemotely")
    : probe.sessionStatus === "inUse"
      ? t("accountUi.inUseLocally")
    : probe.sessionStatus === "ready" && probe.authorizationStatus === "verified"
        ? t("accountUi.readyToLaunch")
        : probe.sessionStatus === "ready" && probe.remoteUse === "unknown"
          ? t("accountUi.accountInformationNeedsRefresh")
          : accountProbeSessionLabel(probe.sessionStatus);
  const authorization = probe.authorizationStatus === "verified" ? t("accountUi.officialAuthorizationsConfirmed") : t("accountUi.officialAuthorizationsUnknown");
  return `${session}；${authorization}`;
}

function environmentDefinitelyUnavailable(environment: AccountProbeEnvironmentState): boolean {
  return !environment.usable && (
    environment.localBlocked
    || environment.probe.remoteUse === "detected"
    || environment.probe.authorizationStatus !== "verified"
    || ["expired", "loginRequired", "invalid", "syncFailed", "accountMismatch", "missing", "unsupported", "offline"].includes(environment.probe.sessionStatus)
  );
}

function accountProbeBadge(slot: Sv2ProfileSlot): string {
  if (profiles === cachedAccountProfiles) return `<span class="session-protection">${icon("refresh", 14)} ${t("accountUi.showingLocalCache")}</span>`;
  if (!app?.sv2AccountIndicatorEnabled) {
    return `<span class="session-protection" title="${t("accountUi.theSignInIndicatorIsOffThisSlotS")}">${icon("shield", 14)} ${t("accountUi.signInIndicatorOff")}</span>`;
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

  let label = t("accountUi.accountStatusUnconfirmed");
  let emphasis = "";
  let iconName: "refresh" | "check" | "plug" = "refresh";
  if (hasUsableEnvironment) {
    label = probes.some((probe) => probe.sessionStatus === "inUse") ? t("accountUi.accountAvailableInUseLocally") : t("accountUi.accountAvailable");
    iconName = "check";
  } else if (reportedIssue) {
    label = reportedIssue.cardLabel;
    emphasis = reportedIssue.attention ? " attention" : "";
  } else if (hasBusyEnvironment && allUnavailable) {
    label = t("accountUi.noIdleLaunchEnvironmentForThisAccount");
    emphasis = " attention";
    iconName = "plug";
  } else if (probes.some((probe) => probe.authorizationStatus === "verified")) {
    label = t("accountUi.authorizationsConfirmed");
    iconName = "check";
  } else if (notYetChecked) {
    label = t("accountUi.accountStatusNotCheckedYet");
  }

  const tooltip = [
    ...environments.map((environment) => `${environment.label}：${accountProbeEnvironmentSummary(environment)}`),
    slot.accountProbe.detail.trim(),
  ].filter(Boolean).join("；");
  return `<span class="session-protection${emphasis}" title="${escapeHtml(tooltip)}">${icon(iconName, 14)} ${escapeHtml(label)}</span>`;
}

function officialAuthorizationBadge(slot: Sv2ProfileSlot): string {
  if (profiles === cachedAccountProfiles) return "";
  const probes = slot.concurrent.ready
    ? [slot.accountProbe, slot.concurrentAccountProbe]
    : [slot.accountProbe];
  const verifiedCounts = probes
    .filter((probe) => probe.authorizationStatus === "verified")
    .map((probe) => probe.authorizedVoiceCount);
  const reportedIssue = verifiedCounts.length ? undefined : accountProbeIssue(probes);
  const unresolvedOfficial = reportedIssue
    ? { label: reportedIssue.authorizationLabel, title: reportedIssue.title }
    : { label: t("accountUi.officialAuthorizationsUncheckedOrUnknown"), title: t("accountUi.theAccountServiceHasNotReturnedAnyAuthorizationResults") };
  const official = !app?.sv2AccountIndicatorEnabled
    ? `<span class="voice-inventory unknown" title="${t("accountUi.theSignInIndicatorIsOffOfficialAuthorizationSummaries")}">${icon("shield", 13)} ${t("accountUi.officialAuthorizationChecksOff")}</span>`
    : reportedIssue
      ? `<span class="voice-inventory unknown" title="${escapeHtml(unresolvedOfficial.title)}">${icon("audio", 13)} ${escapeHtml(unresolvedOfficial.label)}</span>`
      : verifiedCounts.length
      ? `<span class="voice-inventory confirmed" title="${t("accountUi.theAccountServiceHasConfirmedVoiceAuthorizations")}">${icon("check", 13)} ${t("accountUi.officialAuthorizationCount", { count: Math.max(...verifiedCounts) })}</span>`
      : `<span class="voice-inventory unknown" title="${escapeHtml(unresolvedOfficial.title)}">${icon("audio", 13)} ${escapeHtml(unresolvedOfficial.label)}</span>`;
  return official;
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

type AccountUseTone = "clear" | "unknown" | "in-use";

function accountUseStateForSlot(slot: Sv2ProfileSlot): { tone: AccountUseTone; label: string } {
  if (profiles === cachedAccountProfiles) return { tone: "unknown", label: t("accountUi.accountStatusNeedsUpdating") };
  const environments = accountProbeEnvironments(slot).filter((environment) => environment.launchEnabled);
  const allLocallyBlocked = environments.length > 0 && environments.every((environment) => environment.localBlocked);
  if (!app?.sv2AccountIndicatorEnabled) {
    return allLocallyBlocked
      ? { tone: "in-use", label: t("accountUi.allLaunchEnvironmentsAreCurrentlyOccupiedLocally") }
      : { tone: "unknown", label: t("accountUi.accountSignInIndicatorOff") };
  }

  const probes = environments.map((environment) => environment.probe);
  const reportedIssue = accountProbeIssue(probes.filter((probe) => probe.sessionStatus !== "missing"))
    ?? (probes.length > 0 && probes.every((probe) => probe.sessionStatus === "missing")
      ? accountProbeIssue(probes)
      : undefined);
  const hasBusyEnvironment = environments.some((environment) => environment.busy);
  if (environments.some((environment) => environment.usable)) {
    return { tone: "clear", label: probes.some((probe) => probe.sessionStatus === "inUse") ? t("accountUi.accountAvailableInUseLocally") : t("accountUi.accountAvailable") };
  }

  if (reportedIssue) {
    return {
      tone: reportedIssue.attention ? "in-use" : "unknown",
      label: reportedIssue.cardLabel,
    };
  }

  const allUnavailable = environments.length > 0 && environments.every(environmentDefinitelyUnavailable);
  if (hasBusyEnvironment && allUnavailable) {
    return { tone: "in-use", label: t("accountUi.allLaunchEnvironmentsAreCurrentlyUnavailable") };
  }
  return { tone: "unknown", label: t("accountUi.accountServiceUsageStatusUnknown") };
}

function accountUseDot(state: { tone: AccountUseTone; label: string }): string {
  return `<span class="account-use-dot ${state.tone}" role="img" aria-label="${escapeHtml(state.label)}" title="${escapeHtml(state.label)}"></span>`;
}

async function launchConcurrentSlot(slotId: string, prepare: boolean): Promise<void> {
  if (prepare) profiles = await api.prepareSv2ConcurrentProfile(slotId);
  setFeedback(await api.launchSv2ConcurrentProfile(slotId));
  profiles = await api.sv2ProfileState();
}

async function launchSv2ProfileAfterLiveCheck(slotId: string): Promise<void> {
  const currentProfiles = await api.sv2ProfileState();
  profiles = currentProfiles;
  if (currentProfiles.activeSlotId !== slotId && currentProfiles.blockers.length) {
    pendingBlockedSwitchSlot = slotId;
    return;
  }
  setFeedback(await api.launchSv2Profile(slotId));
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
      <div class="onboarding-brand"><div class="brand-mark"><img class="brand-logo" src="/assets/synthv-toolbox-logo.svg" alt="Synthesizer V Toolbox" /></div><span>Synthesizer V Toolbox</span></div>
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
    case "import": return renderToolCategory("import");
    case "quality": return renderToolCategory("quality");
    case "lyrics": return renderLyricsPage();
    case "history": return renderHistoryPage();
    case "copilot": return renderCopilot();
    case "components": return renderComponents();
    case "bridge": return renderBridge();
    case "connections": return renderMcp();
    case "settings": return renderSettings();
  }
}

function renderAccounts(): string {
  if (!profiles) {
    return "";
  }
  if (!profiles.supported) {
    return `<section class="panel quiet-panel"><span class="mode-icon slate">${icon("users", 24)}</span><div><h2>${t("accounts.unsupported")}</h2><p>${escapeHtml(profiles.recoveryDetail)}</p></div></section>`;
  }
  const windowsExtensions = supportsWindowsSv2Extensions();
  const blockerCount = profiles.blockers.length;
  const blockerPanel = profiles.blockers.length ? `<div class="warning-card profile-blockers"><span>${icon("plug", 23)}</span><div><strong>${t("accounts.blocked")}</strong><p>${windowsExtensions ? t("accountUi.closeTheseProcessesBeforeSwitchingTheStandardAccountPath") : t("accountUi.saveYourWorkAndCloseTheseProcessesBeforeSwitching")}<br />${profiles.blockers.map((blocker) => `${escapeHtml(blocker.name)}${blocker.pid ? ` (PID ${blocker.pid})` : ""}：${escapeHtml(blocker.reason)}`).join("<br />")}</p></div></div>` : "";
  if (profiles.recoveryRequired) {
    return `${blockerPanel}<div class="warning-card recovery-card"><span>${icon("sync", 23)}</span><div><strong>${t("accounts.recovery")}</strong><p>${escapeHtml(profiles.recoveryDetail)}</p><p>${t("accountUi.toolboxHasNotDeletedOrOverwrittenAnyDirectoriesBack")}</p></div><button class="secondary" data-profile-refresh>${icon("sync", 16)} ${t("accounts.recheck")}</button></div>
      <section class="panel"><dl class="detail-list"><div><dt>${t("accounts.officialPath")}</dt><dd><code>${escapeHtml(profiles.canonicalPath)}</code></dd></div><div><dt>${t("accounts.vault")}</dt><dd><code>${escapeHtml(profiles.vaultPath)}</code></dd></div></dl></section>`;
  }
  const concurrentProviderAvailable = windowsExtensions && profiles.concurrentProvider.available;
  const providerDetail = profiles.concurrentProvider.detail;
  const cards = profiles.slots.map((slot) => {
    const lastUsed = slot.lastActivatedAtUtc ? new Date(slot.lastActivatedAtUtc).toLocaleString(locale()) : t("accounts.neverLaunched");
    const officialIdentity = windowsExtensions ? officialAccountIdentity(slot) : {};
    const accountTitle = officialIdentity.name ?? (slot.sessionCached ? t("accounts.pending") : t("accounts.signedOut"));
    const initial = Array.from(officialIdentity.name ?? "?")[0] ?? "?";
    const color = /^#[0-9a-f]{6}$/i.test(slot.color) ? slot.color : "#6D5CE7";
    const accountEmail = officialIdentity.email
      ? `<span class="profile-identity">${escapeHtml(officialIdentity.email)}</span>`
      : `<span class="profile-identity empty">${t("accounts.pending")}</span>`;
    const note = slot.displayName.trim()
      ? `<span class="profile-note">${t("accounts.note", { name: escapeHtml(slot.displayName) })}</span>`
      : `<span class="profile-note empty">${t("accounts.noNote")}</span>`;
    const useState = windowsExtensions
      ? accountUseStateForSlot(slot)
      : blockerCount
        ? { tone: "in-use" as const, label: t("accountUi.theCurrentSvEnvironmentIsInUseLocally") }
        : { tone: "unknown" as const, label: t("accountUi.localDataSlotManagementOnly") };
    const concurrentRunning = windowsExtensions && slot.concurrent.runningPids.length > 0;
    const isolatedLabel = concurrentRunning ? t("accountUi.openAnotherInstance") : slot.concurrent.ready ? t("accountUi.launchIsolated") : t("accountUi.prepareIsolation");
    const concurrentEnabled = windowsExtensions && Boolean(app?.sv2ConcurrentEnabled);
    const isolatedDisabled = !concurrentProviderAvailable || !concurrentEnabled;
    const isolatedTitle = concurrentRunning
      ? t("accountUi.anIsolatedInstanceIsAlreadyRunningMoreInstancesOf")
      : !concurrentEnabled
        ? t("accountUi.isolationIsTurnedOffInGlobalSettings")
        : providerDetail;
    const localVoiceFact = `<span class="voice-inventory unknown" title="${t("accountUi.macosVDoesNotReadOrDecryptSignIn")}">${icon("shield", 13)} ${t("accountUi.accountAuthorizationsNotRead")}</span>`;
    const windowsLaunchActions = concurrentEnabled && slot.concurrent.ready
      ? `<button class="primary" data-profile-concurrent-launch="${slot.id}" ${isolatedDisabled ? `disabled title="${escapeHtml(isolatedTitle)}"` : ""}>${icon("boxes", 16)} ${isolatedLabel}</button><button class="secondary" data-profile-launch="${slot.id}">${icon("play", 16)} ${slot.isActive ? t("accountUi.launchNormally") : t("accountUi.switchAndLaunch")}</button>`
      : `<button class="primary" data-profile-launch="${slot.id}">${icon("play", 16)} ${slot.isActive ? t("accountUi.launchNormally") : t("accountUi.switchAndLaunch")}</button><button class="secondary" data-profile-concurrent-prepare="${slot.id}" ${isolatedDisabled ? `disabled title="${escapeHtml(isolatedTitle)}"` : ""}>${icon("download", 16)} ${isolatedLabel}</button>`;
    const launchActions = windowsExtensions
      ? windowsLaunchActions
      : `<button class="primary" data-profile-launch="${slot.id}">${icon("play", 16)} ${slot.isActive ? t("accountUi.launchNormally") : t("accountUi.switchAndLaunch")}</button>`;
    return `<article class="account-launch-card ${slot.isActive ? "active" : ""}" style="--profile-color:${color}">
      <div class="account-card-main"><span class="profile-avatar compact">${escapeHtml(initial)}</span><div class="account-card-identity"><div class="profile-title-line"><h2>${escapeHtml(accountTitle)}</h2>${accountUseDot(useState)}${slot.isActive ? `<span class="profile-active-badge">${t("accounts.default")}</span>` : ""}</div>${accountEmail}${note}</div><div class="account-card-actions">${windowsExtensions ? `<button class="icon-plain" data-profile-refresh-slot="${slot.id}" title="${t("accounts.refresh")}" aria-label="${t("accounts.refresh")}">${icon("refresh", 18)}</button>` : ""}<button class="icon-plain" data-manage-slot="${slot.id}" title="${t("accounts.configure")}" aria-label="${t("accounts.configure")}">${icon("settings", 18)}</button><button class="icon-plain danger" data-delete-profile="${slot.id}" title="${t("accounts.delete")}" aria-label="${t("accounts.delete")}">${icon("trash", 18)}</button><button class="icon-plain" data-profile-activate="${slot.id}" title="${t("accounts.switchDefault")}" aria-label="${t("accounts.switchDefault")}" ${slot.isActive ? "disabled" : ""}>${icon("check", 18)}</button></div></div>
      <div class="account-card-facts">${windowsExtensions ? `${accountProbeBadge(slot)}${officialAuthorizationBadge(slot)}` : localVoiceFact}<span>${icon("sync", 13)} ${escapeHtml(lastUsed)}</span>${concurrentRunning ? `<span class="running">${icon("plug", 13)} ${t("accountUi.isolatedProcessCount", { count: slot.concurrent.runningPids.length })}</span>` : ""}</div>
      <div class="account-launch-actions">${launchActions}</div>
    </article>`;
  }).join("");
  const instanceList = renderSv2InstanceList();
  return `${blockerPanel}<div class="account-launch-grid">${cards || `<button class="empty-account-card" data-account-manager="add">${icon("plus", 22)}<strong>${t("accounts.addFirst")}</strong><span>${t("accounts.addFirstDescription")}</span></button>`}</div>${instanceList}`;
}

function renderSv2InstanceList(): string {
  return `<section class="panel account-instances-panel"><div class="panel-heading"><h2>SynthV 实例</h2>${renderInstanceRefreshControls()}</div><div class="synthv-process-list">${renderSv2InstanceRows()}</div></section>`;
}

function renderInstanceRefreshControls(): string {
  const options = instanceRefreshOptions.map((interval) => `<option value="${interval}"${interval === instanceRefreshInterval ? " selected" : ""}>${interval ? `每 ${interval / 1000} 秒` : "关闭"}</option>`).join("");
  return `<div class="instance-refresh-controls"><label>自动刷新<select data-instance-refresh-interval aria-label="实例自动刷新频率">${options}</select></label><button class="secondary compact" data-refresh-synthv-processes aria-label="刷新 SynthV 实例" title="刷新 SynthV 实例">${icon("refresh", 16)} 刷新</button></div>`;
}

function renderSv2InstanceRows(): string {
  const instances = synthvProcesses.map((process) => {
    const { slot, mode } = instanceAccount(process, profiles);
    const title = instanceProjectTitle(process.windowTitle);
    const product = [process.productName || process.name, process.version].filter(Boolean).join(" ");
    const identity = process.processIdentity || "";
    const disabled = !identity || busy ? " disabled" : "";
    return `<article class="synthv-process-row account-instance-row" data-process-id="${process.processId}"><div class="instance-heading"><strong>${escapeHtml(`${product} · ${slot?.displayName ?? "未关联账号"} · ${title}`)}</strong></div><div class="button-row"><button class="secondary compact" data-focus-sv2="${process.processId}" data-process-identity="${escapeHtml(identity)}"${disabled}>切换到</button><button class="danger compact" data-terminate-sv2="${process.processId}" data-process-identity="${escapeHtml(identity)}"${disabled}>终止</button></div><details><summary>详情</summary><small>PID ${process.processId} · ${escapeHtml(mode)}</small><code>${escapeHtml(process.command)}</code></details></article>`;
  }).join("");
  return instances || '<div class="empty-inline compact-empty">当前没有检测到 SynthV 实例。</div>';
}

function supportsWindowsSv2Extensions(): boolean {
  return app?.platform === "windows" || app?.platform === "preview";
}

function renderAuthorizedVoice(voice: string, products: Sv2AuthorizedVoiceProduct[] = [], slotId = ""): string {
  const productIds = products.map((product) => product.id).filter(Boolean);
  const installedIds = new Set((profiles?.slots.find((slot) => slot.id === slotId)?.installedVoiceIds ?? []).map((id) => id.toLowerCase()));
  const installed = productIds.some((id) => installedIds.has(id.toLowerCase()));
  const installedBadge = installed ? `<span class="voice-installed-badge" role="img" aria-label="${t("accountUi.installed")}" title="${t("accountUi.installedForThisAccount")}">${icon("check", 10)}</span>` : "";
  const catalogEntry = findVoiceMetadata(voice, productIds, sv2VoiceCatalog ?? []);
  const cover = catalogEntry?.imageDataUrl
    ? `<img class="voice-cover" src="${escapeHtml(catalogEntry.imageDataUrl)}" alt="" />`
    : `<span class="voice-cover placeholder">${icon("audio", 14)}</span>`;
  const vendor = catalogEntry?.vendor ? `<small>${escapeHtml(catalogEntry.vendor)}</small>` : "";
  const isTrial = products.length > 0 && products.every((product) => product.isTrial);
  const expirations = products.map((product) => product.expiresAtUtc ? Date.parse(product.expiresAtUtc) : NaN);
  const expiresAt = expirations.length > 0 && expirations.every(Number.isFinite) ? Math.max(...expirations) : undefined;
  const expired = expiresAt !== undefined && expiresAt <= Date.now();
  const label = isTrial ? (expired ? t("accountUi.trialExpired") : t("accountUi.timeLimitedTrial")) : expiresAt !== undefined ? (expired ? t("accountUi.authorizationExpired") : t("accountUi.timeLimitedAuthorization")) : "";
  const badge = label ? `<span class="voice-trial-badge">${label}</span>` : "";
  const expiry = expiresAt !== undefined ? `<small class="voice-license-expiry">${t("accountUi.expiresAt", { date: escapeHtml(new Date(expiresAt).toLocaleString(locale())) })}</small>` : "";
  return `<span class="authorized-voice" data-authorized-voice="${escapeHtml(voice)}" data-authorized-products="${escapeHtml(JSON.stringify(products))}" data-voice-slot-id="${escapeHtml(slotId)}"><span class="voice-cover-container">${cover}${installedBadge}</span><span><span class="voice-name">${escapeHtml(voice)}${badge}</span>${vendor}${expiry}</span></span>`;
}

function refreshAuthorizedVoiceEntries(): void {
  document.querySelectorAll<HTMLElement>("[data-authorized-voice]").forEach((entry) => {
    const updated = renderAuthorizedVoice(entry.dataset.authorizedVoice ?? "", JSON.parse(entry.dataset.authorizedProducts ?? "[]") as Sv2AuthorizedVoiceProduct[], entry.dataset.voiceSlotId);
    if (entry.outerHTML !== updated) entry.outerHTML = updated;
  });
}

function loadSv2VoiceCatalog(force = false): void {
  if (sv2VoiceCatalogLoading || (!force && sv2VoiceCatalog)) return;
  sv2VoiceCatalogLoading = true;
  void api.sv2VoiceCatalog()
    .then((catalog) => { sv2VoiceCatalog = catalog; })
    .catch(() => undefined)
    .finally(() => {
      sv2VoiceCatalogLoading = false;
      refreshAuthorizedVoiceEntries();
    });
}

function renderAccountManager(): string {
  if (!profiles) return "";
  const managedSlot = profiles.slots.find((slot) => slot.id === managedProfileSlotId)
    ?? profiles.slots.find((slot) => slot.isActive)
    ?? profiles.slots[0];
  if (managedSlot) managedProfileSlotId = managedSlot.id;
  let body = "";
  if (accountManagerSection === "profile" && !supportsWindowsSv2Extensions()) {
    body = managedSlot ? `<div class="account-manager-pane"><div class="manager-pane-heading"><div><h3>${managedSlot.sessionCached ? t("accountUi.accountInformationNeedsRefresh") : t("accountUi.signedOut")}</h3></div>${managedSlot.isActive ? `<span class="profile-active-badge">${t("accountUi.currentDefault")}</span>` : ""}</div>
      <form class="profile-rename compact-form" data-profile-rename-form="${managedSlot.id}"><label>${t("accounts.managerNote")}<input value="${escapeHtml(managedSlot.displayName)}" maxlength="64" placeholder="${t("accounts.notePlaceholder")}" /></label><button class="secondary">${t("accounts.saveNote")}</button></form>
      <div class="manager-action-row">${managedSlot.isActive ? "" : `<button class="secondary" data-profile-activate="${managedSlot.id}">${icon("check", 15)} ${t("accounts.setDefault")}</button>`}<button class="secondary" data-profile-folder="${managedSlot.id}">${icon("folder", 15)} ${t("accounts.openData")}</button><button class="secondary component-remove-action" data-delete-profile="${managedSlot.id}">${icon("trash", 15)} ${t("accounts.delete")}</button></div>
      <dl class="profile-storage-list compact"><div><dt>${t("accounts.data")}</dt><dd><code title="${escapeHtml(managedSlot.dataPath)}">${escapeHtml(managedSlot.dataPath)}</code></dd></div></dl></div>` : `<div class="empty-inline">${t("accounts.noAccounts")}</div>`;
  } else if (accountManagerSection === "profile") {
    const authorizationProbe = managedSlot?.accountProbe.authorizationStatus === "verified"
      ? managedSlot.accountProbe
      : managedSlot?.concurrentAccountProbe.authorizationStatus === "verified"
        ? managedSlot.concurrentAccountProbe
        : undefined;
    const authorizations = authorizationProbe?.authorizedVoices ?? [];
    const authorizationStatus = authorizationProbe?.authorizationStatus === "verified";
    const officialIdentity = managedSlot ? officialAccountIdentity(managedSlot) : {};
    const managedUseState = managedSlot ? accountUseStateForSlot(managedSlot) : { tone: "unknown" as const, label: t("accountUi.accountInformationNeedsRefresh") };
    const authorizationUnavailable = t("accountUi.authorizationsUncheckedOrUnknown");
    const authorizationSummary = authorizationStatus
      ? t("accountUi.theAccountServiceHasConfirmedVoiceAuthorizationsDetail", { p0: authorizations.length })
      : authorizationUnavailable;
    const authorizationList = authorizationStatus
      ? authorizations.length
        ? `<div class="authorization-list">${authorizations.map((voice) => renderAuthorizedVoice(voice, authorizationProbe?.authorizedVoiceProducts.filter((product) => product.name === voice) ?? [], managedSlot?.id)).join("")}</div>`
        : `<div class="empty-inline">${t("accountUi.thisAccountHasNoAvailableVoiceAuthorizations")}</div>`
      : `<div class="empty-inline">${escapeHtml(authorizationUnavailable)}</div>`;
    body = managedSlot ? `<div class="account-manager-pane"><div class="manager-pane-heading"><div><h3>${escapeHtml(officialIdentity.name ?? (managedSlot.sessionCached ? t("accountUi.accountInformationNeedsRefresh") : t("accountUi.signedOut")))}</h3><p>${escapeHtml(officialIdentity.email ?? t("accountUi.accountInformationNeedsRefresh"))}</p><p>${accountUseDot(managedUseState)} ${escapeHtml(managedUseState.label)}</p></div>${managedSlot.isActive ? `<span class="profile-active-badge">${t("accountUi.currentDefault")}</span>` : ""}</div>
      <form class="profile-rename compact-form" data-profile-rename-form="${managedSlot.id}"><label>${t("accountUi.note")}<input value="${escapeHtml(managedSlot.displayName)}" maxlength="64" placeholder="${t("accountUi.eGProductionAccount")}" /></label><button class="secondary">${t("accountUi.saveNote")}</button></form>
      <section class="authorization-panel"><div class="authorization-heading"><div><strong>${t("accountUi.availableAuthorizations")}</strong><small>${escapeHtml(authorizationSummary)}</small></div><span class="inventory-status ${authorizationStatus ? "verified" : "unknown"}">${authorizationStatus ? t("accountUi.authorizationsDetail", { p0: authorizations.length }) : t("accountUi.notRead")}</span></div>${authorizationList}</section>
      <div class="manager-action-row">${managedSlot.isActive ? "" : `<button class="secondary" data-profile-activate="${managedSlot.id}">${icon("check", 15)} ${t("accountUi.makeDefault")}</button>`}<button class="secondary" data-profile-folder="${managedSlot.id}">${icon("folder", 15)} ${t("accountUi.openAccountDataFolder")}</button><button class="secondary component-remove-action" data-delete-profile="${managedSlot.id}">${icon("trash", 15)} ${t("accountUi.deleteAccount")}</button></div>
      <dl class="profile-storage-list compact"><div><dt>${t("accountUi.accountData")}</dt><dd><code title="${escapeHtml(managedSlot.dataPath)}">${escapeHtml(managedSlot.dataPath)}</code></dd></div></dl></div>` : `<div class="empty-inline">${t("accountUi.noAccountsYetAddASlotFirst")}</div>`;
  } else if (accountManagerSection === "global" && !supportsWindowsSv2Extensions()) {
    body = `<section class="panel quiet-panel"><span class="mode-icon slate">${icon("shield", 24)}</span><div><h3>${t("accountUi.macosSlotScope")}</h3><p>${t("accountUi.thisVersionSupportsSequentialDataSlotSwitchingOnlySign")}</p></div></section>`;
  } else if (accountManagerSection === "global") {
    body = `<form id="sv2-global-settings-form" class="isolation-defaults-form manager-defaults"><div><strong>${t("accountUi.globalSettings")}</strong><small>${t("accountUi.onlyAllowlistedFilesSuchAsSettingsAndScriptsAre")}</small></div><label class="fluent-switch"><input name="accountProbeEnabled" type="checkbox" ${app?.sv2AccountIndicatorEnabled ? "checked" : ""} /><span></span>${t("accountUi.enableAccountSignInIndicator")}</label><label class="fluent-switch"><input name="concurrentEnabled" type="checkbox" ${app?.sv2ConcurrentEnabled ? "checked" : ""} /><span></span>${t("accountUi.enableIsolation")}</label><button class="secondary" type="submit">${t("accountUi.saveGlobalSettings")}</button></form>`;
  } else {
    body = `<div class="account-add-grid">${profiles.canImportCurrent ? `<section><span class="feature-icon emerald">${icon("folder", 20)}</span><h3>${t("accountUi.importCurrentEnvironment")}</h3><p>${t("accountUi.bringTheExistingOfficialDataDirectoryIntoASlot")}</p><form id="profile-import-form" class="profile-create-form"><input id="profile-import-name" maxlength="64" placeholder="${t("accountUi.noteOptional")}" /><button class="primary">${t("accountUi.import")}</button></form></section>` : ""}<section><span class="feature-icon blue">${icon("plus", 20)}</span><h3>${t("accountUi.createEmptySlot")}</h3><p>${t("accountUi.completeSignInOnTheOfficialSvPageAfter")}</p><form id="profile-create-form" class="profile-create-form"><input id="profile-create-name" maxlength="64" placeholder="${t("accountUi.noteOptional")}" /><button class="secondary">${t("accountUi.create")}</button></form></section></div><div class="manager-safety">${icon("check", 17)}<span><strong>${t("accountUi.accountDataStaysUnchanged")}</strong><small>${t("accountUi.toolboxDoesNotFabricateSignInOrBypassOnline")}</small></span></div>`;
  }
  const tabs = "";
  return `<div class="dialog-backdrop account-manager-backdrop" role="presentation"><section class="account-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="account-manager-title"><header><div><span class="eyebrow">${t("accounts.manager")}</span><h2 id="account-manager-title">${accountManagerSection === "profile" ? t("accounts.profile") : t("accounts.manager")}</h2></div><button class="icon-plain" data-close-account-manager title="${t("accounts.close")}" aria-label="${t("accounts.close")}">×</button></header>${tabs}<div class="account-manager-body">${body}</div></section></div>`;
}

function renderHome(): string {
  if (!app) return "";
  const current = app;
  const ready = app.components.filter((component) => component.installed).length;
  return `<div class="hero-panel">
      <div><span class="eyebrow">${app.mode === "ai" ? "AI workspace" : "Local utility workspace"}</span>
        <h2>${app.mode === "ai" ? "把重复操作交给 Copilot，创作判断留给你。" : "所有核心工具，集中在一个安静的工作区。"}</h2>
        <p>${app.mode === "ai" ? "从音频分析到 SynthV 工程操作，AI 只通过你启用的能力和 MCP 工具工作。" : "无需模型配置即可进行确定性的音频、MIDI、工程和 Bridge 操作。"}</p>
        <div class="hero-actions"><button class="primary" data-page="${app.mode === "ai" ? "copilot" : "import"}">${icon(app.mode === "ai" ? "bot" : "pipeline", 18)} ${app.mode === "ai" ? "打开 Copilot" : "打开导入与转换"}</button><button class="secondary" data-page="bridge">检查 Bridge</button></div>
      </div>
      <div class="hero-orb"><div><img class="brand-logo" src="/assets/synthv-toolbox-logo.svg" alt="Synthesizer V Toolbox" /></div><span>${app.mode === "ai" ? "COPILOT READY" : "LOCAL FIRST"}</span></div>
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

function stopHistoryRefresh(): void {
  historyRefreshGeneration += 1;
  if (historyRefreshTimer !== undefined) {
    window.clearTimeout(historyRefreshTimer);
    historyRefreshTimer = undefined;
  }
}

function scheduleHistoryRefresh(): void {
  stopHistoryRefresh();
  historyLoadState = "loading";
  historyLoadError = "";
  render();
  const generation = historyRefreshGeneration;
  const refresh = async () => {
    if (generation !== historyRefreshGeneration || page !== "history") return;
    try {
      const [backup, workflow, checkpoints] = await Promise.all([api.projectBackupState(), api.listCreativeHistory(), api.listProjectCheckpoints()]);
      if (generation !== historyRefreshGeneration || page !== "history") return;
      projectBackupState = backup;
      creativeHistory = workflow;
      projectCheckpoints = checkpoints;
      historyLoadState = "ready";
      historyLoadError = "";
      render();
    } catch (reason) {
      if (generation !== historyRefreshGeneration || page !== "history") return;
      historyLoadState = "error";
      historyLoadError = formatError(reason);
      render();
    }
    if (generation === historyRefreshGeneration && page === "history") historyRefreshTimer = window.setTimeout(() => void refresh(), 5000);
  };
  void refresh();
}

function formatHistoryTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "等待首次备份";
}

function renderHistoryPage(): string {
  const history = creativeHistory.length
    ? creativeHistory.map((item) => `<article class="timeline-item"><span class="status-dot online"></span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.summary)}</small><code>${escapeHtml(new Date(item.createdAtUtc).toLocaleString("zh-CN"))}${item.outputPath ? ` · ${escapeHtml(item.outputPath)}` : ""}</code></div></article>`).join("")
    : '<div class="empty-inline">还没有工作流记录；完成一次工具操作后会自动出现在这里。</div>';
  const checkpoints = projectCheckpoints.length
    ? projectCheckpoints.map((item) => `<article class="checkpoint-item"><span class="feature-icon blue">${icon("shield", 17)}</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.sourcePath)}</small><code>SHA-256 ${escapeHtml(item.sourceSha256.slice(0, 16))}… · ${new Date(item.createdAtUtc).toLocaleString("zh-CN")}</code></div><button class="secondary compact" data-restore-checkpoint="${escapeHtml(item.id)}">恢复副本</button></article>`).join("")
    : '<div class="empty-inline">还没有工程检查点。</div>';
  const backup = projectBackupState;
  const itemError = backup?.projects.some((item) => item.lastError) ?? false;
  const backupStatus = historyLoadState === "error" ? "读取失败" : historyLoadState === "loading" ? "正在读取" : backup?.lastError || itemError ? "需要处理" : backup ? "自动跟踪中" : "等待读取";
  const tracked = backup?.projects.length ? backup.projects.map((item) => `<article class="checkpoint-item"><span class="feature-icon blue">${icon("history", 17)}</span><div><strong>${escapeHtml(item.sourcePath)}</strong><small>最近发现：${escapeHtml(formatHistoryTime(item.lastSeenAtUtc))} · 备份 ${item.backupCount} 次</small><code>${item.lastError ? `失败：${escapeHtml(item.lastError)}` : `上次备份：${escapeHtml(formatHistoryTime(item.lastBackupAtUtc))}`}</code></div></article>`).join("") : '<div class="empty-inline">尚未追踪到 .svp 工程。打开并保存工程后，后台会自动开始检测。</div>';
  const loadError = historyLoadState === "error" ? `<div class="audio-inline-error" role="alert">历史状态读取失败：${escapeHtml(historyLoadError)}</div>` : "";
  return `<section class="panel history-intro"><span class="feature-icon blue">${icon("history", 22)}</span><div><span class="eyebrow">AUTOMATIC HISTORY</span><h2>工程历史自动保存</h2><p>每分钟检测已追踪的 .svp 工程变化，应用运行或托盘驻留时持续工作。未保存内容需要先由 SynthV 正常保存。</p></div><span class="availability ${historyLoadState === "ready" && !backup?.lastError && !itemError ? "ready" : "warning"}">${backupStatus}</span></section>${loadError}
    <section class="panel history-checkpoint-grid"><div class="section-heading"><div><h2>自动备份状态</h2><p>检测间隔：${backup?.intervalSeconds ?? 60} 秒${backup?.lastError ? ` · ${escapeHtml(backup.lastError)}` : ""}</p></div></div><div class="checkpoint-list">${tracked}</div></section>
    <section class="panel"><div class="section-heading"><div><h2>已有快照</h2><p>可恢复快照会生成新的工程副本。</p></div></div><div class="checkpoint-list">${checkpoints}</div></section>
    <section class="panel workflow-history"><div class="section-heading"><div><h2>工作流记录</h2><p>按时间保留工具输入摘要、执行结果和输出位置。</p></div></div><div class="timeline-list">${history}</div></section>`;
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

function renderToolCategory(groupId: ToolGroup["id"]): string {
  if (!app) return "";
  const current = app;
  const group = toolGroups.find((item) => item.id === groupId);
  if (!group) return "";
  const groupFeatureList = groupFeatures(group);
  const selected = activeWorkflow && group.featureIds.includes(activeWorkflow)
    ? groupFeatureList.find((feature) => feature.id === activeWorkflow)
    : groupFeatureList.find((feature) => featureAvailability(feature, current).tone === "ready") ?? groupFeatureList[0];
  const tabs = groupFeatureList.map((feature) => {
    const availability = featureAvailability(feature, current);
    return `<button class="tool-tab ${selected?.id === feature.id ? "active" : ""} ${availability.tone}" data-feature="${escapeHtml(feature.id)}" ${selected?.id === feature.id ? 'aria-current="page"' : ""}><span>${escapeHtml(feature.title)}</span><small>${escapeHtml(availability.label)}</small></button>`;
  }).join("");
  const selectedAvailability = selected ? featureAvailability(selected, current) : undefined;
  const blocked = selected && selectedAvailability?.tone !== "ready" ? `<section class="panel tool-unavailable"><span class="feature-icon orange">${icon(selected.icon, 22)}</span><div><h2>${escapeHtml(selected.title)}</h2><p>${escapeHtml(selected.description)}</p><p>${escapeHtml(selectedAvailability?.label ?? "当前工具不可用")}。请处理依赖后再开始。</p></div>${selectedAvailability?.route ? `<button class="secondary" data-page="${selectedAvailability.route}">${escapeHtml(selectedAvailability.actionLabel)} ${icon("arrow", 16)}</button>` : ""}</section>` : selected ? renderWorkflowPanel(selected.id) : '<div class="empty-inline">当前分类没有可用工具。</div>';
  return `<section class="tool-category"><nav class="tool-tabs" aria-label="${escapeHtml(group.title)}中的工具">${tabs}</nav>${blocked}</section>`;
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
  if (id === "audio-preparation") {
    const runtime = audioRuntime;
    const running = audioStartInFlight || Boolean(audioJob && !isTerminalAudioJob(audioJob));
    const controlsLocked = running || audioPlanRequestInFlight || audioLoudnessAnalysisInFlight;
    const probe = audioProbe;
    const probeCard = probe
      ? `<section class="audio-probe-card" aria-label="媒体信息"><div class="audio-probe-heading"><div><span class="eyebrow">MEDIA PROBE</span><strong>${escapeHtml(probe.codec ?? "未知编码")}</strong></div><span class="availability ready">已读取</span></div><dl class="audio-metadata"><div><dt>容器</dt><dd>${escapeHtml(probe.container ?? "未知")}</dd></div><div><dt>时长</dt><dd>${formatAudioNumber(probe.durationSeconds, " 秒")}</dd></div><div><dt>采样率</dt><dd>${formatAudioNumber(probe.sampleRate, " Hz")}</dd></div><div><dt>声道</dt><dd>${formatAudioNumber(probe.channels)}${probe.channelLayout ? ` · ${escapeHtml(probe.channelLayout)}` : ""}</dd></div><div><dt>位深</dt><dd>${formatAudioNumber(probe.bitDepth, " bit")}</dd></div><div><dt>码率</dt><dd>${formatAudioNumber(probe.bitRate ? probe.bitRate / 1000 : undefined, " kb/s")}</dd></div></dl>${probe.sourceArtifactId && probe.sourceMimeType ? `<div class="audio-source-preview">${audioSourcePreviewUrl ? `<audio controls preload="metadata" src="${escapeHtml(audioSourcePreviewUrl)}" data-audio-preview-artifact="${escapeHtml(probe.sourceArtifactId)}" data-audio-preview-kind="source" data-audio-preview-generation="${audioInputGeneration}" aria-label="原音试听"></audio>` : `<button class="secondary" data-preview-audio-artifact="${escapeHtml(probe.sourceArtifactId)}" data-audio-preview-kind="source" ${audioArtifactActionInFlight ? "disabled" : ""}>${icon("play", 16)} 试听原音</button>`}</div>` : ""}</section>`
      : `<div class="audio-empty-probe" role="status">选择一个本地音频后，将显示容器、编码、时长、采样率、声道、位深与码率。</div>`;
    const loudness = audioLoudness
      ? `<div class="audio-loudness-readout" role="status"><strong>EBU R128 结果</strong><span>综合响度 ${formatAudioNumber(audioLoudness.integratedLufs, " LUFS")}</span><span>True Peak ${formatAudioNumber(audioLoudness.truePeakDbtp, " dBTP")}</span><span>LRA ${formatAudioNumber(audioLoudness.loudnessRange, " LU")}</span></div>`
      : "";
    const jobPanel = audioJob
      ? `<section class="audio-job-card ${audioJob.status}" aria-live="polite"><div class="audio-job-heading"><div><span class="eyebrow">AUDIO TASK</span><strong>${audioJob.operation === "loudness-normalize" ? "响度标准化" : "PCM WAV 转码"}</strong></div><span class="availability ${audioJob.status === "completed" ? "ready" : audioJob.status === "failed" ? "warning" : ""}">${escapeHtml(audioJob.status)}</span></div>${audioJob.progressPercent !== undefined ? `<div class="audio-progress" role="progressbar" aria-label="音频处理进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(audioJob.progressPercent)}"><span style="width:${Math.max(0, Math.min(100, audioJob.progressPercent))}%"></span></div><small>${formatAudioNumber(audioJob.progressPercent, "%")}</small>` : `<small>${running ? "正在处理；可继续浏览其他页面。" : "任务已结束。"}</small>`}${audioJob.outputPath ? `<div class="audio-output-path"><span>结果路径</span><code>${escapeHtml(audioJob.outputPath)}</code></div>` : ""}${audioJob.error ? `<pre class="audio-job-error">${escapeHtml(audioJob.error)}</pre>` : ""}${audioJob.loudnessReport ? `<div class="audio-loudness-readout compact"><span>复测 ${formatAudioNumber(audioJob.loudnessReport.integratedLufs, " LUFS")}</span><span>峰值 ${formatAudioNumber(audioJob.loudnessReport.truePeakDbtp, " dBTP")}</span><span>LRA ${formatAudioNumber(audioJob.loudnessReport.loudnessRange, " LU")}</span></div>` : ""}${running ? `<div class="button-row"><button class="secondary" data-cancel-audio-job="${escapeHtml(audioJob.id)}" ${audioCancelInFlight ? "disabled" : ""}>${audioCancelInFlight ? "正在取消…" : "取消任务"}</button></div>` : audioJob.status === "completed" && audioJob.artifactId ? `<div class="audio-artifact-actions">${audioPreviewUrl ? `<audio controls preload="metadata" src="${escapeHtml(audioPreviewUrl)}" data-audio-preview-artifact="${escapeHtml(audioJob.artifactId)}" data-audio-preview-kind="result" data-audio-preview-generation="${audioInputGeneration}" aria-label="结果试听"></audio>` : `<button class="secondary" data-preview-audio-artifact="${escapeHtml(audioJob.artifactId)}" ${audioArtifactActionInFlight ? "disabled" : ""}>${icon("play", 16)} 试听结果</button>`}<button class="secondary" data-reveal-audio-artifact="${escapeHtml(audioJob.artifactId)}" ${audioArtifactActionInFlight ? "disabled" : ""}>打开文件位置</button><button class="secondary" data-copy-audio-artifact="${escapeHtml(audioJob.artifactId)}" ${audioArtifactActionInFlight ? "disabled" : ""}>复制路径</button><button class="primary" data-save-audio-artifact="${escapeHtml(audioJob.artifactId)}" ${audioArtifactActionInFlight ? "disabled" : ""}>安全另存为</button></div>` : ""}</section>`
      : "";
    form = `<div class="audio-preparation" aria-label="音频准备">
      <section class="audio-runtime-card ${runtime?.available ? "ready" : "warning"}"><div><span class="eyebrow">FFMPEG RUNTIME</span><strong>${runtime === undefined ? "正在检查…" : runtime.available ? `可用${runtime.version ? ` · ${escapeHtml(runtime.version)}` : ""}` : "未找到 FFmpeg"}</strong><small>${escapeHtml(runtime?.detail ?? "进入此工具后检查本机 FFmpeg。")}${runtime !== undefined && !runtime.available ? " 请在组件中心安装或修复 FFmpeg 后重试。" : ""}</small></div><span class="availability ${runtime?.available ? "ready" : "warning"}">${escapeHtml(runtime?.source ?? (runtime === undefined ? "检查中" : runtime.available ? "已就绪" : "需要组件"))}</span></section>
      <section class="audio-input-card"><div class="section-heading"><div><h3>选择单个音频</h3><p>支持点击选择或拖放一个本地文件；不会自动导入 SynthV、运行 CVRS 或批处理。</p></div><button type="button" class="secondary" data-pick-audio-file ${controlsLocked ? "disabled" : ""}>选择文件</button></div><label class="visually-hidden" for="audio-prep-input">音频文件路径</label><input id="audio-prep-input" value="${escapeHtml(audioPrepareForm.inputPath)}" readonly placeholder="尚未选择文件" aria-describedby="audio-drop-help" /><button type="button" class="audio-drop-zone" data-audio-drop-zone aria-label="拖放一个音频文件或选择文件" aria-describedby="audio-drop-help" ${controlsLocked ? "disabled" : ""}><span>${icon("audio", 22)}</span><strong>把一个音频文件拖到这里</strong><small id="audio-drop-help">一次只接受一个文件。拖放后先进行只读媒体探测。</small></button></section>
      ${probeCard}
      <div class="audio-action-grid"><section class="audio-action-card"><div><span class="eyebrow">SYNTHV PCM WAV</span><h3>为 SynthV 准备 PCM WAV</h3><p>默认保持原采样率和声道，输出 24-bit PCM WAV。</p></div><form id="audio-prepare-form" class="workflow-form"><div class="workflow-pair three"><label>采样率（Hz）<input id="audio-prep-rate" type="number" min="8000" max="192000" step="1" value="${audioPrepareForm.sampleRate ?? ""}" placeholder="保持不变" ${controlsLocked ? "disabled" : ""}/></label><label>声道数<select id="audio-prep-channels" ${controlsLocked ? "disabled" : ""}><option value="">保持不变</option><option value="1" ${audioPrepareForm.channels === 1 ? "selected" : ""}>单声道</option><option value="2" ${audioPrepareForm.channels === 2 ? "selected" : ""}>立体声</option></select></label><label>位深<select id="audio-prep-format" ${controlsLocked ? "disabled" : ""}><option value="s16" ${audioPrepareForm.sampleFormat === "s16" ? "selected" : ""}>16-bit PCM</option><option value="s24" ${audioPrepareForm.sampleFormat === "s24" ? "selected" : ""}>24-bit PCM</option><option value="f32" ${audioPrepareForm.sampleFormat === "f32" ? "selected" : ""}>32-bit float</option></select></label></div><div class="workflow-pair"><label>起始位置（秒）<input id="audio-prep-start" type="number" min="0" step="0.01" value="${audioPrepareForm.startSeconds ?? ""}" placeholder="从头开始" ${controlsLocked ? "disabled" : ""}/></label><label>时长（秒）<input id="audio-prep-duration" type="number" min="0.01" step="0.01" value="${audioPrepareForm.durationSeconds ?? ""}" placeholder="直到结尾" ${controlsLocked ? "disabled" : ""}/></label></div><button class="primary" ${!audioPrepareForm.inputPath || !runtime?.available || controlsLocked ? "disabled" : ""}>${icon("audio", 16)} 查看写入计划</button></form></section>
      <section class="audio-action-card"><div><span class="eyebrow">EBU R128</span><h3>检查 / 平衡响度</h3><p>默认目标 −16 LUFS / −1.5 dBTP / 11 LRA，写入后会自动复测。</p></div><div class="button-row"><button class="secondary" data-analyze-audio-loudness ${!audioPrepareForm.inputPath || !runtime?.available || controlsLocked ? "disabled" : ""}>检查响度</button></div>${loudness}<form id="audio-normalize-form" class="workflow-form"><div class="workflow-pair three"><label>LUFS<input id="audio-normalize-lufs" type="number" min="-70" max="-5" step="0.1" required value="${audioNormalizeForm.integratedLufs}" ${controlsLocked ? "disabled" : ""}/></label><label>dBTP<input id="audio-normalize-peak" type="number" min="-9" max="0" step="0.1" required value="${audioNormalizeForm.truePeakDbtp}" ${controlsLocked ? "disabled" : ""}/></label><label>LRA<input id="audio-normalize-lra" type="number" min="1" max="20" step="0.1" required value="${audioNormalizeForm.loudnessRange}" ${controlsLocked ? "disabled" : ""}/></label></div><button class="primary" ${!audioPrepareForm.inputPath || !runtime?.available || controlsLocked ? "disabled" : ""}>${icon("shield", 16)} 查看标准化计划</button></form></section></div>
      ${audioUiNotice ? `<div class="audio-inline-notice" role="status">${escapeHtml(audioUiNotice)}</div>` : ""}${audioUiError ? `<div class="audio-inline-error" role="alert">${escapeHtml(audioUiError)}</div>` : ""}${jobPanel}
    </div>`;
  } else if (id === "cover") {
    const processOptions = [`<option value="">自动选择${synthvProcesses.length > 1 ? "（多实例时由 Agent 指定）" : ""}</option>`, ...synthvProcesses.map((process) => `<option value="${process.processId}">PID ${process.processId} · ${escapeHtml(process.name)}</option>`)].join("");
    const taskCards = mediaTasks.filter((item) => item.kind === "cover").slice(-5).reverse().map((task) => {
      const result = asObject(task.result) ?? {};
      const midi = asObject(result.midi) ?? {};
      const assignment = asObject(result.voiceAssignment) ?? {};
      const action = ["queued", "running", "cancelling"].includes(task.status)
        ? `<button class="secondary compact" data-cancel-media-task="${escapeHtml(task.id)}" ${task.status === "cancelling" ? "disabled" : ""}>${task.status === "cancelling" ? "终止中…" : "取消"}</button>`
        : ["failed", "cancelled"].includes(task.status)
          ? `<button class="secondary compact" data-retry-media-task="${escapeHtml(task.id)}">重试</button>`
          : "";
      const outputPath = typeof midi.outputPath === "string" ? midi.outputPath : "";
      const voiceBoundary = assignment.requiresHostSelection === true ? `<small>指定声库：${escapeHtml(String(result.requestedVoice ?? ""))} · 宿主 API 不可自动分配身份</small>` : "";
      const svpPath = typeof result.svpPath === "string" ? result.svpPath : "";
      const saveState = svpPath ? `<small>SVP：${escapeHtml(svpPath)} · ${result.saveVerified === true ? "已验证落盘" : "保存未验证"}</small>` : "";
      return `<article class="download-item ${task.status}"><span class="component-status ${task.status === "completed" ? "ready" : ""}">${icon(task.status === "failed" ? "plug" : "sparkles", 17)}</span><div><div class="download-title"><strong>一键 Cover</strong><span>${escapeHtml(task.status)}</span></div><div class="progress-track"><span style="width:${Math.max(2, Math.min(100, task.progress))}%"></span></div><small>${escapeHtml(task.error || task.detail)}</small>${outputPath ? `<small>MIDI：${escapeHtml(outputPath)}</small>` : ""}${saveState}${voiceBoundary}</div>${action}</article>`;
    }).join("");
    const taskList = taskCards ? `<section class="download-queue"><div class="section-heading"><div><h3>Cover 任务</h3><p>下载、分离与旋律提取均可取消；Bridge 写入开始后以宿主实际结果为准。</p></div></div><div class="download-list">${taskCards}</div></section>` : "";
    form = `<div class="mode-limit"><strong>声库边界：</strong>Toolbox 会记录指定声库并自动连接/导入，但 SynthV 官方脚本 API 当前不能分配 singer 身份；不会伪报已切换。</div><form id="cover-form" class="workflow-form workflow-wide"><label>BV 或 YouTube 来源<input id="cover-source" required placeholder="BV1... 或 https://www.youtube.com/watch?v=..." /></label><div class="workflow-pair"><label>目标声库<input id="cover-voice" required maxlength="200" placeholder="例如 Mai 2" /></label><label>SynthV 进程<select id="cover-process">${processOptions}</select></label></div><label>完整歌词（可选；CJK 按字、拉丁词按词映射）<textarea id="cover-lyrics" rows="7" placeholder="留空时使用 MIDI/SynthV 默认歌词；歌词 token 多于音符会明确失败"></textarea></label><div class="workflow-pair"><label>目标轨道编号<input id="cover-track" type="number" min="1" max="10000" value="1" required /></label><label>音符组名称<input id="cover-group" value="Toolbox Cover" maxlength="200" required /></label></div><label class="checkbox workflow-check"><input id="cover-rights" type="checkbox" /> 我拥有来源内容或已取得足够授权，并会遵守来源平台规则</label><button class="primary">${icon("sparkles", 16)} 开始完整 Cover</button></form>${taskList}`;
  } else if (id === "tuning-learning") {
    const profiles = tuningProfiles.length ? `<div class="download-list">${tuningProfiles.map((profile) => `<article class="download-item completed"><span class="component-status ready">${icon("waveform", 17)}</span><div><div class="download-title"><strong>${escapeHtml(profile.voiceName)}</strong><span>${profile.sourceSamples} 个参考 · ${profile.outcomeSamples} 个反馈</span></div><small>响度 ${profile.parameters.loudness.toFixed(2)} · 张力 ${profile.parameters.tension.toFixed(3)} · 气声 ${profile.parameters.breathiness.toFixed(3)} · 颤音 ${profile.parameters.vibratoStrength.toFixed(3)}</small></div></article>`).join("")}</div>` : `<div class="mode-limit">尚无调声档案。每个精确声库名称使用独立本地档案，不会互相污染。</div>`;
    form = `<div class="workflow-split"><form id="tuning-learn-form" class="workflow-form"><h3>从参考人声学习</h3><label>参考人声音频路径<input id="tuning-audio" required /></label><label>精确声库名称<input id="tuning-voice" required maxlength="200" /></label><button class="primary">${icon("waveform", 16)} 分析并更新档案</button></form><form id="tuning-apply-form" class="workflow-form"><h3>应用已学习参数</h3><label>声库档案<select id="tuning-profile" required>${tuningProfiles.map((profile) => `<option value="${escapeHtml(profile.voiceName)}">${escapeHtml(profile.voiceName)}</option>`).join("")}</select></label><div class="workflow-pair"><label>轨道<input id="tuning-track" type="number" min="1" value="1" required /></label><label>音符组<input id="tuning-group" type="number" min="1" value="1" required /></label></div><button class="primary" ${app.bridgeConnected && tuningProfiles.length ? "" : "disabled"}>${icon("sparkles", 16)} ${app.bridgeConnected ? "应用到 SynthV" : "请先连接 Bridge"}</button></form></div>${profiles}`;
  } else if (id === "media-import") {
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
  const result = workflowResult ? renderWorkflowResult(workflowResult, ai) : "";
  return `<section class="workflow-panel"><div class="workflow-heading"><span class="feature-icon ${feature?.accent ?? "violet"}">${icon(feature?.icon ?? "toolbox", 25)}</span><div><span class="eyebrow">${escapeHtml(group?.title ?? "ACTIVE WORKFLOW")}</span><h2>${escapeHtml(feature?.title ?? "工作流")}</h2><p>${escapeHtml(feature?.description ?? "")}</p></div></div>${form}${result}</section>`;
}

function renderToolboxUpdateResult(): string {
  if (!toolboxUpdate) return "";
  const result = toolboxUpdate;
  const sameVersion = result.latestVersion === result.currentVersion;
  const status = result.updateAvailable ? t("accountUi.updateAvailable") : sameVersion ? t("accountUi.upToDate") : t("accountUi.currentVersionIsNewer");
  const published = result.publishedAtUtc ? new Date(result.publishedAtUtc).toLocaleString(locale()) : t("accountUi.publicationDateUnknown");
  const checked = new Date(result.checkedAtUtc).toLocaleString(locale());
  const notes = result.releaseNotes.trim()
    ? `<pre class="update-release-notes">${escapeHtml(result.releaseNotes)}</pre>`
    : `<div class="empty-inline">${t("accountUi.noReleaseNotesWereProvidedForThisVersion")}</div>`;
  return `<section class="update-check-result ${result.updateAvailable ? "available" : "current"}"><div class="update-status"><span class="feature-icon ${result.updateAvailable ? "orange" : "emerald"}">${icon(result.updateAvailable ? "download" : "check", 22)}</span><div><span class="availability ${result.updateAvailable ? "warning" : "ready"}">${status}</span><h3>${escapeHtml(result.releaseName)}</h3><small>${t("accountUi.published")} ${escapeHtml(published)} ${t("accountUi.checked")} ${escapeHtml(checked)}</small></div></div><div class="result-dashboard compact">${resultMetric(t("accountUi.currentVersion"), `v${result.currentVersion}`)}${resultMetric(t("accountUi.latestStableVersion"), `v${result.latestVersion}`, result.updateAvailable ? "warning" : "success")}</div><div class="update-notes-heading"><strong>${t("accountUi.releaseNotes")}</strong><span>${t("accountUi.contentFromTheOfficialGithubRelease")}</span></div>${notes}<div class="result-actions"><span>${result.updateAvailable ? t("accountUi.confirmTheDownloadAndInstallationOnTheOfficialPage") : t("accountUi.youCanAlsoBrowseAllPreviousReleases")}</span><button class="secondary" data-open-toolbox-releases>${icon("arrow", 15)} ${t("accountUi.openOfficialReleases")}</button></div></section>`;
}

function renderCopilot(): string {
  const messages = conversation?.messages.filter((message) => message.role === "user" || message.role === "assistant") ?? [];
  const approvals = fileApprovals.length ? `<section class="file-approvals"><strong>需要文件访问批准</strong>${fileApprovals.map((item) => `<article><code>${escapeHtml(item.path)}</code><small>${escapeHtml(item.purpose)}</small><button class="primary compact" data-approve-file="${escapeHtml(item.id)}">通过</button><button class="secondary compact" data-deny-file="${escapeHtml(item.id)}">拒绝</button></article>`).join("")}</section>` : "";
  const provider = activeAiProvider();
  const providerName = provider ? aiProviderDisplayName(provider) : "尚未选择提供商";
  const providerModel = provider?.model || "选择模型";
  const providerStatus = provider
    ? `${provider.accounts.filter((account) => account.authorized).length} 个 OAuth · ${provider.apiKeys.length} 个 API Key`
    : "未配置连接";
  return `<div class="copilot-layout">
    <aside class="sessions-panel"><div class="sessions-panel-head"><button class="primary full" data-new-conversation>${icon("plus", 17)} 新建对话</button><span class="nav-label">历史对话</span></div><div class="session-list">${conversations.length ? conversations.map((item) => `<button class="session-item ${conversation?.id === item.id ? "active" : ""}" data-conversation="${escapeHtml(item.id)}"><strong>${escapeHtml(item.title)}</strong><small>${item.messageCount} 条消息 · ${escapeHtml(item.updatedAt.slice(0, 10))}</small></button>`).join("") : '<p class="empty-small">还没有历史对话</p>'}</div></aside>
    <section class="chat-panel">
      <div class="chat-header"><div class="chat-title"><strong>${escapeHtml(conversation?.title ?? "新对话")}</strong><small>Copilot 只会调用已启用的能力</small></div><div class="chat-header-actions" aria-label="对话工具栏"><button type="button" class="chat-model-button" data-open-ai-provider-picker aria-label="选择供应商和模型；当前为 ${escapeHtml(providerName)} ${escapeHtml(providerModel)}"><span class="chat-model-mark">${icon("sparkles", 14)}</span><span><strong>${escapeHtml(providerName)}</strong><small>${escapeHtml(providerModel)} · ${providerStatus}</small></span>${icon("arrow", 14)}</button><div class="chat-work-mode" role="group" aria-label="Agent 工作模式"><button type="button" class="${app?.agentWorkMode === "edit" ? "active" : ""}" data-agent-work-mode="edit" aria-pressed="${app?.agentWorkMode === "edit"}">Edit</button><button type="button" class="${app?.agentWorkMode === "solo" ? "active" : ""}" data-agent-work-mode="solo" aria-pressed="${app?.agentWorkMode === "solo"}">Solo</button></div></div></div>
      ${approvals}
      <div class="messages">${messages.length ? messages.map(renderMessage).join("") : `<div class="empty-chat"><span class="mode-icon purple">${icon("bot", 30)}</span><h2>今天想完成什么？</h2><p>可以从分析音频、检查工程或连接 SynthV 开始。</p><div class="prompt-chips"><button data-prompt="分析这段音频的 BPM、调性和能量变化">分析音频特征</button><button data-prompt="检查当前 SynthV 工程并总结轨道结构">检查 SynthV 工程</button><button data-prompt="帮我规划从演唱音频到 MIDI 或 SynthV 工程的工作流">规划音频到 SynthV</button></div></div>`}</div>
      <form id="chat-form" class="composer"><div class="composer-shell"><textarea id="chat-input" rows="1" placeholder="向 Copilot 描述任务…"></textarea><button class="primary icon-button" type="submit" title="发送" aria-label="发送消息">${icon("send", 19)}</button></div><span>Copilot 可能出错，重要修改请在 SynthV 中复核。按 Ctrl/⌘ + Enter 发送。</span></form>
    </section>
  </div>`;
}

function renderMessage(message: ChatMessage): string {
  const mine = message.role === "user";
  return `<div class="message ${mine ? "user" : "assistant"}"><span class="avatar">${mine ? "你" : "π"}</span><div><small>${mine ? "你" : "Copilot"}</small><p>${escapeHtml(message.content)}</p></div></div>`;
}

function renderComponents(): string {
  if (!app) return "";
  const statusLabel = { queued: "排队中", downloading: "下载中", installing: "安装中", completed: "已完成", failed: "失败", cancelled: "已取消" } as const;
  const activeDownloads = app.downloads.filter((item) => item.status !== "completed");
  const queue = activeDownloads.length ? `<section class="download-queue panel">
    <div class="section-heading"><div><h2>下载队列</h2><p>队列串行执行；内置下载器只获取固定版本，并在安装前校验 SHA-256。</p></div><span class="queue-count">${activeDownloads.length}</span></div>
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

function renderBridgeProcessRows(): string {
  return synthvProcesses.length
    ? synthvProcesses.map((process) => `<article class="synthv-process-row"><div><strong>${escapeHtml(process.name)}</strong><small>PID ${process.processId} · ${escapeHtml(process.command)}</small></div><div class="button-row"><button class="primary compact" data-auto-connect-synthv="${process.processId}">F13 启动并连接</button><button class="secondary compact" data-send-synthv-stop="${process.processId}">F14 停止</button></div></article>`).join("")
    : '<div class="empty-inline compact-empty">没有发现正在运行的 SynthV 进程。</div>';
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
  const processList = renderBridgeProcessRows();
  const processControls = `<section class="panel bridge-instances-panel"><div class="panel-heading"><span class="feature-icon violet">${icon("bridge", 25)}</span><div><h2>SynthV 实例</h2><p>${escapeHtml(shortcuts.detail)}</p></div>${renderInstanceRefreshControls()}</div><div class="shortcut-tags"><span>启动 / 重连：${escapeHtml(shortcuts.bridgeStart)}</span><span>停止：${escapeHtml(shortcuts.bridgeStop)}</span></div><div class="synthv-process-list">${processList}</div></section>`;
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
  const externalMcp = app.mode === "ai"
    ? `<div class="warning-card"><span>${icon("server", 23)}</span><div><strong>${t("connections.externalWarning")}</strong><p>${t("connections.externalWarningDescription")}</p></div></div>
      <div class="mcp-layout"><section class="panel"><div class="section-heading"><div><h2>${t("connections.external")}</h2><p>${t("connections.configurations", { count: app.mcpServers.length })}</p></div></div><div class="mcp-list">${app.mcpServers.length ? app.mcpServers.map((server) => `<article><span class="server-icon">${icon("server", 20)}</span><div><strong>${escapeHtml(server.name)}</strong><code>${escapeHtml([server.command, ...server.args].join(" "))}</code></div><span class="availability">${server.enabled ? t("connections.enabled") : t("connections.disabledServer")}</span><button class="icon-plain" data-test-mcp="${escapeHtml(server.id)}" title="${t("nav.connections")}">${icon("sync", 17)}</button><button class="icon-plain danger" data-delete-mcp="${escapeHtml(server.id)}" title="${t("connections.deleted")}">${icon("trash", 17)}</button></article>`).join("") : `<div class="empty-inline">${t("connections.noServers")}</div>`}</div></section>
      <section class="panel"><div class="section-heading"><div><h2>${t("connections.addStdio")}</h2><p>${t("connections.stdioDescription")}</p></div></div><form id="mcp-form" class="form-stack"><label>${t("connections.name")}<input id="mcp-name" required placeholder="Filesystem tools" /></label><label>${t("connections.command")}<input id="mcp-command" required placeholder="npx, node, or an absolute path" /></label><label>${t("connections.arguments")}<textarea id="mcp-args" rows="4" placeholder="-y\n@modelcontextprotocol/server-filesystem\n/path/to/workspace"></textarea></label><label class="checkbox"><input id="mcp-enabled" type="checkbox" checked /> ${t("connections.enableOnSave")}</label><button class="primary">${t("connections.addServer")}</button></form></section></div>`
    : `<section class="panel quiet-panel"><span class="mode-icon slate">${icon("server", 24)}</span><div><h2>${t("connections.aiOnly")}</h2><p>${t("connections.aiOnlyDescription")}</p></div></section>`;
  return `<div class="connections-layout"><section class="panel http-api-settings"><div class="section-heading"><div><h2>${t("connections.localService")}</h2><p>${t("connections.localServiceDescription")}</p></div><span class="availability ${httpApiStatus.running ? "ready" : httpApiStatus.enabled || httpApiStatus.agentEnabled ? "warning" : ""}">${httpApiStatus.running ? t("connections.running") : httpApiStatus.enabled || httpApiStatus.agentEnabled ? t("connections.failed") : t("connections.off")}</span></div><form id="http-api-form" class="http-api-form"><label class="fluent-switch large"><input id="http-api-enabled" name="enabled" type="checkbox" ${httpApiStatus.enabled ? "checked" : ""} aria-label="${t("connections.mcpTools")}" aria-describedby="http-api-help" /><span></span>${t("connections.mcpTools")}</label><label class="fluent-switch large"><input id="http-agent-enabled" name="agentEnabled" type="checkbox" ${httpApiStatus.agentEnabled ? "checked" : ""} aria-label="${t("connections.agentChat")}" aria-describedby="http-api-help" /><span></span>${t("connections.agentChat")}</label><label class="http-api-port">${t("connections.port")}<input id="http-api-port" name="port" type="number" min="1" max="65535" step="1" value="${httpApiStatus.port || 17831}" inputmode="numeric" required aria-describedby="http-api-help" /></label><button class="primary" type="submit" ${busy ? "disabled" : ""}>${t("connections.apply")}</button></form><div id="http-api-help" class="http-api-status"><span><strong>${t("connections.listening")}</strong>${httpApiStatus.running ? t("connections.active") : httpApiStatus.enabled || httpApiStatus.agentEnabled ? t("connections.inactive") : t("connections.disabled")}</span>${httpApiStatus.endpoint ? `<span><strong>MCP</strong><code>${escapeHtml(httpApiStatus.endpoint)}</code></span>` : ""}${httpApiStatus.agentEndpoint ? `<span><strong>Agent</strong><code>${escapeHtml(httpApiStatus.agentEndpoint)}</code></span>` : ""}${httpApiStatus.lastError ? `<span class="error-text"><strong>${t("connections.error")}</strong>${escapeHtml(httpApiStatus.lastError)}</span>` : ""}</div></section>${externalMcp}</div>`;
}

function fallbackAiProviders(): AiProviderSummary[] {
  return [{
    id: "anthropic",
    displayName: "Claude / Anthropic",
    description: t("accountUi.anthropicConnection"),
    active: true,
    connected: false,
    healthyAccounts: 0,
    totalAccounts: 0,
    model: "",
    oauthModels: [],
    apiKeyModels: [],
    accounts: [],
    apiKeys: [],
    models: [],
    authMethods: ["oauth", "api-key"],
    available: true,
    oauthEnabled: true,
    loadStrategy: "round-robin",
    unavailableReason: null,
  }, {
    id: "openai-codex",
    displayName: "OpenAI / Codex",
    description: t("accountUi.openaiConnection"),
    active: false,
    connected: false,
    healthyAccounts: 0,
    totalAccounts: 0,
    model: "",
    oauthModels: [],
    apiKeyModels: [],
    accounts: [],
    apiKeys: [],
    models: [],
    authMethods: ["oauth", "api-key"],
    available: true,
    oauthEnabled: true,
    loadStrategy: "round-robin",
    unavailableReason: null,
  }, {
    id: "workbuddy",
    displayName: "WorkBuddy",
    description: t("accountUi.workbuddyConnection"),
    active: false,
    connected: false,
    healthyAccounts: 0,
    totalAccounts: 0,
    model: "glm-5.2",
    models: [],
    oauthModels: ["glm-5.2"],
    apiKeyModels: [],
    accounts: [],
    apiKeys: [],
    authMethods: ["oauth"],
    available: true,
    oauthEnabled: true,
    loadStrategy: "round-robin",
    unavailableReason: null,
  }, {
    id: "traecode",
    displayName: "TraeCode",
    description: t("accountUi.traecodeConnection"),
    active: false,
    connected: false,
    healthyAccounts: 0,
    totalAccounts: 0,
    model: "trae-account-default",
    models: ["trae-account-default"],
    oauthModels: ["trae-account-default"],
    apiKeyModels: [],
    accounts: [],
    apiKeys: [],
    authMethods: ["oauth"],
    available: false,
    oauthEnabled: true,
    loadStrategy: "round-robin",
    unavailableReason: t("accountUi.traecodeUnavailable"),
  }];
}

function aiProviders(): AiProviderSummary[] {
  return app?.model?.providers?.length ? app.model.providers : fallbackAiProviders();
}

function isActiveAiProvider(provider: AiProviderSummary): boolean {
  return provider.active || app?.model?.activeProvider === provider.id;
}

function activeAiProvider(): AiProviderSummary | undefined {
  return aiProviders().find(isActiveAiProvider);
}

function aiConnectionSummary(): string {
  const provider = activeAiProvider();
  if (!provider) return t("accountUi.chooseAModelProvider");
  if (!provider.accounts.some((account) => account.authorized) && provider.apiKeys.length === 0) return t("accountUi.waitingForAConnection");
  return `${aiProviderDisplayName(provider)} · ${provider.accounts.filter((account) => account.authorized).length} OAuth · ${provider.apiKeys.length} API Key`;
}

function aiProviderDisplayName(provider: AiProviderSummary): string {
  return provider.displayName;
}

function aiProviderMark(provider: AiProviderSummary): string {
  return provider.id === "anthropic" ? "C" : provider.id === "openai-codex" ? "O" : provider.id === "workbuddy" ? "W" : "T";
}

function syncModelAuthDialog(): void {
  if (!modelAuthDialog && !aiProviderPickerOpen) return;
  modelAuthDialog ??= mountModelAuthDialog({
    execute: executeModelAuthAction,
    cancelAuthorization: api.cancelAiAuthorization,
    close() { aiProviderPickerOpen = false; render(); },
    updated: render,
    formatError,
  });
  const catalog = app?.model;
  const providers = aiProviders().map((provider) => ({
    id: provider.id, name: provider.displayName, description: provider.description, authMethods: provider.authMethods,
    available: provider.available, unavailableReason: provider.unavailableReason, oauthEnabled: provider.oauthEnabled,
    loadStrategy: provider.loadStrategy, mark: aiProviderMark(provider),
    authorizeLabel: provider.id === "traecode" ? t("accountUi.signInThroughTraecodeCli") : t("accountUi.authorizeInBrowser"),
    models: provider.models, oauthModels: provider.oauthModels, apiKeyModels: provider.apiKeyModels,
    oauthCredentials: provider.accounts.map((account) => ({ id: account.id, label: account.label, account: account.label, healthy: account.healthy, enabled: account.enabled, weight: account.weight, models: provider.oauthModels })),
    apiKeyCredentials: provider.apiKeys.map((key) => ({ id: key.id, label: key.label, healthy: key.healthy, enabled: key.enabled, weight: key.weight, models: key.models, cooldownUntilUtc: key.cooldownUntilUtc })),
  }));
  modelAuthDialog.update({
    providers,
    theme: "system",
    model: catalog ? { providerId: catalog.activeProvider, model: aiProviders().find((item) => item.id === catalog.activeProvider)?.model ?? "" } : null,
    catalogStatus: { state: catalog?.catalogError ? "error" : "ready", source: catalog?.catalogSource === "models-dev" ? "models.dev" : "fallback", checkedAt: catalog?.catalogGeneratedAt ? new Date(catalog.catalogGeneratedAt).toISOString() : undefined, error: catalog?.catalogError },
    open: aiProviderPickerOpen,
  });
}

async function executeModelAuthAction(action: ModelAuthAction, detail: unknown[], operationId?: string): Promise<void> {
  switch (action) {
    case "authorize-oauth":
    case "reconnect-oauth": {
      const [provider, credentialId] = detail as [AiProviderId, string?];
      app = await api.authorizeAiProvider(provider, credentialId, operationId);
      notice = t("accountUi.officialAccountAuthorizationUpdated");
      break;
    }
    case "add-api-key": {
      const [payload] = detail as [{ providerId: AiProviderId; label: string; apiKey: string }];
      app = await api.addAiApiKey(payload.providerId, payload.label, payload.apiKey);
      notice = t("accountUi.apiKeySavedAndVerified");
      break;
    }
    case "remove-oauth":
    case "remove-api-key": {
      const [provider, id] = detail as [AiProviderId, string];
      app = await (action === "remove-oauth" ? api.removeAiProviderAccount(provider, id) : api.removeAiApiKey(provider, id));
      break;
    }
    case "update-credential": {
      const [payload] = detail as [{ providerId: AiProviderId; credentialId: string; enabled: boolean; weight: number }];
      app = await api.updateAiCredential(payload.providerId, payload.credentialId, payload.enabled, payload.weight);
      break;
    }
    case "update-provider": {
      const [payload] = detail as [{ providerId: AiProviderId; oauthEnabled: boolean }];
      app = await api.updateAiProvider(payload.providerId, payload.oauthEnabled);
      break;
    }
    case "select-model": {
      const [payload] = detail as [{ providerId: AiProviderId; model: string }];
      app = await api.selectAiProvider(payload.providerId, payload.model);
      notice = t("accountUi.currentAiProviderAndModelUpdated");
      break;
    }
    case "update-provider-strategy": {
      const [payload] = detail as [{ providerId: AiProviderId; strategy: AiLoadStrategy }];
      app = await api.updateAiProviderStrategy(payload.providerId, payload.strategy);
      break;
    }
    case "refresh-catalog": {
      await refreshAiProviderSummary(true);
      break;
    }
  }
}

function renderAiProviderSettings(): string {
  const legacyWarning = app?.model?.legacyConfigured
    ? `<div class="ai-legacy-warning">${icon("shield", 17)}<span><strong>${t("settings.legacyCredentials")}</strong><small>${t("settings.legacyCredentialsDescription")}</small></span></div>`
    : "";
  const activeProvider = activeAiProvider();
  const activeVerified = Boolean(activeProvider && (activeProvider.accounts.some((account) => account.authorized) || activeProvider.apiKeys.length));
  const activeStatus = activeProvider ? t("settings.oauthSummary", { count: activeProvider.accounts.filter((account) => account.authorized).length, keys: activeProvider.apiKeys.length }) : t("settings.notConfigured");
  return `<section class="panel ai-provider-panel"><div class="section-heading"><div><h2>${t("settings.providers")}</h2><p>${t("settings.providersDescription")}</p></div><span class="availability ${activeVerified ? "ready" : "warning"}">${activeStatus}</span></div>
    ${legacyWarning}<div class="ai-provider-summary"><div><strong>${escapeHtml(activeProvider ? aiProviderDisplayName(activeProvider) : t("settings.noProvider"))}</strong><small>${escapeHtml(activeProvider?.model || t("settings.chooseProvider"))}</small></div><button type="button" class="primary" data-open-ai-provider-picker ${busy ? "disabled" : ""}>${t("settings.addProvider")}</button></div>
  </section>`;
}

function renderSettings(): string {
  if (!app) return "";
  const showSvpRouting = app.platform === "windows" || app.platform === "preview";
  const association = app.svpAssociation;
  const associationLabel = !association.supported
    ? t("settings.unsupported")
    : association.isDefault
      ? t("settings.defaultApp")
      : association.registered
        ? t("settings.registered")
        : t("settings.unregistered");
  return `<div class="settings-layout"><section class="panel language-settings"><div class="section-heading"><div><h2>${t("settings.language")}</h2></div><label><select id="language-select" aria-label="${t("settings.language")}"><option value="zh-CN" ${locale() === "zh-CN" ? "selected" : ""}>${t("settings.chinese")}</option><option value="en" ${locale() === "en" ? "selected" : ""}>${t("settings.english")}</option></select></label></div></section>
    <section class="panel"><div class="section-heading"><div><h2>${t("settings.mode")}</h2><p>${t("settings.modeDescription")}</p></div></div><div class="mode-setting"><button class="setting-choice ${app.mode === "toolbox" ? "active" : ""}" data-set-mode="toolbox"><span class="mode-icon slate">${icon("toolbox", 23)}</span><span><strong>${t("settings.toolbox")}</strong><small>${t("settings.toolboxDescription")}</small></span>${app.mode === "toolbox" ? icon("check", 20) : ""}</button><button class="setting-choice ${app.mode === "ai" ? "active" : ""}" data-set-mode="ai"><span class="mode-icon purple">${icon("sparkles", 23)}</span><span><strong>${t("settings.ai")}</strong><small>${t("settings.aiDescription")}</small></span>${app.mode === "ai" ? icon("check", 20) : ""}</button></div></section>
    ${app.mode === "ai" ? renderAiProviderSettings() : `<section class="panel quiet-panel"><span class="mode-icon slate">${icon("bot", 24)}</span><div><h2>${t("settings.aiDisabled")}</h2><p>${t("settings.aiDisabledDescription")}</p></div></section>`}
    ${showSvpRouting ? `<section class="panel smart-route-settings"><div class="section-heading"><div><h2>${t("settings.smartRoute")}</h2><p>${t("settings.smartRouteDescription")}</p></div><label class="fluent-switch large"><input id="svp-routing-enabled" type="checkbox" ${app.smartSvpLaunchEnabled ? "checked" : ""} ${association.supported ? "" : "disabled"} aria-label="${t("settings.smartRoute")}" /><span></span>${app.smartSvpLaunchEnabled ? t("settings.enabled") : t("settings.disabled")}</label></div><div class="smart-route-state ${association.isDefault ? "ready" : "pending"}"><span class="feature-icon ${association.isDefault ? "emerald" : "blue"}">${icon("file", 20)}</span><div><strong>${escapeHtml(associationLabel)}</strong><p>${escapeHtml(association.detail)}</p></div><button class="secondary compact" data-open-svp-default-apps ${association.supported ? "" : "disabled"}>${t("settings.openDefaults")}</button></div><div class="smart-route-boundary">${icon("shield", 17)}<span><strong>${t("accountUi.smartRoutingWorksOnlyWhileToolboxIsAlreadyRunning")}</strong><small>${t("accountUi.onAColdStartOrWhenThisFeatureIs")}</small></span></div></section>` : ""}
    <section class="panel app-update-settings"><div class="section-heading"><div><h2>${t("settings.update")}</h2><p>${t("settings.updateDescription")}</p></div></div><div class="update-check-actions"><div><small>${t("settings.currentVersion")}</small><strong>v${escapeHtml(app.appVersion)}</strong></div><button class="secondary" data-check-toolbox-update>${icon("sync", 16)} ${toolboxUpdate ? t("settings.checkAgain") : t("settings.checkUpdate")}</button></div>${renderToolboxUpdateResult()}</section>
    <section class="panel"><div class="section-heading"><div><h2>${t("settings.dataPlatform")}</h2><p>${t("settings.dataPlatformDescription")}</p></div></div><dl class="detail-list"><div><dt>${t("settings.platform")}</dt><dd>${escapeHtml(app.platform)}</dd></div><div><dt>${t("settings.config")}</dt><dd><code>${escapeHtml(app.configPath)}</code></dd></div><div><dt>${t("settings.appVersion")}</dt><dd>${escapeHtml(app.appVersion)}</dd></div></dl></section></div>`;
}

function wireForms(): void {
  document.querySelector<HTMLSelectElement>("#language-select")?.addEventListener("change", (event) => {
    setLocale((event.currentTarget as HTMLSelectElement).value === "en" ? "en" : "zh-CN");
    render();
  });
  document.querySelector<HTMLFormElement>("#audio-prepare-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    syncAudioPreparationFormsFromDom();
    requestAudioPlan("prepare");
  });
  document.querySelector<HTMLFormElement>("#audio-normalize-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    syncAudioPreparationFormsFromDom();
    requestAudioPlan("normalize");
  });
  document.querySelector<HTMLFormElement>("#tuning-learn-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void run(async () => {
      const profile = await api.learnTuningProfile(document.querySelector<HTMLInputElement>("#tuning-audio")?.value.trim() ?? "", document.querySelector<HTMLInputElement>("#tuning-voice")?.value.trim() ?? "");
      tuningProfiles = [...tuningProfiles.filter((item) => item.normalizedVoiceName !== profile.normalizedVoiceName), profile].sort((left, right) => left.voiceName.localeCompare(right.voiceName));
      notice = `已更新 ${profile.voiceName} 的调声档案。`;
    });
  });
  document.querySelector<HTMLFormElement>("#tuning-apply-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void run(async () => {
      workflowResult = await api.applyTuningProfile(document.querySelector<HTMLSelectElement>("#tuning-profile")?.value ?? "", Number(document.querySelector<HTMLInputElement>("#tuning-track")?.value ?? 1), Number(document.querySelector<HTMLInputElement>("#tuning-group")?.value ?? 1));
      notice = workflowResult.summary;
    });
  });
  document.querySelector<HTMLFormElement>("#cover-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const processText = document.querySelector<HTMLSelectElement>("#cover-process")?.value ?? "";
    const lyrics = document.querySelector<HTMLTextAreaElement>("#cover-lyrics")?.value ?? "";
    void run(async () => {
      const task = await api.queueCover({
        source: document.querySelector<HTMLInputElement>("#cover-source")?.value.trim() ?? "",
        lyrics: lyrics.trim() ? lyrics : null,
        voiceName: document.querySelector<HTMLInputElement>("#cover-voice")?.value.trim() ?? "",
        processId: processText ? Number(processText) : null,
        trackIndex: Number(document.querySelector<HTMLInputElement>("#cover-track")?.value ?? 1),
        groupName: document.querySelector<HTMLInputElement>("#cover-group")?.value.trim() ?? "Toolbox Cover",
        rightsConfirmed: document.querySelector<HTMLInputElement>("#cover-rights")?.checked ?? false,
        tolerance: 0.08,
        advanced: true,
      });
      mediaTasks = [...mediaTasks.filter((item) => item.id !== task.id), task];
      notice = "完整 Cover 已加入可取消任务队列。";
    });
  });
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
    void run(async () => {
      profiles = await api.importCurrentSv2Profile(displayName);
      const prepared = await prepareConcurrentSlotsWhenEnabled();
      await refreshAccountUsage();
      notice = t(prepared ? "accountNotice.importedPrepared" : "accountNotice.imported");
    });
  });
  document.querySelector<HTMLFormElement>("#profile-create-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const displayName = document.querySelector<HTMLInputElement>("#profile-create-name")?.value.trim() ?? "";
    void run(async () => {
      profiles = await api.createSv2Profile(displayName);
      const prepared = await prepareConcurrentSlotsWhenEnabled();
      await refreshAccountUsage();
      notice = t(prepared ? "accountNotice.createdPrepared" : "accountNotice.created");
    });
  });
  document.querySelectorAll<HTMLFormElement>("[data-profile-rename-form]").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    const slotId = form.dataset.profileRenameForm ?? "";
    const displayName = form.querySelector<HTMLInputElement>("input")?.value.trim() ?? "";
    if (!slotId) return;
    void run(async () => { profiles = await api.renameSv2Profile(slotId, displayName); notice = displayName ? t("accountNotice.noteSaved") : t("accountNotice.noteCleared"); });
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
      notice = t(prepared ? "accountNotice.globalSavedPrepared" : "accountNotice.globalSaved", { count: prepared });
    });
  });
  document.querySelector<HTMLFormElement>("#chat-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector<HTMLTextAreaElement>("#chat-input")?.value.trim();
    if (!input) return;
    void sendPrompt(input);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-approve-file], [data-deny-file]").forEach((button) => button.addEventListener("click", () => void run(async () => { await api.decideAgentFileApproval(button.dataset.approveFile ?? button.dataset.denyFile ?? "", button.hasAttribute("data-approve-file")); fileApprovals = await api.agentFileApprovals(); notice = button.hasAttribute("data-approve-file") ? t("accountNotice.fileApproved") : t("accountNotice.fileDenied"); })));
  document.querySelector<HTMLTextAreaElement>("#chat-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      const input = (event.currentTarget as HTMLTextAreaElement).value.trim();
      if (input) void sendPrompt(input);
    }
  });
  document.querySelector<HTMLInputElement>("#svp-routing-enabled")?.addEventListener("change", (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    void run(async () => {
      app = await api.setSvpLaunchRouting(enabled);
      notice = enabled
        ? t("accountNotice.routingEnabled")
        : t("accountNotice.routingDisabled");
    });
  });
  document.querySelector<HTMLFormElement>("#http-api-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const enabled = form.querySelector<HTMLInputElement>('[name="enabled"]')?.checked ?? false;
    const agentEnabled = form.querySelector<HTMLInputElement>('[name="agentEnabled"]')?.checked ?? false;
    const port = Number(form.querySelector<HTMLInputElement>('[name="port"]')?.value ?? 0);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      error = t("connections.portError");
      notice = "";
      render();
      return;
    }
    void run(async () => {
      httpApiStatus = await api.configureHttpApi(enabled, agentEnabled, port);
      notice = enabled || agentEnabled ? t("connections.saved") : t("connections.closed");
    });
  });
  document.querySelector<HTMLFormElement>("#mcp-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.querySelector<HTMLInputElement>("#mcp-name")?.value.trim() ?? "";
    const command = document.querySelector<HTMLInputElement>("#mcp-command")?.value.trim() ?? "";
    const args = (document.querySelector<HTMLTextAreaElement>("#mcp-args")?.value ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const enabled = document.querySelector<HTMLInputElement>("#mcp-enabled")?.checked ?? false;
    const server: McpServerConfig = { id: crypto.randomUUID(), name, command, args, enabled };
    void run(async () => { app = await api.saveMcpServer(server); notice = t("connections.serverAdded", { name }); });
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
  if (!activeAiProvider()?.connected) {
    aiProviderPickerOpen = true;
    syncModelAuthDialog();
    refreshAiCatalogLive();
    return;
  }
  await run(async () => {
    if (!conversation) conversation = await api.newConversation();
    const optimistic: ChatMessage = { role: "user", content: input };
    conversation.messages.push(optimistic);
    render();
    const added = await withAiProviderStateRefresh(() => api.sendMessage(input));
    conversation.messages = conversation.messages.filter((message) => message !== optimistic);
    conversation.messages.push(...added);
    [conversations, fileApprovals] = await Promise.all([
      api.listConversations(),
      api.agentFileApprovals(),
    ]);
  });
}

async function refreshAiProviderSummary(forceCatalog = false): Promise<void> {
  if (app?.mode === "ai") app.model = await api.aiProviderState(forceCatalog);
}

function refreshAiCatalogLive(): void {
  if (app?.mode !== "ai" || aiCatalogRefreshInFlight) return;
  const request = refreshAiProviderSummary(true)
    .catch(() => {})
    .finally(() => {
      if (aiCatalogRefreshInFlight === request) aiCatalogRefreshInFlight = undefined;
      render();
    });
  aiCatalogRefreshInFlight = request;
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
  if (target.closest(".audio-preparation")) {
    syncAudioPreparationFormsFromDom();
    return;
  }
  if (!target.closest(".lyric-workbench-grid")) return;
  if (lyricPersistTimer !== undefined) window.clearTimeout(lyricPersistTimer);
  lyricPersistTimer = window.setTimeout(() => {
    lyricPersistTimer = undefined;
    syncLyricDraftFromDom();
  }, 250);
});
document.addEventListener("change", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest(".audio-preparation")) syncAudioPreparationFormsFromDom();
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLSelectElement && target.hasAttribute("data-instance-refresh-interval")) {
    setInstanceRefreshInterval(Number(target.value));
  }
});

// Media loading happens outside the promise that resolves the opaque artifact
// URL.  Convert a native WebView failure into a visible, retryable UI state,
// but only for the artifact and input generation that is still on screen.
document.addEventListener("error", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLMediaElement) || target.tagName.toLowerCase() !== "audio") return;
  if (!target.closest(".audio-preparation")) return;

  const artifactId = target.dataset.audioPreviewArtifact;
  const previewKind = target.dataset.audioPreviewKind;
  const generation = Number(target.dataset.audioPreviewGeneration);
  if (!artifactId || !Number.isInteger(generation) || generation !== audioInputGeneration) return;

  const currentArtifactId = previewKind === "source"
    ? audioProbe?.sourceArtifactId
    : previewKind === "result"
      ? audioJob?.artifactId
      : undefined;
  if (currentArtifactId !== artifactId) return;

  // Clearing the URL removes the failed element on the next render and
  // restores the explicit preview button.  The guard also prevents a stale
  // error event from causing a render loop after that replacement.
  if (previewKind === "source") {
    if (!audioSourcePreviewUrl) return;
    audioSourcePreviewUrl = "";
  } else {
    if (!audioPreviewUrl) return;
    audioPreviewUrl = "";
  }
  audioUiError = "当前 WebView 无法分段读取、文件过大或格式不支持；处理不受影响；结果可打开位置/另存为。";
  render();
}, true);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && pendingInstanceTermination) {
    event.preventDefault();
    pendingInstanceTermination = undefined;
    render();
    return;
  }
  if (event.key !== "Escape" || !aiProviderPickerOpen) return;
  event.preventDefault();
  modelAuthDialog?.close();
});

document.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("button, [data-page], [data-onboarding], [data-audio-drop-zone]");
  if (!target || target.hasAttribute("disabled")) return;
  if (target.hasAttribute("data-open-ai-provider-picker")) {
    aiProviderPickerOpen = true;
    render();
    refreshAiCatalogLive();
    return;
  }
  if (page === "lyrics" && document.querySelector(".lyric-workbench-grid")) syncLyricDraftFromDom();
  if (target.hasAttribute("data-audio-drop-zone")) {
    void audioApi.pickAudioFile().then((path) => {
      if (path) selectAudioPreparationInput(path);
    }).catch((reason) => { audioUiError = formatError(reason); render(); });
    return;
  }
  if (target.hasAttribute("data-pick-audio-file")) {
    void audioApi.pickAudioFile().then((path) => {
      if (path) selectAudioPreparationInput(path);
    }).catch((reason) => {
      audioUiError = formatError(reason);
      render();
    });
    return;
  }
  if (target.hasAttribute("data-cancel-audio-plan")) {
    pendingAudioPlan = undefined;
    render();
    return;
  }
  if (target.hasAttribute("data-confirm-audio-plan")) {
    startPlannedAudioJob();
    return;
  }
  if (target.dataset.cancelAudioJob) {
    const jobId = target.dataset.cancelAudioJob;
    if (!jobId || audioCancelInFlight || audioJob?.id !== jobId || isTerminalAudioJob(audioJob)) return;
    audioCancelInFlight = true;
    render();
    void audioApi.cancelAudioJob(jobId).then((snapshot) => {
      if (audioJob?.id !== jobId) return;
      const merged = mergeAudioJobSnapshot(audioJob, snapshot);
      audioJob = merged;
      if (isTerminalAudioJob(merged)) {
        clearAudioJobPoll();
        audioUiNotice = merged.status === "cancelled" ? "音频任务已取消。" : "音频任务已结束。";
      } else {
        scheduleAudioJobPoll(jobId);
      }
    }).catch((reason) => {
      audioUiError = formatError(reason);
    }).finally(() => {
      audioCancelInFlight = false;
      render();
    });
    return;
  }
  if (target.hasAttribute("data-analyze-audio-loudness")) {
    const inputPath = audioPrepareForm.inputPath;
    if (!inputPath || audioLoudnessAnalysisInFlight) return;
    const generation = audioInputGeneration;
    const analysisGeneration = ++audioLoudnessAnalysisGeneration;
    audioLoudnessAnalysisInFlight = true;
    audioUiError = "";
    audioUiNotice = "正在检查 EBU R128 响度…";
    render();
    void audioApi.analyzeLoudness(inputPath).then((report) => {
      if (generation !== audioInputGeneration || audioPrepareForm.inputPath !== inputPath) return;
      audioLoudness = report;
      audioUiNotice = "响度检查完成。";
      render();
    }).catch((reason) => {
      if (generation !== audioInputGeneration || audioPrepareForm.inputPath !== inputPath) return;
      audioUiError = formatError(reason);
      audioUiNotice = "";
    }).finally(() => {
      if (analysisGeneration !== audioLoudnessAnalysisGeneration) return;
      audioLoudnessAnalysisInFlight = false;
      render();
    });
    return;
  }
  if (target.dataset.previewAudioArtifact) {
    const artifactId = target.dataset.previewAudioArtifact;
    const previewKind = target.dataset.audioPreviewKind;
    const generation = audioInputGeneration;
    const isCurrentArtifact = () => generation === audioInputGeneration && (
      previewKind === "source"
        ? audioProbe?.sourceArtifactId === artifactId
        : audioJob?.artifactId === artifactId
    );
    if (!beginAudioArtifactAction()) return;
    void audioApi.audioArtifactPreviewUrl(artifactId).then((url) => {
      if (!isCurrentArtifact()) return;
      if (previewKind === "source") audioSourcePreviewUrl = url;
      else audioPreviewUrl = url;
    }).catch((reason) => {
      if (!isCurrentArtifact()) return;
      audioUiError = formatError(reason);
    }).finally(finishAudioArtifactAction);
    return;
  }
  if (target.dataset.revealAudioArtifact) {
    if (!beginAudioArtifactAction()) return;
    void audioApi.revealAudioArtifact(target.dataset.revealAudioArtifact).then((result) => {
      setFeedback(result);
    }).catch((reason) => { audioUiError = formatError(reason); }).finally(finishAudioArtifactAction);
    return;
  }
  if (target.dataset.copyAudioArtifact) {
    // The path is only copied from the already rendered read-only snapshot;
    // it is never sent back to a backend command as an authority-bearing path.
    const displayPath = audioJob?.artifactId === target.dataset.copyAudioArtifact
      ? audioJob.outputPath
      : undefined;
    if (!displayPath) {
      audioUiError = "此结果没有可复制的显示路径。";
      render();
      return;
    }
    if (!beginAudioArtifactAction()) return;
    void navigator.clipboard.writeText(displayPath).then(() => {
      audioUiNotice = "路径已复制到剪贴板。";
    }).catch((reason) => { audioUiError = formatError(reason); }).finally(finishAudioArtifactAction);
    return;
  }
  if (target.dataset.saveAudioArtifact) {
    if (!beginAudioArtifactAction()) return;
    void audioApi.saveAudioArtifactAs(target.dataset.saveAudioArtifact).then((result) => {
      audioUiNotice = result.saved
        ? `已安全另存为${result.fileName ? `“${result.fileName}”` : "新文件"}。`
        : "已取消另存为。";
    }).catch((reason) => { audioUiError = formatError(reason); }).finally(finishAudioArtifactAction);
    return;
  }
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
      notice = t("accountNotice.indicatorEnabled");
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
      notice = t("accountNotice.indicatorDisabled");
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
    loadSv2VoiceCatalog(true);
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
      notice = t("accountNotice.deleted");
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
    const leavingHistory = page === "history" && targetPage !== "history";
    const enteringAccounts = targetPage === "accounts" && page !== "accounts";
    const leavingAccounts = page === "accounts" && targetPage !== "accounts";
    const enteringToolCategory = targetPage === "import" || targetPage === "quality";
    const activeFeatureId = activeWorkflow;
    const activeGroup = activeFeatureId ? toolGroups.find((group) => group.featureIds.includes(activeFeatureId)) : undefined;
    instanceRefreshGeneration += 1;
    if (enteringAccounts || leavingAccounts) accountPageGeneration += 1;
    page = targetPage;
    if (leavingHistory) stopHistoryRefresh();
    if (enteringToolCategory && (activeGroup?.id !== targetPage || workflowResult?.kind === "lyric-template")) {
      activeWorkflow = undefined;
      workflowResult = undefined;
    }
    if (enteringToolCategory && !activeWorkflow) {
      const group = toolGroups.find((item) => item.id === targetPage);
      const groupFeaturesList = group ? groupFeatures(group) : [];
      activeWorkflow = groupFeaturesList.find((feature) => featureAvailability(feature, app!).tone === "ready")?.id ?? groupFeaturesList[0]?.id;
    }
    if (page === "lyrics" && workflowResult?.kind !== "lyric-template") workflowResult = undefined;
    accountManagerOpen = false;
    notice = "";
    error = "";
    if (page === "copilot") void run(async () => { [conversations, fileApprovals] = await Promise.all([api.listConversations(), api.agentFileApprovals()]); });
    else if (page === "history") scheduleHistoryRefresh();
    else if (enteringAccounts && (app?.platform === "windows" || app?.platform === "macos" || app?.platform === "preview")) {
      render();
      loadCachedAccountPage(accountPageGeneration);
    }
    else {
      render();
      refreshAudioPreparationIfSelected();
    }
    resetContentScroll();
    return;
  }
  const onboarding = target.dataset.onboarding as AppMode | undefined;
  if (onboarding) { void run(async () => { app = await api.completeOnboarding(onboarding); page = "home"; }); return; }
  const mode = target.dataset.setMode as AppMode | undefined;
  if (mode) { void run(async () => { app = await api.setMode(mode); notice = `已切换到${mode === "ai" ? " AI 模式" : "纯工具箱模式"}。`; }); return; }
  const agentWorkMode = target.dataset.agentWorkMode as AgentWorkMode | undefined;
  if (agentWorkMode) { void run(async () => { app = await api.setAgentWorkMode(agentWorkMode); notice = `Agent 已切换到 ${agentWorkMode === "solo" ? "Solo" : "Edit"} 模式。`; }); return; }
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
    const featureId = target.dataset.feature;
    const feature = features.find((item) => item.id === featureId);
    const group = feature ? toolGroups.find((item) => item.featureIds.includes(feature.id)) : undefined;
    if (!feature || !group) return;
    page = group.id;
    activeWorkflow = feature.id;
    workflowResult = undefined;
    syncManifest = undefined;
    notice = "";
    if (featureId === "audio-preparation") {
      render();
      refreshAudioPreparationIfSelected();
    } else if (featureId === "batch-recipes") void run(async () => { workflowRecipes = await api.listWorkflowRecipes(); });
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
      [synthvProcesses, synthvShortcutProfile, profiles] = await Promise.all([api.listSynthvProcesses(), api.synthvShortcutProfile(), api.sv2ProfileState()]);
      notice = synthvProcesses.length ? `发现 ${synthvProcesses.length} 个运行中的 SynthV 进程。` : "没有发现运行中的 SynthV 进程。";
    });
    return;
  }
  if (target.dataset.focusSv2) {
    const processId = Number(target.dataset.focusSv2);
    const identity = target.dataset.processIdentity || "";
    if (Number.isInteger(processId) && identity) void run(async () => setFeedback(await api.focusSv2Instance(processId, identity)));
    return;
  }
  if (target.dataset.terminateSv2) {
    const processId = Number(target.dataset.terminateSv2);
    const identity = target.dataset.processIdentity || "";
    if (Number.isInteger(processId) && identity) {
      pendingInstanceTermination = synthvProcesses.find((process) => process.processId === processId && process.processIdentity === identity);
      render();
    }
    return;
  }
  if (target.hasAttribute("data-cancel-instance-termination")) {
    pendingInstanceTermination = undefined;
    render();
    return;
  }
  if (target.hasAttribute("data-confirm-instance-termination")) {
    const process = pendingInstanceTermination;
    pendingInstanceTermination = undefined;
    const identity = process?.processIdentity;
    if (process && identity) void run(async () => {
      setFeedback(await api.terminateSv2Instance(process.processId, identity));
      [synthvProcesses, profiles] = await Promise.all([api.listSynthvProcesses(), api.sv2ProfileState()]);
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
        loadSv2VoiceCatalog(true);
        notice = t("accountNotice.refreshed");
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
        loadSv2VoiceCatalog(true);
        const slot = profiles?.slots.find((item) => item.id === slotId);
        const probe = slot?.accountProbe;
        if (probe && ["syncFailed", "offline", "expired", "invalid", "unsupported", "accountMismatch"].includes(probe.sessionStatus)) {
          error = probe.detail || t("accountNotice.authorizationUnknown");
        } else {
          notice = t("accountNotice.checked");
        }
      });
    }
    return;
  }
  if (target.dataset.profileLaunch) {
    const slotId = target.dataset.profileLaunch;
    void run(async () => { await launchSv2ProfileAfterLiveCheck(slotId); });
    return;
  }
  if (target.dataset.profileActivate) { void run(async () => { profiles = await api.activateSv2Profile(target.dataset.profileActivate ?? ""); notice = t("accountNotice.activated"); }); return; }
  if (target.dataset.profileFolder) { void run(async () => { setFeedback(await api.openSv2ProfileFolder(target.dataset.profileFolder ?? "")); }); return; }
  if (target.dataset.profileConcurrentPrepare) { void run(async () => { profiles = await api.prepareSv2ConcurrentProfile(target.dataset.profileConcurrentPrepare ?? ""); notice = t("accountNotice.isolationPrepared"); }); return; }
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
  if (target.hasAttribute("data-new-conversation")) { void run(async () => { conversation = await api.newConversation(); [conversations, fileApprovals] = await Promise.all([api.listConversations(), api.agentFileApprovals()]); }); return; }
  if (target.dataset.conversation) { void run(async () => { conversation = await api.openConversation(target.dataset.conversation ?? ""); fileApprovals = await api.agentFileApprovals(); }); return; }
  if (target.dataset.prompt) { void sendPrompt(target.dataset.prompt); return; }
  if (target.dataset.testMcp) { void run(async () => { setFeedback(await api.testMcpServer(target.dataset.testMcp ?? "")); }); return; }
  if (target.dataset.deleteMcp) { void run(async () => { app = await api.deleteMcpServer(target.dataset.deleteMcp ?? ""); notice = t("connections.deleted"); }); }
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
      error = t("accountNotice.invalidRouteRequest");
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

async function listenForAudioPreparationDrops(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().onDragDropEvent((event) => {
      if (page !== "import" || activeWorkflow !== "audio-preparation") return;
      if (event.payload.type !== "drop") return;
      const paths = event.payload.paths;
      if (paths.length !== 1) {
        audioUiError = "一次只能拖放一个音频文件。";
        render();
        return;
      }
      selectAudioPreparationInput(paths[0]);
    });
  } catch {
    // The file picker remains available on hosts that do not expose Tauri v2
    // drag-drop events (including the browser preview).
  }
}

void (async () => {
  try {
    await refresh();
    await listenForSvpRouteRequests();
    await listenForAudioPreparationDrops();
    setInstanceRefreshInterval(instanceRefreshInterval);
    render();
    refreshAiCatalogLive();
  } catch (reason) {
    root.innerHTML = `<div class="fatal"><div class="brand-mark"><img class="brand-logo" src="/assets/synthv-toolbox-logo.svg" alt="Synthesizer V Toolbox" /></div><h1>无法启动 Synthesizer V Toolbox</h1><pre>${escapeHtml(formatError(reason))}</pre><p>请确认应用由 Tauri 运行，而不是直接打开前端页面。</p></div>`;
  }
})();
