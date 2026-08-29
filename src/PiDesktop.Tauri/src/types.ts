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
  concurrent: Sv2ConcurrentSlot;
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
