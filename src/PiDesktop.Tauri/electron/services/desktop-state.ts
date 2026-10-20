import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_AGENT_EFFORT, isAgentEffortLevel, type AgentEffortLevel } from "@synthv-toolbox/runtime-protocol";
import { queryFfmpegStatus } from "./component-audio-commands.js";
import type { AiService } from "./ai-service.js";
import { isIntegrationPreference, resolveSynthVIntegration, synthvDetected, type IntegrationId, type IntegrationPreference, type SynthVEvidence } from "./integrations.js";
import type { ElectronRuntimeHost } from "./runtime-host.js";
import type { SynthVService } from "./synthv-service.js";
import type { DataDirectoryDecision } from "./user-data-migration.js";

type Data = Record<string, unknown>;
type SynthVProbe = Pick<SynthVService, "scanInstallations" | "profileState" | "bridgeStatus" | "getAutostart">;

interface DesktopSettings {
  onboardingCompleted: boolean;
  mode: "toolbox" | "ai";
  agentWorkMode: "edit" | "solo";
  agentEffort: AgentEffortLevel;
  agentTranscriptsEnabled: boolean;
  updateChannel: "stable" | "nightly";
  scriptsPath?: string;
  concurrentDisclaimerAccepted: boolean;
  sv2ConcurrentEnabled: boolean;
  sv2AccountIndicatorEnabled: boolean;
  smartSvpLaunchEnabled: boolean;
  smartSvpAlwaysAsk: boolean;
  mcpServers: Data[];
  integrations: Record<IntegrationId, IntegrationPreference>;
}

const defaults = (): DesktopSettings => ({ onboardingCompleted: false, mode: "toolbox", agentWorkMode: "edit", agentEffort: DEFAULT_AGENT_EFFORT, agentTranscriptsEnabled: false, updateChannel: "stable", concurrentDisclaimerAccepted: false, sv2ConcurrentEnabled: false, sv2AccountIndicatorEnabled: false, smartSvpLaunchEnabled: false, smartSvpAlwaysAsk: false, mcpServers: [], integrations: { synthv: "auto" } });

export class DesktopStateService {
  private settings = defaults();
  private synthvEvidence: SynthVEvidence = { installations: 0, profiles: 0, bridgeConnected: false };
  private bridgeSeen = false;
  constructor(private readonly root: string, private readonly appVersion: string, private readonly runtime: ElectronRuntimeHost, private readonly ai: AiService, private readonly synthv: SynthVProbe, private readonly applyUpdateChannel?: (channel: "stable" | "nightly") => void, private readonly creativeRuntime?: { status(): Promise<{ready: boolean; detail: string}> }, private readonly bridgeLoadError?: string, private readonly onSettingsChanged?: () => void, private readonly dataDirectory?: DataDirectoryDecision) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path(), "utf8"));
      const integrations = parsed.integrations !== null && typeof parsed.integrations === "object" ? parsed.integrations : {};
      this.settings = { ...defaults(), ...parsed, agentEffort: isAgentEffortLevel(parsed.agentEffort) ? parsed.agentEffort : DEFAULT_AGENT_EFFORT, integrations: { synthv: isIntegrationPreference(integrations.synthv) ? integrations.synthv : "auto" } };
    }
    catch { this.settings = defaults(); }
    this.applyUpdateChannel?.(this.settings.updateChannel);
    if (this.settings.integrations.synthv !== "off") await this.probeSynthV();
  }

  agentEffort(): AgentEffortLevel { return this.settings.agentEffort; }
  agentWorkMode(): "edit" | "solo" { return this.settings.agentWorkMode; }
  agentTranscriptsEnabled(): boolean { return this.settings.agentTranscriptsEnabled; }
  aiModeEnabled(): boolean { return this.settings.mode === "ai"; }
  /** External stdio MCP servers the user enabled for the built-in agent (Connections page). */
  enabledMcpServers(): Data[] { return this.settings.mcpServers.filter(server => server.enabled === true); }
  /** Synchronous so agent session composition can read it; reflects the most recent SynthV probe. */
  synthvEnabled(): boolean { return resolveSynthVIntegration(this.settings.integrations.synthv, this.synthvEvidence); }

  /**
   * Probes again for "auto", so SynthV installed or started after launch is picked up without a settings change or a
   * renderer refresh. Returns whether the resolved state changed; explicit preferences need no probe.
   */
  async refreshSynthV(): Promise<boolean> {
    if (this.settings.integrations.synthv !== "auto") return false;
    const before = this.synthvEnabled();
    await this.probeSynthV();
    return this.synthvEnabled() !== before;
  }

  async bootstrap(): Promise<Data> {
    const runtime = this.runtime.settingsSnapshot();
    const [model, autostart, agentBudgets, creativeRuntime, ffmpeg, probe] = await Promise.all([this.ai.ai_provider_state(false), this.synthv.getAutostart(), this.ai.agent_budgets(), this.creativeRuntime?.status() ?? Promise.resolve({ready:false,detail:"本地音频运行环境尚未配置。"}), queryFfmpegStatus({dataRoot:join(this.root,"components")}), this.settings.integrations.synthv === "off" ? Promise.resolve(undefined) : this.probeSynthV()]);
    const enabled = this.synthvEnabled();
    const synthv = enabled && probe ? probe : { installations: [], profiles: disabledProfiles(), bridgeConnected: false, errors: probe?.errors ?? [] };
    const bridgeLoaded = this.bridgeLoadError === undefined;
    const integration = { preference: this.settings.integrations.synthv, enabled, detected: synthvDetected(this.synthvEvidence), bridgeLoaded, errors: synthv.errors };
    return { ...this.settings, integrations: { synthv: integration }, platform: process.platform, appVersion: this.appVersion, configPath: this.path(), dataDirectory: { path: this.root, migratedFrom: this.dataDirectory?.migratedFrom ?? null, deferred: this.dataDirectory?.deferred ?? null, legacyRemaining: this.dataDirectory?.legacyRemaining ?? null, setAside: this.dataDirectory?.setAside ?? null, fixupErrors: this.dataDirectory?.fixupErrors ?? [] }, settingsLoadError: null, model, bridgeBundled: bridgeLoaded, bridgeConnected: synthv.bridgeConnected, installations: synthv.installations, components: componentCatalog(synthv.profiles, creativeRuntime, ffmpeg, enabled), downloads: [], pluginInternalFunctionsEnabled: runtime.pluginInternalFunctionsEnabled, pluginAdvancedFunctionsEnabled: runtime.pluginAdvancedFunctionsEnabled, autostartEnabled: autostart.enabled, autostartError: autostart.error, svpAssociation: { supported: enabled && process.platform === "win32", registered: false, isDefault: false, detail: "Electron launch routing is available after the application is installed." }, sv2Profiles: synthv.profiles, agentBudgets };
  }

  async update(values: Partial<DesktopSettings>): Promise<Data> { this.settings = { ...this.settings, ...values }; if (values.updateChannel) this.applyUpdateChannel?.(values.updateChannel); await this.persist(); this.onSettingsChanged?.(); return this.bootstrap(); }
  async setIntegration(id: IntegrationId, preference: IntegrationPreference): Promise<Data> { return this.update({ integrations: { ...this.settings.integrations, [id]: preference } }); }
  async saveMcpServer(server: Data): Promise<Data> { const id = requiredText(server.id, "server.id"); const next = this.settings.mcpServers.filter(item => item.id !== id); next.push({ ...server, id }); return this.update({ mcpServers: next }); }
  async deleteMcpServer(id: string): Promise<Data> { return this.update({ mcpServers: this.settings.mcpServers.filter(item => item.id !== id) }); }
  /** A failing SynthV probe degrades to an error entry; it must not take down the generic bootstrap. */
  private async probeSynthV(): Promise<{ installations: unknown[]; profiles: Data; bridgeConnected: boolean; errors: string[] }> {
    const [installations, profiles, bridge] = await Promise.allSettled([this.synthv.scanInstallations(), this.synthv.profileState(), this.synthv.bridgeStatus()]);
    const errors = [...(this.bridgeLoadError ? [this.bridgeLoadError] : []), ...[installations, profiles, bridge].flatMap(result => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : [])];
    const value = { installations: installations.status === "fulfilled" ? installations.value as unknown[] : [], profiles: profiles.status === "fulfilled" ? profiles.value : disabledProfiles(), bridgeConnected: bridge.status === "fulfilled" && bridge.value.connected === true, errors };
    // A Bridge seen connected stays evidence for the rest of the run: a heartbeat missed while SynthV is busy, or the Bridge
    // being stopped, must not hide the integration in the middle of work. The scripts folder the Bridge was installed into
    // from the Bridge page counts as an installation; it covers editions and locations the scanner does not know (Flat).
    this.bridgeSeen ||= value.bridgeConnected;
    const installationCount = value.installations.length || (await this.savedScriptsFolderExists() ? 1 : 0);
    this.synthvEvidence = { installations: installationCount, profiles: Array.isArray(value.profiles.slots) ? value.profiles.slots.length : 0, bridgeConnected: this.bridgeSeen };
    return value;
  }
  private async savedScriptsFolderExists(): Promise<boolean> {
    const path = this.settings.scriptsPath;
    if (typeof path !== "string" || !path.trim()) return false;
    try { return (await stat(path)).isDirectory(); } catch { return false; }
  }
  private path(): string { return join(this.root, "desktop-settings.json"); }
  private async persist(): Promise<void> { await mkdir(dirname(this.path()), { recursive: true }); const temporary = `${this.path()}.tmp`; await writeFile(temporary, JSON.stringify(this.settings), { encoding: "utf8", mode: 0o600 }); await rename(temporary, this.path()); }
}

function requiredText(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`); return value; }
/** Same shape as SynthVService.profileState() so the renderer needs no special case when SynthV is off. */
function disabledProfiles(): Data {
  return { supported: false, canonicalPath: "", vaultPath: "", activeSlotId: null, canonicalRootExists: false, canImportCurrent: false, recoveryRequired: false, recoveryDetail: "", slots: [], blockers: [], concurrentProvider: { available: false, name: "Sandboxie", edition: "", version: "", installPath: "", detail: "The Synthesizer V integration is turned off." }, concurrentDefaults: { appSettings: false, voiceLibraries: false } };
}
function componentCatalog(profiles: Data, runtime: {ready:boolean;detail:string}, ffmpeg: {available:boolean;detail:string}, synthvEnabled: boolean): Data[] {
  const sandbox = profiles.concurrentProvider as Data | undefined;
  return [
    { id: "ffmpeg", displayName: "FFmpeg", description: "Audio and video conversion runtime.", audience: "AI and manual workflows", installed: ffmpeg.available, downloaded: false, installable: false, removable: false, status: ffmpeg.detail },
    { id: "pi-audio", displayName: "pi-audio", description: "Audio feature and score analysis component.", audience: "AI and manual workflows", installed: runtime.ready, downloaded: false, installable: true, removable: false, status: runtime.detail },
    ...(synthvEnabled ? [{ id: "cvrs", displayName: "CVRS", description: "SynthV project inspection and export component.", audience: "AI and manual workflows", installed: runtime.ready, downloaded: false, installable: true, removable: false, status: runtime.detail }] : []),
    { id: "vocal-separation", displayName: "Vocal separation", description: "Local vocal and accompaniment separation component.", audience: "AI and manual workflows", installed: runtime.ready, downloaded: false, installable: true, removable: false, status: runtime.detail },
    ...(synthvEnabled ? [{ id: "sandboxie", displayName: "Sandboxie", description: "Windows isolation provider for concurrent SynthV profiles.", audience: "Windows concurrent profiles", installed: sandbox?.available === true, downloaded: false, installable: false, removable: false, status: String(sandbox?.detail ?? "Unavailable on this platform.") }] : []),
  ];
}
