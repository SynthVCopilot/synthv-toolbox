import { createHash, randomUUID } from "node:crypto";
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
const bridgeProfiles = new Set(["sv2", "sv1", "flat"]);
const shortcutActions = new Set(["start", "startLegacy", "stop", "save", "undo", "refresh"]);

export type OperationResult = { succeeded: boolean; summary: string; detail: string };
export type ProcessInfo = { processId: number; processIdentity: string; name: string; productName: string; version: string; command: string; windowTitle: string; isSv2: boolean; sandboxed: boolean | null };
type Runner = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
type Slot = { id: string; displayName: string; createdAtUtc: string; lastActivatedAtUtc: string | null };
type ProfileStore = { activeSlotId: string | null; slots: Slot[] };
type SynthVServiceOptions = { dataRoot?: string };
type SessionDocument = { path: string; sha256: string; encryptedBytes: number; plaintext: string; supported: false; detail: string };
const MAX_SESSION_BYTES = 1024 * 1024;
const MAX_VOICES = 256;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_CATALOG_IMAGE_BYTES = 16 * 1024 * 1024;
export type AutostartController = {
  set(enabled: boolean): Promise<boolean>;
  get(): Promise<{ enabled: boolean; error: string | null }>;
};

export class SynthVService {
  private pendingRoute: Record<string, unknown> | null = null;
  private readonly syncPreviews = new Map<string, { targetSlotId: string; categories: string[] }>();
  private bridgeClient?: { getStatus(): Promise<{ connected: boolean; status?: { sessionToken?: string }; reason?: string }>; paths: { stopFile: string } };
  private readonly root: string;
  private readonly bridgeDirectory: string;
  private readonly runner: Runner;
  private readonly autostart?: AutostartController;
  private readonly dataRoot: string;
  constructor(root: string, bridgeDirectory: string, runner: Runner = runCommand, autostart?: AutostartController, options: SynthVServiceOptions = {}) {
    this.root = root;
    this.bridgeDirectory = bridgeDirectory;
    this.runner = runner;
    this.autostart = autostart;
    this.dataRoot = resolve(options.dataRoot ?? defaultDataRoot());
  }

  async scanInstallations(): Promise<Array<Record<string, unknown>>> {
    const candidates = platform() === "win32" ? windowsCandidates() : macCandidates();
    const found: Array<Record<string, unknown>> = [];
    for (const candidate of candidates) {
      const executable = await firstFile(candidate.executables);
      const scriptsPath = await firstDirectory(candidate.scripts);
      if (!executable && !scriptsPath) continue;
      found.push({ displayName: candidate.name, installPath: executable ? dirname(executable) : null, executablePath: executable, scriptsPath, source: candidate.source, bridgeProfile: bridgeProfile(candidate.name) });
    }
    return found.sort((left, right) => String(left.displayName).localeCompare(String(right.displayName)));
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    const result = platform() === "win32"
      ? await this.runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"])
      : await this.runner("ps", ["-axo", "pid=,comm=,args="]);
    if (result.code !== 0) throw new Error(result.stderr || "Unable to enumerate SynthV processes.");
    return platform() === "win32" ? parseWindowsProcesses(result.stdout) : parseMacProcesses(result.stdout);
  }

  async focusInstance(processId: number, processIdentity: string): Promise<OperationResult> {
    await this.assertProcess(processId, processIdentity);
    if (platform() === "win32") await this.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$p=[int]$args[0]; Add-Type -Name Win32 -Namespace Native -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);'; $x=Get-Process -Id $p -ErrorAction Stop; [Native.Win32]::SetForegroundWindow($x.MainWindowHandle) | Out-Null", String(processId)]);
    else await this.run("osascript", ["-e", "on run argv\nset pidValue to item 1 of argv\ntell application \"System Events\" to set frontmost of first process whose unix id is (pidValue as integer) to true\nend run", String(processId)]);
    return ok("SynthV instance focused.");
  }

  async terminateInstance(processId: number, processIdentity: string): Promise<OperationResult> {
    await this.assertProcess(processId, processIdentity);
    await this.run(platform() === "win32" ? "taskkill.exe" : "kill", platform() === "win32" ? ["/PID", String(processId), "/T", "/F"] : ["-TERM", String(processId)]);
    return ok("SynthV instance terminated.");
  }

  async sendShortcut(processId: number, processIdentity: string, action: string): Promise<OperationResult> {
    if (!shortcutActions.has(action)) throw new Error("Unsupported SynthV shortcut action.");
    await this.focusInstance(processId, processIdentity);
    const key = ({ start: "{F13}", startLegacy: "{F13}", stop: "{F14}", save: "^s", undo: "^z", refresh: "{F5}" } as Record<string, string>)[action];
    if (platform() === "win32") await this.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait($args[0])", key]);
    else {
      const script = action === "save" ? "tell application \"System Events\" to key code 1 using command down"
        : action === "undo" ? "tell application \"System Events\" to key code 6 using command down"
          : `tell application \"System Events\" to key code ${{ start: 105, startLegacy: 105, stop: 107, refresh: 96 }[action as "start" | "startLegacy" | "stop" | "refresh"]}`;
      const result = await this.run("osascript", ["-e", script]);
      if (result.code !== 0) throw new Error(result.stderr || "macOS Accessibility did not accept the SynthV shortcut.");
    }
    return ok("SynthV shortcut sent.");
  }

  shortcutProfile(): Record<string, string> { return { bridgeStart: "F13", bridgeStop: "F14", projectSave: platform() === "darwin" ? "⌘S" : "Ctrl+S", detail: "Shortcuts are sent only after the selected SynthV process identity is verified." }; }

  async installBridge(targets: Array<{ scriptsPath: string; bridgeProfile: string }>): Promise<Array<Record<string, unknown>>> {
    return Promise.all(targets.map(async target => ({ scriptsPath: target.scriptsPath, bridgeProfile: target.bridgeProfile, result: await this.installBridgeTarget(target) })));
  }

  async diagnoseBridge(targets: Array<{ scriptsPath: string; bridgeProfile: string }>): Promise<Array<Record<string, unknown>>> {
    return Promise.all(targets.map(async target => ({ scriptsPath: target.scriptsPath, bridgeProfile: target.bridgeProfile, result: await this.diagnoseBridgeTarget(target) })));
  }

  async profileState(): Promise<Record<string, unknown>> {
    const store = await this.readStore();
    const slots = await Promise.all(store.slots.map(async slot => ({ ...slot, isActive: slot.id === store.activeSlotId, dataPath: this.slotPath(slot.id), sessionCached: await exists(this.sessionPath(slot.id)), installedVoiceIds: await this.installedVoiceIds(this.slotPath(slot.id)) })));
    const sandbox = await this.sandboxie();
    return { supported: platform() === "win32" || platform() === "darwin", canonicalPath: this.canonicalPath(), vaultPath: this.vaultPath(), activeSlotId: store.activeSlotId, canonicalRootExists: await exists(this.canonicalPath()), canImportCurrent: await exists(this.canonicalPath()), recoveryRequired: false, recoveryDetail: "", slots, blockers: [], concurrentProvider: sandbox ? { available: true, name: "Sandboxie", edition: "", version: "", installPath: dirname(sandbox.start), detail: "Sandboxie launch tools were found; a configured isolated box is required." } : { available: false, name: "Sandboxie", edition: "", version: "", installPath: "", detail: "Sandboxie Start.exe and SbieIni.exe were not found." }, concurrentDefaults: { appSettings: false, voiceLibraries: false } };
  }

  async createProfile(displayName: string): Promise<Record<string, unknown>> {
    requireText(displayName, "displayName");
    const store = await this.readStore();
    const slot: Slot = { id: randomUUID(), displayName, createdAtUtc: new Date().toISOString(), lastActivatedAtUtc: null };
    await mkdir(this.slotPath(slot.id), { recursive: true });
    store.slots.push(slot);
    await this.writeStore(store);
    return this.profileState();
  }

  async renameProfile(slotId: string, displayName: string): Promise<Record<string, unknown>> { const store = await this.readStore(); const slot = this.slot(store, slotId); requireText(displayName, "displayName"); slot.displayName = displayName; await this.writeStore(store); return this.profileState(); }
  async deleteProfile(slotId: string): Promise<Record<string, unknown>> { const store = await this.readStore(); this.slot(store, slotId); if (store.activeSlotId === slotId) throw new Error("The active profile cannot be deleted."); store.slots = store.slots.filter(slot => slot.id !== slotId); await rm(this.slotPath(slotId), { recursive: true, force: true }); await this.writeStore(store); return this.profileState(); }

  async activateProfile(slotId: string): Promise<Record<string, unknown>> {
    const store = await this.readStore(); const slot = this.slot(store, slotId);
    await mkdir(dirname(this.canonicalPath()), { recursive: true });
    if (await exists(this.canonicalPath())) await rm(this.canonicalPath(), { recursive: true, force: true });
    await cp(this.slotPath(slotId), this.canonicalPath(), { recursive: true, force: true });
    slot.lastActivatedAtUtc = new Date().toISOString(); store.activeSlotId = slotId; await this.writeStore(store); return this.profileState();
  }

  async prepareConcurrentProfile(slotId: string): Promise<Record<string, unknown>> {
    const store = await this.readStore(); this.slot(store, slotId); const sandbox = await this.sandboxie(); if (!sandbox) throw new Error("Sandboxie Start.exe and SbieIni.exe were not found.");
    const compact = slotId.replaceAll("-", ""); const box = `SV2TB${compact.slice(0, 24)}`; const root = join(this.vaultPath(), "instances", compact.slice(0, 16)); const slot = this.slotPath(slotId);
    const overlay = join(root, "user", "current", "AppData", "Roaming", "Dreamtonics", "Synthesizer V Studio 2"); await mkdir(dirname(overlay), { recursive: true });
    if (await exists(overlay)) { const metadata = await lstat(overlay); if (!metadata.isSymbolicLink() || normalizePath(await realpath(overlay)) !== normalizePath(await realpath(slot))) throw new Error("The Sandboxie account-data junction points to an unexpected directory."); }
    else await symlink(slot, overlay, "junction");
    for (const [setting, value] of [["Enabled", "y"], ["FileRootPath", root], ["KeyRootPath", "\\REGISTRY\\USER\\Sandbox_%USER%_%SANDBOX%"], ["IpcRootPath", "\\Sandbox\\%USER%\\%SANDBOX%\\Session_%SESSION%"], ["SeparateUserFolders", "y"], ["AutoRecover", "n"], ["NeverDelete", "y"], ["BoxNameTitle", "-"], ["ConfigLevel", "10"], ["UseFileDeleteV2", "y"], ["UseRegDeleteV2", "y"]]) { const result = await this.run(sandbox.ini, ["set", box, setting, value]); if (result.code !== 0) throw new Error(`Sandboxie configuration failed for ${setting}: ${result.stderr}`); }
    const clear = await this.run(sandbox.ini, ["set", box, "OpenFilePath"]); if (clear.code !== 0) throw new Error(`Sandboxie mapping reset failed: ${clear.stderr}`);
    const mapping = await this.run(sandbox.ini, ["append", box, "OpenFilePath", `${slot}\\`]); if (mapping.code !== 0) throw new Error(`Sandboxie account mapping failed: ${mapping.stderr}`);
    const reload = await this.run(sandbox.start, ["/silent", "/reload"]); if (reload.code !== 0) throw new Error(`Sandboxie configuration reload failed: ${reload.stderr}`);
    const verification = await this.run(sandbox.ini, ["queryex", box, "FileRootPath"]); if (verification.code !== 0 || !normalizePath(verification.stdout).includes(normalizePath(root))) throw new Error("Sandboxie FileRootPath verification failed.");
    await mkdir(join(slot, "sandbox"), { recursive: true }); await writeFile(join(slot, "sandbox", "configured"), JSON.stringify({ box, root, overlay }), "utf8"); return this.profileState();
  }
  async openProfileFolder(slotId: string): Promise<OperationResult> { await this.assertSlot(slotId); await this.reveal(this.slotPath(slotId)); return ok("Profile folder opened."); }

  async readSession(slotId: string): Promise<SessionDocument> { await this.assertSlot(slotId); const path = this.sessionPath(slotId); const content = await this.readSessionCiphertext(path); return { path, sha256: sha256(content), encryptedBytes: content.length, plaintext: "", supported: false, detail: "unsupported: Electron cannot safely decrypt or edit this platform session." }; }
  async writeSession(slotId: string, _plaintext: string, _expectedSha256: string): Promise<never> { await this.assertSlot(slotId); throw new Error("unsupported: Electron cannot safely encrypt and atomically replace this platform session."); }
  async inspectOfflineLicense(slotId: string): Promise<Record<string, unknown>> { await this.assertSlot(slotId); return { slotId, available: false, status: "unsupported", detail: "Electron cannot safely decrypt this platform session." }; }
  async setOfflineLicense(slotId: string, _enabled: boolean): Promise<OperationResult> { await this.assertSlot(slotId); return unavailable("unsupported: Electron cannot safely decrypt and update this platform session."); }

  async previewOfflineSessionReplacement(slotId: string, sourcePath: string): Promise<Record<string, unknown>> { await this.assertSlot(slotId); requireText(sourcePath, "sourcePath"); return { slotId, sourcePath: resolve(sourcePath), status: "unsupported", detail: "Electron cannot safely decrypt and validate either encrypted session." }; }
  async scheduleOfflineSessionReplacement(slotId: string, _sourcePath: string, _sourceSha256: string, _destinationSha256: string): Promise<OperationResult> { await this.assertSlot(slotId); return unavailable("unsupported: Electron cannot safely decrypt and atomically replace this platform session."); }

  async syncProfile(slotId: string, categories: string[]): Promise<Record<string, unknown>> { await this.assertSlot(slotId); if (!Array.isArray(categories) || !categories.every(value => ["settings", "database", "voice"].includes(value))) throw new Error("Unsupported sync category."); for (const category of categories) { const source = join(this.canonicalPath(), category); if (await exists(source)) await cp(source, join(this.slotPath(slotId), category), { recursive: true, force: true }); } return { slotId, categories, succeeded: true }; }
  async previewSelectiveSync(sourceSlotId: string, targetSlotId: string, categories: string[], overwrite: boolean): Promise<Record<string, unknown>> { await this.assertSlot(sourceSlotId); await this.assertSlot(targetSlotId); if (!Array.isArray(categories) || !categories.every(value => ["settings", "database", "voice"].includes(value)) || typeof overwrite !== "boolean") throw new Error("Invalid selective sync request."); const token = randomUUID(); this.syncPreviews.set(token, { targetSlotId, categories }); return { token, sourceSlotId, targetSlotId, categories, overwrite, entries: [] }; }
  async executeSelectiveSync(sourceSlotId: string, targetSlotId: string, categories: string[], token: string): Promise<Record<string, unknown>> { const preview = this.syncPreviews.get(token); if (!preview || preview.targetSlotId !== targetSlotId || JSON.stringify(preview.categories) !== JSON.stringify(categories)) throw new Error("Selective sync preview is no longer valid."); await this.assertSlot(sourceSlotId); for (const category of categories) { const source = join(this.slotPath(sourceSlotId), category); if (await exists(source)) await cp(source, join(this.slotPath(targetSlotId), category), { recursive: true, force: true }); } this.syncPreviews.delete(token); return { sourceSlotId, targetSlotId, categories, succeeded: true }; }
  async previewSvpRoute(projectPath: string): Promise<Record<string, unknown>> { requireText(projectPath, "projectPath"); const store = await this.readStore(); const route = { projectPath, selectedSlotId: store.activeSlotId, mode: "active", executablePath: (await this.scanInstallations()).find(item => item.bridgeProfile === "sv2")?.executablePath ?? null }; this.pendingRoute = route; return route; }
  async launchProfile(slotId: string, projectPath?: string): Promise<OperationResult> { await this.activateProfile(slotId); const executable = (await this.scanInstallations()).find(item => item.bridgeProfile === "sv2")?.executablePath; if (typeof executable !== "string") return unavailable("No SynthV Studio 2 executable was found."); spawn(executable, projectPath ? [projectPath] : [], { detached: true, stdio: "ignore", windowsHide: true }).unref(); return ok("SynthV profile launched."); }
  async launchConcurrentProfile(slotId: string, projectPath?: string): Promise<OperationResult> { await this.prepareConcurrentProfile(slotId); const sandbox = await this.sandboxie(); if (!sandbox) return unavailable("Sandboxie Start.exe and SbieIni.exe were not found."); const executable = (await this.scanInstallations()).find(item => item.bridgeProfile === "sv2")?.executablePath; if (typeof executable !== "string") return unavailable("No SynthV Studio 2 executable was found."); const box = `SV2TB${slotId.replaceAll("-", "").slice(0, 24)}`; const result = await this.run(sandbox.start, [`/box:${box}`, "/silent", executable, ...(projectPath ? [resolve(projectPath)] : [])]); return result.code === 0 ? ok("SynthV profile launched in Sandboxie.") : fail("Sandboxie failed to launch SynthV.", result.stderr); }
  async launchSvpRoute(slotId: string, projectPath: string, _mode: string): Promise<OperationResult> { await this.assertSlot(slotId); requireText(projectPath, "projectPath"); return this.launchProfile(slotId, projectPath); }
  async accountPrecheck(slotId?: string): Promise<Record<string, unknown>> { const state = await this.profileState(); const selected = slotId ?? (state as { activeSlotId?: unknown }).activeSlotId; const slot = typeof selected === "string" ? (state as { slots: Array<{ id: string; installedVoiceIds: string[]; sessionCached: boolean }> }).slots.find(value => value.id === selected) : undefined; const processes = await this.listProcesses().catch(() => []); const localProcesses = processes.filter(process => process.isSv2); const installedVoiceIds = slot?.installedVoiceIds ?? []; const sessionCached = Boolean(slot?.sessionCached); return { supported: true, checkedAtUtc: new Date().toISOString(), slotId: selected, displayName: "", localUse: localProcesses.length > 0, localProcesses, concurrentPids: localProcesses.filter(process => process.sandboxed).map(process => process.processId), remoteUse: "unknown", sessionStatus: sessionCached ? "unknown" : "missing", authorizationStatus: "unknown", authorizedVoiceCount: 0, sessionCached, installedVoiceIds, installedVoiceCount: installedVoiceIds.length, recoveryPending: false, summary: "Local session and installed voice evidence was checked; remote account verification is unknown.", detail: sessionCached ? "An encrypted local session file exists, but Electron cannot decrypt it safely." : "No local encrypted session file was found." }; }
  async voiceCatalog(): Promise<unknown[]> { return readVoiceCatalog([this.canonicalPath()]); }
  async concurrentDefaults(appSettings: boolean, voiceLibraries: boolean): Promise<Record<string, unknown>> { if (typeof appSettings !== "boolean" || typeof voiceLibraries !== "boolean") throw new Error("Concurrent defaults must be booleans."); await this.writeConfig("concurrent-defaults.json", { appSettings, voiceLibraries }); return this.profileState(); }
  async concurrentContent(slotId: string, appSettings: string, voiceLibraries: string): Promise<Record<string, unknown>> { await this.assertSlot(slotId); if (!["on", "off", "global"].includes(appSettings) || !["on", "off", "global"].includes(voiceLibraries)) throw new Error("Invalid concurrent content preference."); await this.writeConfig(`concurrent-${slotId}.json`, { appSettings, voiceLibraries }); return this.profileState(); }
  pendingSvpRoute(): Record<string, unknown> | null { return this.pendingRoute; }
  async openDefaultAppsSettings(): Promise<OperationResult> { const result = platform() === "win32" ? await this.run("explorer.exe", ["ms-settings:defaultapps"]) : platform() === "darwin" ? await this.run("open", ["x-apple.systempreferences:com.apple.preference.general"]) : { code: -1, stdout: "", stderr: "Default applications settings are unsupported on this platform." }; return result.code === 0 ? ok("Default application settings opened.") : fail("Unable to open default application settings.", result.stderr); }
  async connectBridge(): Promise<OperationResult> { await this.ensureBridgeClient(); const status = await this.bridgeClient!.getStatus(); return { succeeded: true, summary: "Bridge transport is ready.", detail: status.connected ? "SynthV Bridge is connected." : status.reason ?? "Waiting for SynthV Bridge." }; }
  async bridgeStatus(): Promise<Record<string, unknown>> { await this.ensureBridgeClient(); const status = await this.bridgeClient!.getStatus(); return { connected: status.connected, sessionToken: status.status?.sessionToken ?? null, requestedProcessId: null, instanceOwnership: "unverified", detail: status.connected ? "SynthV Bridge is connected." : status.reason ?? "SynthV Bridge is unavailable." }; }
  async stopBridge(): Promise<OperationResult> { await this.ensureBridgeClient(); await writeFile(this.bridgeClient!.paths.stopFile, `${Date.now()}\n`, "utf8"); this.bridgeClient = undefined; return ok("Bridge stop requested."); }
  async setAutostart(enabled: boolean): Promise<boolean> { if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean."); if (this.autostart) return this.autostart.set(enabled); await mkdir(this.root, { recursive: true }); await writeFile(join(this.root, "autostart.json"), JSON.stringify({ enabled }), "utf8"); return enabled; }
  async getAutostart(): Promise<{ enabled: boolean; error: string | null }> { if (this.autostart) return this.autostart.get(); try { return { enabled: Boolean(JSON.parse(await readFile(join(this.root, "autostart.json"), "utf8")).enabled), error: null }; } catch { return { enabled: false, error: null }; } }
  async reveal(path: string): Promise<void> { const absolute = resolve(path); if (platform() === "win32") await this.run("explorer.exe", ["/select,", absolute]); else await this.run("open", ["-R", absolute]); }

  private async installBridgeTarget(target: { scriptsPath: string; bridgeProfile: string }): Promise<OperationResult> { this.assertBridgeTarget(target); const script = target.bridgeProfile === "sv1" ? "install-sv1-legacy-bridge.mjs" : "install-synthv-bridge.mjs"; const result = await this.run(process.execPath, [join(this.bridgeDirectory, "scripts", script), target.scriptsPath]); return result.code === 0 ? ok("Bridge installed.") : fail("Bridge installation failed.", result.stderr); }
  private async diagnoseBridgeTarget(target: { scriptsPath: string; bridgeProfile: string }): Promise<OperationResult> { this.assertBridgeTarget(target); const files = target.bridgeProfile === "sv1" ? ["synthv-agent-bridge-sv1.js"] : ["synthv-agent-bridge.js"]; return (await Promise.all(files.map(file => exists(join(target.scriptsPath, file))))).every(Boolean) ? ok("Bridge scripts are installed.") : fail("Bridge scripts are unavailable.", "Expected bridge files are missing."); }
  private assertBridgeTarget(target: { scriptsPath: string; bridgeProfile: string }): void { requireText(target.scriptsPath, "scriptsPath"); if (!bridgeProfiles.has(target.bridgeProfile)) throw new Error("Unsupported Bridge profile."); }
  private async assertProcess(processId: number, identity: string): Promise<void> { if (!Number.isSafeInteger(processId) || processId <= 0 || !identity) throw new Error("Invalid SynthV process target."); if (!(await this.listProcesses()).some(process => process.processId === processId && process.processIdentity === identity)) throw new Error("SynthV process identity changed."); }
  private async assertSlot(slotId: string): Promise<void> { this.slot(await this.readStore(), slotId); }
  private slot(store: ProfileStore, id: string): Slot { if (!isUuid(id)) throw new Error("Invalid profile id."); const slot = store.slots.find(item => item.id === id); if (!slot) throw new Error("Profile was not found."); return slot; }
  private async readStore(): Promise<ProfileStore> { try { const value = JSON.parse(await readFile(this.storePath(), "utf8")); return { activeSlotId: typeof value.activeSlotId === "string" ? value.activeSlotId : null, slots: Array.isArray(value.slots) ? value.slots.filter((slot: unknown): slot is Slot => isSlot(slot)) : [] }; } catch { return { activeSlotId: null, slots: [] }; } }
  private async writeStore(store: ProfileStore): Promise<void> { await mkdir(dirname(this.storePath()), { recursive: true }); await writeFile(this.storePath(), JSON.stringify(store), "utf8"); }
  private canonicalPath(): string { return this.dataRoot; }
  private vaultPath(): string { return `${this.canonicalPath()}.toolbox-slots`; }
  private slotPath(id: string): string { return join(this.vaultPath(), "slots", id); }
  private sessionPath(id: string): string { return join(this.slotPath(id), "license", "session"); }
  private storePath(): string { return join(this.root, "sv2-profiles.json"); }
  private async writeConfig(name: string, value: unknown): Promise<void> { await mkdir(this.root, { recursive: true }); await writeFile(join(this.root, name), JSON.stringify(value), "utf8"); }
  private async readSessionCiphertext(path: string): Promise<Buffer> { return readBoundedRegularFile(path, MAX_SESSION_BYTES, true); }
  private async installedVoiceIds(root: string): Promise<string[]> { return readInstalledVoiceIds(root); }
  private async ensureBridgeClient(): Promise<void> { if (this.bridgeClient) return; const [{ loadConfig }, { FileIpcClient }] = await Promise.all([import(pathToFileURL(join(this.bridgeDirectory, "dist", "src", "config.js")).href), import(pathToFileURL(join(this.bridgeDirectory, "dist", "src", "ipc", "file-ipc-client.js")).href)]); this.bridgeClient = new FileIpcClient(loadConfig()); }
  private async sandboxie(): Promise<{ start: string; ini: string } | null> { if (platform() !== "win32") return null; const roots = [process.env.SANDBOXIE_HOME, process.env.ProgramW6432, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter((value): value is string => typeof value === "string" && value.length > 0).flatMap(root => root.endsWith("Sandboxie") || root.endsWith("Sandboxie-Plus") ? [root] : [join(root, "Sandboxie-Plus"), join(root, "Sandboxie")]); for (const root of roots) { const start = join(root, "Start.exe"); const ini = join(root, "SbieIni.exe"); if (await exists(start) && await exists(ini)) return { start, ini }; } return null; }
  private async run(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> { return this.runner(command, args); }
}

function windowsCandidates() { const base = process.env.ProgramFiles ?? "C:\\Program Files"; const appData = process.env.APPDATA ?? ""; return [candidate("Synthesizer V Studio 2 Pro", join(base, "Dreamtonics", "Synthesizer V Studio 2"), [join(appData, "Dreamtonics", "Synthesizer V Studio 2", "scripts")]), candidate("Synthesizer V Studio Pro", join(base, "Dreamtonics", "Synthesizer V Studio Pro"), [join(appData, "Dreamtonics", "Synthesizer V Studio", "scripts")])]; }
function macCandidates() { return [candidate("Synthesizer V Studio 2 Pro", "/Applications/Synthesizer V Studio 2 Pro.app", [join(homedir(), "Library/Application Support/Dreamtonics/Synthesizer V Studio 2/scripts")]), candidate("Synthesizer V Studio Pro", "/Applications/Synthesizer V Studio Pro.app", [join(homedir(), "Library/Application Support/Dreamtonics/Synthesizer V Studio/scripts")])]; }
function candidate(name: string, root: string, scripts: string[]) { return { name, source: platform() === "win32" ? "Windows standard installation directory" : "macOS Applications", executables: [join(root, "synthv-studio.exe"), join(root, "Contents/MacOS/synthv-studio")], scripts }; }
function bridgeProfile(name: string): string { return name.includes("Studio 2") ? "sv2" : name.includes("Flat") ? "flat" : "sv1"; }
function parseWindowsProcesses(text: string): ProcessInfo[] { const parsed: unknown = JSON.parse(text || "[]"); return (Array.isArray(parsed) ? parsed : [parsed]).flatMap(value => processFrom(String((value as Record<string, unknown>).ProcessId ?? ""), String((value as Record<string, unknown>).Name ?? ""), String((value as Record<string, unknown>).CommandLine ?? ""))); }
function parseMacProcesses(text: string): ProcessInfo[] { return text.split(/\r?\n/).flatMap(line => { const match = line.trim().match(/^(\d+)\s+(\S+)\s*(.*)$/); return match ? processFrom(match[1], basename(match[2]), match[3]) : []; }); }
function processFrom(pidValue: string, name: string, command: string): ProcessInfo[] { const processId = Number(pidValue); if (!Number.isSafeInteger(processId) || !/synthesizer v|synthv/i.test(`${name} ${command}`)) return []; return [{ processId, processIdentity: `${processId}:${sha256(Buffer.from(command)).slice(0, 16)}`, name, productName: name, version: "", command, windowTitle: "", isSv2: /studio 2/i.test(`${name} ${command}`), sandboxed: /sandbox/i.test(command) }]; }
async function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> { return new Promise(resolveResult => { const child = spawn(command, args, { shell: false, windowsHide: true }); let stdout = ""; let stderr = ""; child.stdout?.on("data", chunk => { stdout += String(chunk); }); child.stderr?.on("data", chunk => { stderr += String(chunk); }); child.on("error", error => resolveResult({ stdout, stderr: error.message, code: -1 })); child.on("close", code => resolveResult({ stdout, stderr, code: code ?? -1 })); }); }
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function firstFile(paths: string[]): Promise<string | null> { for (const path of paths) { try { if ((await stat(path)).isFile()) return path; } catch {} } return null; }
async function firstDirectory(paths: string[]): Promise<string | null> { for (const path of paths) { try { if ((await stat(path)).isDirectory()) return path; } catch {} } return null; }
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function normalizePath(value: string): string { return value.trim().replaceAll("/", "\\").replace(/^\\\\\?\\/, "").replace(/[\\]+$/, "").toLowerCase(); }
function requireText(value: string, key: string): void { if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string.`); }
function isUuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isSlot(value: unknown): value is Slot { return typeof value === "object" && value !== null && isUuid((value as Slot).id) && typeof (value as Slot).displayName === "string" && typeof (value as Slot).createdAtUtc === "string" && ((value as Slot).lastActivatedAtUtc === null || typeof (value as Slot).lastActivatedAtUtc === "string"); }
function ok(summary: string): OperationResult { return { succeeded: true, summary, detail: "" }; }
function fail(summary: string, detail: string): OperationResult { return { succeeded: false, summary, detail }; }
function unavailable(detail: string): OperationResult { return fail("This operation is unavailable.", detail); }

function defaultDataRoot(): string {
  return platform() === "win32"
    ? join(process.env.APPDATA ?? homedir(), "Dreamtonics", "Synthesizer V Studio 2")
    : join(homedir(), "Library", "Application Support", "Dreamtonics", "Synthesizer V Studio 2");
}

async function safeDirectory(path: string): Promise<boolean> {
  try { const metadata = await lstat(path); return metadata.isDirectory() && !metadata.isSymbolicLink(); } catch { return false; }
}

async function readBoundedRegularFile(path: string, maximum: number, requireSessionBlockSize = false): Promise<Buffer> {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > maximum || (requireSessionBlockSize && metadata.size % 8 !== 0)) throw new Error("Session file has an unsafe type or size.");
  const bytes = await readFile(path);
  if (bytes.length !== metadata.size || bytes.length > maximum || (requireSessionBlockSize && bytes.length % 8 !== 0)) throw new Error("Session file changed while being read.");
  return bytes;
}

function voiceId(path: string): string | null {
  const value = basename(path).replace(/\.(json|png)$/i, "").toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ? value : null;
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized && [...normalized].length <= 160 ? normalized : null;
}

function boundedPng(bytes: Buffer): boolean {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.subarray(12, 16).toString("ascii") !== "IHDR") return false;
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  return width > 0 && width <= 2048 && height > 0 && height <= 2048;
}

async function readVoiceCatalog(roots: string[]): Promise<Array<Record<string, string | null>>> {
  const directories: string[] = [];
  for (const root of roots) { const databases = join(root, "databases"); const metadata = join(databases, "meta"); if (await safeDirectory(root) && await safeDirectory(databases) && await safeDirectory(metadata)) directories.push(metadata); }
  const voices = new Map<string, { id: string; name: string | null; vendor: string | null; imageDataUrl: string | null }>();
  for (const directory of directories) {
    const entries = (await readdir(directory, { withFileTypes: true }).catch(() => [])).slice(0, MAX_VOICES * 4).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/\.(json|png)$/i.test(entry.name)) continue;
      const id = voiceId(entry.name); if (!id || (voices.size >= MAX_VOICES && !voices.has(id))) continue;
      const current = voices.get(id) ?? { id, name: null, vendor: null, imageDataUrl: null };
      if (entry.name.endsWith(".json") && current.name === null) {
        try { const data = JSON.parse((await readBoundedRegularFile(join(directory, entry.name), MAX_METADATA_BYTES)).toString("utf8")) as { name?: unknown; vendor?: unknown }; const name = normalizedText(data.name); if (name) voices.set(id, { ...current, name, vendor: normalizedText(data.vendor) }); } catch {}
      } else if (entry.name.endsWith(".png")) voices.set(id, current);
    }
  }
  let imageBytes = 0;
  for (const voice of voices.values()) for (const directory of directories) {
    try { const image = await readBoundedRegularFile(join(directory, `${voice.id}.png`), MAX_IMAGE_BYTES); if (boundedPng(image) && imageBytes + image.length <= MAX_CATALOG_IMAGE_BYTES) { voice.imageDataUrl = `data:image/png;base64,${image.toString("base64")}`; imageBytes += image.length; break; } } catch {}
  }
  return [...voices.values()].filter(voice => voice.name || voice.imageDataUrl).sort((a, b) => (a.name === null ? 1 : 0) - (b.name === null ? 1 : 0) || (a.name ?? "").localeCompare(b.name ?? "") || a.id.localeCompare(b.id));
}

async function readInstalledVoiceIds(root: string): Promise<string[]> {
  const database = join(root, "databases"); if (!(await safeDirectory(root)) || !(await safeDirectory(database))) return [];
  const ids: string[] = [];
  for (const entry of (await readdir(database, { withFileTypes: true }).catch(() => [])).slice(0, MAX_VOICES * 4).sort((a, b) => a.name.localeCompare(b.name))) {
    const id = entry.isDirectory() && !entry.isSymbolicLink() ? voiceId(entry.name) : null; if (!id || ids.length >= MAX_VOICES) continue;
    if (await hasInstalledVoice(join(database, entry.name))) ids.push(id);
  }
  return ids;
}

async function hasInstalledVoice(productDirectory: string): Promise<boolean> {
  for (const variant of (await readdir(productDirectory, { withFileTypes: true }).catch(() => [])).slice(0, 32)) {
    if (!variant.isDirectory() || variant.isSymbolicLink()) continue;
    let manifest = false; let model = false;
    for (const file of (await readdir(join(productDirectory, variant.name), { withFileTypes: true }).catch(() => [])).slice(0, 256)) {
      if (!file.isFile() || file.isSymbolicLink()) continue;
      const path = join(productDirectory, variant.name, file.name); const metadata = await lstat(path).catch(() => null);
      if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size === 0) continue;
      manifest ||= file.name === "m"; model ||= file.name.toLowerCase().endsWith(".dnni"); if (manifest && model) return true;
    }
  }
  return false;
}
