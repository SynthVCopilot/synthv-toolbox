import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_AGENT_EFFORT, isAgentEffortLevel, type AgentEffortLevel } from "@synthv-toolbox/runtime-protocol";
import { queryFfmpegStatus } from "./component-audio-commands.js";
import type { AiService } from "./ai-service.js";
import type { ElectronRuntimeHost } from "./runtime-host.js";
import type { SynthVService } from "./synthv-service.js";

type Data = Record<string, unknown>;

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
}

const defaults = (): DesktopSettings => ({ onboardingCompleted: false, mode: "toolbox", agentWorkMode: "edit", agentEffort: DEFAULT_AGENT_EFFORT, agentTranscriptsEnabled: false, updateChannel: "stable", concurrentDisclaimerAccepted: false, sv2ConcurrentEnabled: false, sv2AccountIndicatorEnabled: false, smartSvpLaunchEnabled: false, smartSvpAlwaysAsk: false, mcpServers: [] });

export class DesktopStateService {
  private settings = defaults();
  constructor(private readonly root: string, private readonly appVersion: string, private readonly runtime: ElectronRuntimeHost, private readonly ai: AiService, private readonly synthv: SynthVService, private readonly applyUpdateChannel?: (channel: "stable" | "nightly") => void, private readonly creativeRuntime?: { status(): Promise<{ready: boolean; detail: string}> }) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path(), "utf8"));
      this.settings = { ...defaults(), ...parsed, agentEffort: isAgentEffortLevel(parsed.agentEffort) ? parsed.agentEffort : DEFAULT_AGENT_EFFORT };
    }
    catch { this.settings = defaults(); }
    this.applyUpdateChannel?.(this.settings.updateChannel);
  }

  agentEffort(): AgentEffortLevel { return this.settings.agentEffort; }
  agentWorkMode(): "edit" | "solo" { return this.settings.agentWorkMode; }
  agentTranscriptsEnabled(): boolean { return this.settings.agentTranscriptsEnabled; }

  async bootstrap(): Promise<Data> {
    const runtime = this.runtime.settingsSnapshot();
    const [model, installations, profiles, autostart, agentBudgets, bridge, creativeRuntime, ffmpeg] = await Promise.all([this.ai.ai_provider_state(false), this.synthv.scanInstallations(), this.synthv.profileState(), this.synthv.getAutostart(), this.ai.agent_budgets(), this.synthv.bridgeStatus(), this.creativeRuntime?.status() ?? Promise.resolve({ready:false,detail:"本地音频运行环境尚未配置。"}), queryFfmpegStatus({dataRoot:join(this.root,"components")})]);
    return { ...this.settings, platform: process.platform, appVersion: this.appVersion, configPath: this.path(), settingsLoadError: null, model, bridgeBundled: true, bridgeConnected: bridge.connected === true, installations, components: componentCatalog(profiles, creativeRuntime, ffmpeg), downloads: [], pluginInternalFunctionsEnabled: runtime.pluginInternalFunctionsEnabled, pluginAdvancedFunctionsEnabled: runtime.pluginAdvancedFunctionsEnabled, autostartEnabled: autostart.enabled, autostartError: autostart.error, svpAssociation: { supported: process.platform === "win32", registered: false, isDefault: false, detail: "Electron launch routing is available after the application is installed." }, sv2Profiles: profiles, agentBudgets };
  }

  async update(values: Partial<DesktopSettings>): Promise<Data> { this.settings = { ...this.settings, ...values }; if (values.updateChannel) this.applyUpdateChannel?.(values.updateChannel); await this.persist(); return this.bootstrap(); }
  async saveMcpServer(server: Data): Promise<Data> { const id = requiredText(server.id, "server.id"); const next = this.settings.mcpServers.filter(item => item.id !== id); next.push({ ...server, id }); return this.update({ mcpServers: next }); }
  async deleteMcpServer(id: string): Promise<Data> { return this.update({ mcpServers: this.settings.mcpServers.filter(item => item.id !== id) }); }
  private path(): string { return join(this.root, "desktop-settings.json"); }
  private async persist(): Promise<void> { await mkdir(dirname(this.path()), { recursive: true }); const temporary = `${this.path()}.tmp`; await writeFile(temporary, JSON.stringify(this.settings), { encoding: "utf8", mode: 0o600 }); await rename(temporary, this.path()); }
}

function requiredText(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`); return value; }
function componentCatalog(profiles: Data, runtime: {ready:boolean;detail:string}, ffmpeg: {available:boolean;detail:string}): Data[] {
  const sandbox = profiles.concurrentProvider as Data | undefined;
  return [
    { id: "ffmpeg", displayName: "FFmpeg", description: "Audio and video conversion runtime.", audience: "AI and manual workflows", installed: ffmpeg.available, downloaded: false, installable: false, removable: false, status: ffmpeg.detail },
    { id: "pi-audio", displayName: "pi-audio", description: "Audio feature and score analysis component.", audience: "AI and manual workflows", installed: runtime.ready, downloaded: false, installable: true, removable: false, status: runtime.detail },
    { id: "cvrs", displayName: "CVRS", description: "SynthV project inspection and export component.", audience: "AI and manual workflows", installed: runtime.ready, downloaded: false, installable: true, removable: false, status: runtime.detail },
    { id: "vocal-separation", displayName: "Vocal separation", description: "Local vocal and accompaniment separation component.", audience: "AI and manual workflows", installed: runtime.ready, downloaded: false, installable: true, removable: false, status: runtime.detail },
    { id: "sandboxie", displayName: "Sandboxie", description: "Windows isolation provider for concurrent SynthV profiles.", audience: "Windows concurrent profiles", installed: sandbox?.available === true, downloaded: false, installable: false, removable: false, status: String(sandbox?.detail ?? "Unavailable on this platform.") },
  ];
}
