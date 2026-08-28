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
  detail: string;
}

export interface Sv2ConcurrentSlot {
  ready: boolean;
  boxName: string;
  dataPath: string;
  runningPids: number[];
  detail: string;
}

export interface Sv2ProfileSlot {
  id: string;
  displayName: string;
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
}

export interface ComponentInfo {
  id: string;
  displayName: string;
  description: string;
  audience: string;
  installed: boolean;
  status: string;
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
  mcpServers: McpServerConfig[];
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
