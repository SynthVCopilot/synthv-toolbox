import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AiService } from "./ai-service.js";
import type { ElectronRuntimeHost } from "./runtime-host.js";
import type { SynthVService } from "./synthv-service.js";

type Data = Record<string, unknown>;

interface DesktopSettings {
  onboardingCompleted: boolean;
  mode: "toolbox" | "ai";
  agentWorkMode: "edit" | "solo";
  updateChannel: "stable" | "nightly";
  scriptsPath?: string;
  concurrentDisclaimerAccepted: boolean;
  sv2ConcurrentEnabled: boolean;
  sv2AccountIndicatorEnabled: boolean;
  smartSvpLaunchEnabled: boolean;
  smartSvpAlwaysAsk: boolean;
  mcpServers: Data[];
}

const defaults = (): DesktopSettings => ({ onboardingCompleted: false, mode: "toolbox", agentWorkMode: "edit", updateChannel: "stable", concurrentDisclaimerAccepted: false, sv2ConcurrentEnabled: false, sv2AccountIndicatorEnabled: false, smartSvpLaunchEnabled: false, smartSvpAlwaysAsk: false, mcpServers: [] });

export class DesktopStateService {
  private settings = defaults();
  constructor(private readonly root: string, private readonly appVersion: string, private readonly runtime: ElectronRuntimeHost, private readonly ai: AiService, private readonly synthv: SynthVService) {}

  async load(): Promise<void> {
    try { this.settings = { ...defaults(), ...JSON.parse(await readFile(this.path(), "utf8")) }; }
    catch { this.settings = defaults(); }
  }

  async bootstrap(): Promise<Data> {
    const runtime = this.runtime.settingsSnapshot();
    const [model, installations, profiles, autostart] = await Promise.all([this.ai.ai_provider_state(false), this.synthv.scanInstallations(), this.synthv.profileState(), this.synthv.getAutostart()]);
    return { ...this.settings, platform: process.platform, appVersion: this.appVersion, configPath: this.path(), settingsLoadError: null, model, bridgeBundled: true, bridgeConnected: false, installations, components: [], downloads: [], pluginInternalFunctionsEnabled: runtime.pluginInternalFunctionsEnabled, pluginAdvancedFunctionsEnabled: runtime.pluginAdvancedFunctionsEnabled, autostartEnabled: autostart.enabled, autostartError: autostart.error, svpAssociation: { registered: false, currentHandler: null, detail: "Electron launch routing is available after the application is installed." }, sv2Profiles: profiles };
  }

  async update(values: Partial<DesktopSettings>): Promise<Data> { this.settings = { ...this.settings, ...values }; await this.persist(); return this.bootstrap(); }
  async saveMcpServer(server: Data): Promise<Data> { const id = requiredText(server.id, "server.id"); const next = this.settings.mcpServers.filter(item => item.id !== id); next.push({ ...server, id }); return this.update({ mcpServers: next }); }
  async deleteMcpServer(id: string): Promise<Data> { return this.update({ mcpServers: this.settings.mcpServers.filter(item => item.id !== id) }); }
  private path(): string { return join(this.root, "desktop-settings.json"); }
  private async persist(): Promise<void> { await mkdir(dirname(this.path()), { recursive: true }); const temporary = `${this.path()}.tmp`; await writeFile(temporary, JSON.stringify(this.settings), { encoding: "utf8", mode: 0o600 }); await rename(temporary, this.path()); }
}

function requiredText(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`); return value; }
