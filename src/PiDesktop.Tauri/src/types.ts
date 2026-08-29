export type AppMode = "toolbox" | "ai";

export interface ModelSummary {
  baseUrl: string;
  model: string;
  tokenConfigured: boolean;
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

export type Sv2VoiceInventoryStatus = "manual" | "localEvidence" | "unknown";

export interface Sv2VoiceInventory {
  status: Sv2VoiceInventoryStatus;
  manuallyConfirmedVoices: string[];
  installedOpaqueCount: number;
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
  status: string;
}

export type ComponentDownloadStatus = "queued" | "downloading" | "installing" | "completed" | "failed";

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
  platform: string;
  appVersion: string;
  configPath: string;
  model?: ModelSummary;
  scriptsPath?: string;
  bridgeBundled: boolean;
  bridgeConnected: boolean;
  installations: SynthVInstallation[];
  components: ComponentInfo[];
  downloads: ComponentDownload[];
  mcpServers: McpServerConfig[];
  concurrentDisclaimerAccepted: boolean;
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

export interface WorkflowResult {
  kind: string;
  summary: string;
  outputPath?: string;
  data: Record<string, unknown>;
  aiReview?: string;
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
