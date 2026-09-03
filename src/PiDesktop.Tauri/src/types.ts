export type AppMode = "toolbox" | "ai";
export type AgentWorkMode = "edit" | "solo";

export type AiProviderId = "anthropic" | "openai-codex";

export interface AiProviderAccountSummary {
  id: string;
  label: string;
  expiresAt: number;
  authorized: boolean;
  healthy: boolean;
}

export interface AiProviderSummary {
  id: AiProviderId;
  displayName: string;
  description: string;
  active: boolean;
  connected: boolean;
  healthyAccounts: number;
  totalAccounts: number;
  model: string;
  models: string[];
  accounts: AiProviderAccountSummary[];
}

export interface ModelSummary {
  activeProvider: AiProviderId;
  legacyConfigured: boolean;
  providers: AiProviderSummary[];
}

export interface OpenCodeCatalogProvider {
  id: string;
  name: string;
  modelCount: number;
  package: string;
}

export interface OpenCodeCatalog {
  generatedAt: number;
  providers: OpenCodeCatalogProvider[];
}

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

export interface SynthVInstallation {
  displayName: string;
  installPath?: string;
  executablePath?: string;
  scriptsPath?: string;
  source: string;
}

export interface Sv2ProcessBlocker {
  pid?: number;
  name: string;
  reason: string;
}

export interface Sv2ConcurrentProvider {
  available: boolean;
  name: string;
  edition: string;
  version: string;
  installPath: string;
  detail: string;
}

export type Sv2IsolationPreference = "global" | "on" | "off";

export interface Sv2ConcurrentDefaults {
  appSettings: boolean;
  voiceLibraries: boolean;
}

export interface Sv2ConcurrentContent {
  appSettings: Sv2IsolationPreference;
  voiceLibraries: Sv2IsolationPreference;
  effectiveAppSettings: boolean;
  effectiveVoiceLibraries: boolean;
}

export interface Sv2ConcurrentSlot {
  ready: boolean;
  boxName: string;
  dataPath: string;
  runningPids: number[];
  detail: string;
  content: Sv2ConcurrentContent;
}

export type Sv2SessionProtectionStatus = "signInRequired" | "ready" | "monitoring" | "recoveryPending" | "restored" | "attention";

export interface Sv2SessionProtection {
  status: Sv2SessionProtectionStatus;
  snapshotAvailable: boolean;
  lastDetectedAtUtc?: string;
  lastRestoredAtUtc?: string;
  detail: string;
}

export type Sv2AccountProbeSessionStatus = "ready" | "missing" | "inUse" | "expired" | "loginRequired" | "invalid" | "syncFailed" | "accountMismatch" | "unsupported" | "offline";
export type Sv2AuthorizationStatus = "verified" | "unknown";

export interface Sv2AccountProbe {
  sessionStatus: Sv2AccountProbeSessionStatus;
  remoteUse: Sv2RemoteUseStatus;
  authorizationStatus: Sv2AuthorizationStatus;
  authorizedVoiceCount: number;
  authorizedVoices: string[];
  accountDisplayName?: string;
  accountEmail?: string;
  checkedAtUtc: string;
  detail: string;
}

export type Sv2VoiceInventoryStatus = "verified" | "manual" | "unknown";

export interface Sv2VoiceInventory {
  status: Sv2VoiceInventoryStatus;
  manuallyConfirmedVoices: string[];
  verifiedAuthorizedVoiceCount: number;
  detail: string;
}

export interface Sv2ProfileSlot {
  id: string;
  displayName: string;
  username: string;
  email: string;
  color: string;
  createdAtUtc: string;
  lastActivatedAtUtc?: string;
  isActive: boolean;
  sessionCached: boolean;
  dataPath: string;
  sessionProtection: Sv2SessionProtection;
  concurrentSessionProtection: Sv2SessionProtection;
  accountProbe: Sv2AccountProbe;
  concurrentAccountProbe: Sv2AccountProbe;
  concurrent: Sv2ConcurrentSlot;
  voiceInventory: Sv2VoiceInventory;
}

export interface Sv2ProfilesState {
  supported: boolean;
  canonicalPath: string;
  vaultPath: string;
  activeSlotId?: string;
  canonicalRootExists: boolean;
  canImportCurrent: boolean;
  recoveryRequired: boolean;
  recoveryDetail: string;
  slots: Sv2ProfileSlot[];
  blockers: Sv2ProcessBlocker[];
  concurrentProvider: Sv2ConcurrentProvider;
  concurrentDefaults: Sv2ConcurrentDefaults;
}

export type Sv2RemoteUseStatus = "clear" | "detected" | "unknown";

export interface Sv2AccountPrecheck {
  supported: boolean;
  checkedAtUtc: string;
  slotId?: string;
  displayName: string;
  localUse: boolean;
  localProcesses: Sv2ProcessBlocker[];
  concurrentPids: number[];
  remoteUse: Sv2RemoteUseStatus;
  sessionStatus: Sv2AccountProbeSessionStatus;
  authorizationStatus: Sv2AuthorizationStatus;
  authorizedVoiceCount: number;
  sessionCached: boolean;
  recoveryPending: boolean;
  summary: string;
  detail: string;
}

export interface Sv2AccountUsageSnapshot {
  profiles: Sv2ProfilesState;
  precheck: Sv2AccountPrecheck;
}

export type SvpLaunchMode = "normal" | "concurrent";
export type SvpAuthorizationSource = "session" | "mixed" | "manual" | "unknown";

export interface SvpVoiceRequirement {
  name: string;
  version?: number | null;
  backendType: string;
}

export interface SvpRouteCandidate {
  slotId: string;
  displayName: string;
  idle: boolean;
  launchMode?: SvpLaunchMode | null;
  remoteUse: Sv2RemoteUseStatus;
  sessionStatus: Sv2AccountProbeSessionStatus;
  authorizationSource: SvpAuthorizationSource;
  matchedVoices: string[];
  missingOrUnknownVoices: string[];
  exactAuthorizationMatch: boolean;
  reason: string;
}

export interface SvpRoutePlan {
  projectPath: string;
  requiredVoices: SvpVoiceRequirement[];
  candidates: SvpRouteCandidate[];
  selectedSlotId?: string | null;
  selectedLaunchMode?: SvpLaunchMode | null;
  requiresConfirmation: boolean;
  summary: string;
  detail: string;
}

export interface SvpAssociationState {
  supported: boolean;
  registered: boolean;
  isDefault: boolean;
  detail: string;
}

export interface ComponentInfo {
  id: string;
  displayName: string;
  description: string;
  audience: string;
  installed: boolean;
  downloaded: boolean;
  installable: boolean;
  removable: boolean;
  status: string;
}

export type ComponentDownloadStatus = "queued" | "downloading" | "installing" | "completed" | "failed" | "cancelled";

export interface ComponentDownload {
  id: string;
  componentId: string;
  displayName: string;
  status: ComponentDownloadStatus;
  progress: number;
  detail: string;
  updatedAt: string;
}

export interface BootstrapState {
  onboardingCompleted: boolean;
  mode: AppMode;
  agentWorkMode: AgentWorkMode;
  platform: string;
  appVersion: string;
  configPath: string;
  settingsLoadError?: string | null;
  model?: ModelSummary;
  scriptsPath?: string;
  bridgeBundled: boolean;
  bridgeConnected: boolean;
  installations: SynthVInstallation[];
  components: ComponentInfo[];
  downloads: ComponentDownload[];
  mcpServers: McpServerConfig[];
  concurrentDisclaimerAccepted: boolean;
  sv2ConcurrentEnabled: boolean;
  sv2AccountIndicatorEnabled: boolean;
  smartSvpLaunchEnabled: boolean;
  svpAssociation: SvpAssociationState;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ConversationSnapshot {
  id: string;
  title: string;
  messages: ChatMessage[];
}

export interface OperationResult {
  succeeded: boolean;
  summary: string;
  detail: string;
}

export interface ToolboxUpdateCheck {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseName: string;
  releaseUrl: string;
  publishedAtUtc?: string;
  releaseNotes: string;
  checkedAtUtc: string;
}

export interface WorkflowResult {
  kind: string;
  summary: string;
  outputPath?: string;
  data: Record<string, unknown>;
  aiReview?: string;
}

export interface MediaSourcePreview {
  sourceUrl: string;
  canonicalUrl: string;
  platform: string;
  mediaId: string;
  title: string;
  uploader: string;
  durationSeconds?: number | null;
  thumbnailUrl?: string | null;
}

export interface MediaImportResult {
  importId: string;
  source: MediaSourcePreview;
  audioPath: string;
  metadataPath: string;
  manifestPath: string;
  sha256: string;
  importedAtUtc: string;
}

export type MediaTaskStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

export interface MediaTaskSnapshot {
  id: string;
  kind: string;
  status: MediaTaskStatus;
  progress: number;
  detail: string;
  result?: Record<string, unknown> | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CoverTaskRequest {
  source: string;
  lyrics?: string | null;
  voiceName: string;
  processId?: number | null;
  trackIndex: number;
  groupName: string;
  rightsConfirmed: boolean;
  tolerance: number;
  advanced: boolean;
}

export interface SourceStyleFeatures {
  durationSec: number;
  medianPitchMidi: number;
  pitchRangeSemitones: number;
  vibratoRateHz: number;
  vibratoDepthCents: number;
  dynamicRangeDb: number;
  breathinessProxy: number;
  brightnessHz: number;
  voicedRatio: number;
}

export interface TuningParameters {
  loudness: number;
  tension: number;
  breathiness: number;
  gender: number;
  toneShift: number;
  vibratoStrength: number;
}

export interface TuningProfile {
  voiceName: string;
  normalizedVoiceName: string;
  sourceSamples: number;
  outcomeSamples: number;
  averageFeatures: SourceStyleFeatures;
  parameters: TuningParameters;
  updatedAtUtc: string;
}

export interface AudioCaptureCapability {
  supported: boolean;
  backend: string;
  detail: string;
  maxClipSeconds: number;
}

export interface AudioCaptureTarget {
  processId: number;
  name: string;
}

export interface SynthVProcess {
  processId: number;
  name: string;
  command: string;
}

export interface SynthVShortcutProfile {
  bridgeStart: string;
  bridgeStop: string;
  projectSave: string;
  detail: string;
}

export type RhymeMatchMode = "family" | "exact";

export interface RhymeCharacter {
  character: string;
  pinyin: string[];
}

export interface ChineseRhymeLookup {
  language: "zh-CN";
  query: string;
  queryPinyin: string[];
  matchMode: RhymeMatchMode;
  rhymeKeys: string[];
  total: number;
  characters: RhymeCharacter[];
  coverageNote: string;
}

export interface LyricSectionRequest {
  id: string;
  kind: "intro" | "verse" | "preChorus" | "chorus" | "bridge" | "instrumental" | "outro" | "custom";
  label: string;
  lineCount: number;
  rhymeScheme: string;
}

export interface LyricCandidateRequest {
  language: "zh-CN";
  brief: string;
  imagery: string;
  sectionLabel: string;
  tone: string;
  targetRhyme: string;
  candidateCount: number;
}

export interface LyricCandidate {
  text: string;
  rhymeFoot?: string | null;
  rhymeMatched?: boolean | null;
  note: string;
}

export interface LyricCandidateSet {
  language: "zh-CN";
  brief: string;
  imagery: string;
  sectionLabel: string;
  targetRhyme?: string | null;
  candidates: LyricCandidate[];
}

export interface LyricProject {
  schemaVersion: number;
  id: string;
  title: string;
  draft: string;
  rhymeTargets: Record<string, string>;
  sections: LyricSectionRequest[];
  revision: number;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface LyricProjectSummary {
  id: string;
  title: string;
  revision: number;
  lineCount: number;
  updatedAtUtc: string;
}

export interface WorkflowRecipe {
  id: string;
  title: string;
  description: string;
  kind: string;
  inputKind: string;
  supportsBatch: boolean;
  requiresBridge: boolean;
  requiresAi: boolean;
  defaultParameters: Record<string, unknown>;
}

export interface CreativeHistoryEntry {
  id: string;
  kind: string;
  title: string;
  summary: string;
  createdAtUtc: string;
  outputPath?: string;
  parameters: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface ProjectCheckpoint {
  id: string;
  label: string;
  sourcePath: string;
  snapshotPath: string;
  sourceSha256: string;
  sourceSize: number;
  createdAtUtc: string;
}

export interface BatchWorkflowItem {
  inputPath: string;
  status: "completed" | "failed";
  result?: WorkflowResult;
  error?: string;
}

export interface BatchWorkflowResult {
  recipeId: string;
  completed: number;
  failed: number;
  items: BatchWorkflowItem[];
}

export type Sv2SyncCategoryId = "userDictionaries" | "scripts" | "presets" | "safeSettings";
export type Sv2SyncAction = "copy" | "update" | "conflict" | "skip";

export interface Sv2SyncCategory {
  id: Sv2SyncCategoryId;
  label: string;
  description: string;
  relativeRoots: string[];
}

export interface Sv2SyncEntry {
  category: Sv2SyncCategoryId;
  relativePath: string;
  action: Sv2SyncAction;
  sourceSize: number;
  sourceSha256: string;
  targetSize?: number;
  targetSha256?: string;
}

export interface Sv2SyncManifest {
  version: number;
  overwrite: boolean;
  rootScope: string;
  entries: Sv2SyncEntry[];
  token: string;
}

export interface Sv2SyncResult {
  copied: number;
  updated: number;
  skipped: number;
  conflicts: number;
}
