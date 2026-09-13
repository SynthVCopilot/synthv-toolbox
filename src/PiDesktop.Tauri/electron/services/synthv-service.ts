import { createHash, randomUUID } from "node:crypto";
import { access, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

export class SynthVService {
  private pendingRoute: Record<string, unknown> | null = null;
  private readonly syncPreviews = new Map<string, { targetSlotId: string; categories: string[] }>();
  private bridgeClient?: { getStatus(): Promise<{ connected: boolean; status?: { sessionToken?: string }; reason?: string }>; paths: { stopFile: string } };
  constructor(private readonly root: string, private readonly bridgeDirectory: string, private readonly runner: Runner = runCommand) {}

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
    else await this.run("osascript", ["-e", "tell application \"System Events\" to key code 122", key]);
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
    const slots = await Promise.all(store.slots.map(async slot => ({ ...slot, isActive: slot.id === store.activeSlotId, dataPath: this.slotPath(slot.id), sessionCached: await exists(this.sessionPath(slot.id)), installedVoiceIds: [] })));
    return { supported: platform() === "win32" || platform() === "darwin", canonicalPath: this.canonicalPath(), vaultPath: this.vaultPath(), activeSlotId: store.activeSlotId, canonicalRootExists: await exists(this.canonicalPath()), canImportCurrent: await exists(this.canonicalPath()), recoveryRequired: false, recoveryDetail: "", slots, blockers: [], concurrentProvider: { available: false, name: "", edition: "", version: "", installPath: "", detail: "Sandbox provider discovery is unavailable." }, concurrentDefaults: { appSettings: false, voiceLibraries: false } };
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

  async prepareConcurrentProfile(slotId: string): Promise<Record<string, unknown>> { const store = await this.readStore(); this.slot(store, slotId); await mkdir(join(this.slotPath(slotId), "sandbox"), { recursive: true }); return this.profileState(); }
  async openProfileFolder(slotId: string): Promise<OperationResult> { await this.assertSlot(slotId); await this.reveal(this.slotPath(slotId)); return ok("Profile folder opened."); }

  async readSession(slotId: string): Promise<{ path: string; sha256: string; plaintext: string }> { await this.assertSlot(slotId); const path = this.sessionPath(slotId); const content = await readFile(path); return { path, sha256: sha256(content), plaintext: content.toString("utf8") }; }
  async writeSession(slotId: string, plaintext: string, expectedSha256: string): Promise<{ path: string; sha256: string }> { await this.assertSlot(slotId); requireText(plaintext, "plaintext"); const path = this.sessionPath(slotId); if (await exists(path) && sha256(await readFile(path)) !== expectedSha256) throw new Error("Session changed before write."); await mkdir(dirname(path), { recursive: true }); await writeFile(path, plaintext, "utf8"); return { path, sha256: sha256(Buffer.from(plaintext)) }; }
  async inspectOfflineLicense(slotId: string): Promise<Record<string, unknown>> { const session = await this.readSession(slotId); return { slotId, available: session.plaintext.includes("offline"), sha256: session.sha256 }; }
  async setOfflineLicense(slotId: string, enabled: boolean): Promise<OperationResult> { const session = await this.readSession(slotId); const value = session.plaintext.replace(/^offline-license=.*$/m, `offline-license=${enabled}`); await this.writeSession(slotId, value, session.sha256); return ok(enabled ? "Offline license enabled." : "Offline license disabled."); }

  async previewOfflineSessionReplacement(slotId: string, sourcePath: string): Promise<Record<string, unknown>> { await this.assertSlot(slotId); requireText(sourcePath, "sourcePath"); const source = await readFile(resolve(sourcePath)); const destination = await readFile(this.sessionPath(slotId)); return { slotId, sourcePath: resolve(sourcePath), sourceSha256: sha256(source), destinationSha256: sha256(destination), sourceBytes: source.length, destinationBytes: destination.length }; }
  async scheduleOfflineSessionReplacement(slotId: string, sourcePath: string, sourceSha256: string, destinationSha256: string): Promise<OperationResult> { const preview = await this.previewOfflineSessionReplacement(slotId, sourcePath); if (preview.sourceSha256 !== sourceSha256 || preview.destinationSha256 !== destinationSha256) throw new Error("Offline session replacement hashes do not match the preview."); await writeFile(this.sessionPath(slotId), await readFile(resolve(sourcePath))); return ok("Offline session replaced."); }

  async syncProfile(slotId: string, categories: string[]): Promise<Record<string, unknown>> { await this.assertSlot(slotId); if (!Array.isArray(categories) || !categories.every(value => ["settings", "database", "voice"].includes(value))) throw new Error("Unsupported sync category."); for (const category of categories) { const source = join(this.canonicalPath(), category); if (await exists(source)) await cp(source, join(this.slotPath(slotId), category), { recursive: true, force: true }); } return { slotId, categories, succeeded: true }; }
  async previewSelectiveSync(sourceSlotId: string, targetSlotId: string, categories: string[], overwrite: boolean): Promise<Record<string, unknown>> { await this.assertSlot(sourceSlotId); await this.assertSlot(targetSlotId); if (!Array.isArray(categories) || !categories.every(value => ["settings", "database", "voice"].includes(value)) || typeof overwrite !== "boolean") throw new Error("Invalid selective sync request."); const token = randomUUID(); this.syncPreviews.set(token, { targetSlotId, categories }); return { token, sourceSlotId, targetSlotId, categories, overwrite, entries: [] }; }
  async executeSelectiveSync(sourceSlotId: string, targetSlotId: string, categories: string[], token: string): Promise<Record<string, unknown>> { const preview = this.syncPreviews.get(token); if (!preview || preview.targetSlotId !== targetSlotId || JSON.stringify(preview.categories) !== JSON.stringify(categories)) throw new Error("Selective sync preview is no longer valid."); await this.assertSlot(sourceSlotId); for (const category of categories) { const source = join(this.slotPath(sourceSlotId), category); if (await exists(source)) await cp(source, join(this.slotPath(targetSlotId), category), { recursive: true, force: true }); } this.syncPreviews.delete(token); return { sourceSlotId, targetSlotId, categories, succeeded: true }; }
  async previewSvpRoute(projectPath: string): Promise<Record<string, unknown>> { requireText(projectPath, "projectPath"); const store = await this.readStore(); const route = { projectPath, selectedSlotId: store.activeSlotId, mode: "active", executablePath: (await this.scanInstallations()).find(item => item.bridgeProfile === "sv2")?.executablePath ?? null }; this.pendingRoute = route; return route; }
  async launchProfile(slotId: string, projectPath?: string): Promise<OperationResult> { await this.activateProfile(slotId); const executable = (await this.scanInstallations()).find(item => item.bridgeProfile === "sv2")?.executablePath; if (typeof executable !== "string") return unavailable("No SynthV Studio 2 executable was found."); spawn(executable, projectPath ? [projectPath] : [], { detached: true, stdio: "ignore", windowsHide: true }).unref(); return ok("SynthV profile launched."); }
  async launchConcurrentProfile(slotId: string, _projectPath?: string): Promise<OperationResult> { await this.prepareConcurrentProfile(slotId); return unavailable("Concurrent sandbox launch requires a configured sandbox provider."); }
  async launchSvpRoute(slotId: string, projectPath: string, _mode: string): Promise<OperationResult> { await this.assertSlot(slotId); requireText(projectPath, "projectPath"); return this.launchProfile(slotId, projectPath); }
  async accountPrecheck(slotId?: string): Promise<Record<string, unknown>> { const state = await this.profileState(); const selected = slotId ?? (state as { activeSlotId?: unknown }).activeSlotId; return { supported: true, checkedAtUtc: new Date().toISOString(), slotId: selected, localUse: false, localProcesses: [], concurrentPids: [], remoteUse: "unknown", sessionStatus: selected ? ((await this.readSession(String(selected)).catch(() => null)) ? "ready" : "missing") : "missing", authorizationStatus: "unknown", authorizedVoiceCount: 0, sessionCached: false, recoveryPending: false, summary: "Local profile state was checked; remote account probing is unavailable.", detail: "" }; }
  async voiceCatalog(): Promise<unknown[]> { return []; }
  async concurrentDefaults(appSettings: boolean, voiceLibraries: boolean): Promise<Record<string, unknown>> { if (typeof appSettings !== "boolean" || typeof voiceLibraries !== "boolean") throw new Error("Concurrent defaults must be booleans."); await this.writeConfig("concurrent-defaults.json", { appSettings, voiceLibraries }); return this.profileState(); }
  async concurrentContent(slotId: string, appSettings: string, voiceLibraries: string): Promise<Record<string, unknown>> { await this.assertSlot(slotId); if (!["on", "off", "global"].includes(appSettings) || !["on", "off", "global"].includes(voiceLibraries)) throw new Error("Invalid concurrent content preference."); await this.writeConfig(`concurrent-${slotId}.json`, { appSettings, voiceLibraries }); return this.profileState(); }
  pendingSvpRoute(): Record<string, unknown> | null { return this.pendingRoute; }
  async openDefaultAppsSettings(): Promise<OperationResult> { if (platform() === "win32") await this.run("explorer.exe", ["ms-settings:defaultapps"]); else await this.run("open", ["x-apple.systempreferences:com.apple.preference.general"]); return ok("Default application settings opened."); }
  async connectBridge(): Promise<OperationResult> { await this.ensureBridgeClient(); const status = await this.bridgeClient!.getStatus(); return { succeeded: true, summary: "Bridge transport is ready.", detail: status.connected ? "SynthV Bridge is connected." : status.reason ?? "Waiting for SynthV Bridge." }; }
  async bridgeStatus(): Promise<Record<string, unknown>> { await this.ensureBridgeClient(); const status = await this.bridgeClient!.getStatus(); return { connected: status.connected, sessionToken: status.status?.sessionToken ?? null, requestedProcessId: null, instanceOwnership: "unverified", detail: status.connected ? "SynthV Bridge is connected." : status.reason ?? "SynthV Bridge is unavailable." }; }
  async stopBridge(): Promise<OperationResult> { await this.ensureBridgeClient(); await writeFile(this.bridgeClient!.paths.stopFile, `${Date.now()}\n`, "utf8"); this.bridgeClient = undefined; return ok("Bridge stop requested."); }
  async setAutostart(enabled: boolean): Promise<boolean> { if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean."); await mkdir(this.root, { recursive: true }); await writeFile(join(this.root, "autostart.json"), JSON.stringify({ enabled }), "utf8"); return enabled; }
  async getAutostart(): Promise<{ enabled: boolean; error: null }> { try { return { enabled: Boolean(JSON.parse(await readFile(join(this.root, "autostart.json"), "utf8")).enabled), error: null }; } catch { return { enabled: false, error: null }; } }
  async reveal(path: string): Promise<void> { const absolute = resolve(path); if (platform() === "win32") await this.run("explorer.exe", ["/select,", absolute]); else await this.run("open", ["-R", absolute]); }

  private async installBridgeTarget(target: { scriptsPath: string; bridgeProfile: string }): Promise<OperationResult> { this.assertBridgeTarget(target); const script = target.bridgeProfile === "sv1" ? "install-sv1-legacy-bridge.mjs" : "install-synthv-bridge.mjs"; const result = await this.run(process.execPath, [join(this.bridgeDirectory, "scripts", script), target.scriptsPath]); return result.code === 0 ? ok("Bridge installed.") : fail("Bridge installation failed.", result.stderr); }
  private async diagnoseBridgeTarget(target: { scriptsPath: string; bridgeProfile: string }): Promise<OperationResult> { this.assertBridgeTarget(target); const files = target.bridgeProfile === "sv1" ? ["synthv-agent-bridge-sv1.js"] : ["synthv-agent-bridge.js"]; return (await Promise.all(files.map(file => exists(join(target.scriptsPath, file))))).every(Boolean) ? ok("Bridge scripts are installed.") : fail("Bridge scripts are unavailable.", "Expected bridge files are missing."); }
  private assertBridgeTarget(target: { scriptsPath: string; bridgeProfile: string }): void { requireText(target.scriptsPath, "scriptsPath"); if (!bridgeProfiles.has(target.bridgeProfile)) throw new Error("Unsupported Bridge profile."); }
  private async assertProcess(processId: number, identity: string): Promise<void> { if (!Number.isSafeInteger(processId) || processId <= 0 || !identity) throw new Error("Invalid SynthV process target."); if (!(await this.listProcesses()).some(process => process.processId === processId && process.processIdentity === identity)) throw new Error("SynthV process identity changed."); }
  private async assertSlot(slotId: string): Promise<void> { this.slot(await this.readStore(), slotId); }
  private slot(store: ProfileStore, id: string): Slot { if (!isUuid(id)) throw new Error("Invalid profile id."); const slot = store.slots.find(item => item.id === id); if (!slot) throw new Error("Profile was not found."); return slot; }
  private async readStore(): Promise<ProfileStore> { try { const value = JSON.parse(await readFile(this.storePath(), "utf8")); return { activeSlotId: typeof value.activeSlotId === "string" ? value.activeSlotId : null, slots: Array.isArray(value.slots) ? value.slots.filter((slot: unknown): slot is Slot => isSlot(slot)) : [] }; } catch { return { activeSlotId: null, slots: [] }; } }
  private async writeStore(store: ProfileStore): Promise<void> { await mkdir(dirname(this.storePath()), { recursive: true }); await writeFile(this.storePath(), JSON.stringify(store), "utf8"); }
  private canonicalPath(): string { return platform() === "win32" ? join(process.env.APPDATA ?? this.root, "Dreamtonics", "Synthesizer V Studio 2") : join(homedir(), "Library", "Application Support", "Dreamtonics", "Synthesizer V Studio 2"); }
  private vaultPath(): string { return `${this.canonicalPath()}.toolbox-slots`; }
  private slotPath(id: string): string { return join(this.vaultPath(), "slots", id); }
  private sessionPath(id: string): string { return join(this.slotPath(id), "license", "session"); }
  private storePath(): string { return join(this.root, "sv2-profiles.json"); }
  private async writeConfig(name: string, value: unknown): Promise<void> { await mkdir(this.root, { recursive: true }); await writeFile(join(this.root, name), JSON.stringify(value), "utf8"); }
  private async ensureBridgeClient(): Promise<void> { if (this.bridgeClient) return; const [{ loadConfig }, { FileIpcClient }] = await Promise.all([import(pathToFileURL(join(this.bridgeDirectory, "dist", "src", "config.js")).href), import(pathToFileURL(join(this.bridgeDirectory, "dist", "src", "ipc", "file-ipc-client.js")).href)]); this.bridgeClient = new FileIpcClient(loadConfig()); }
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
function requireText(value: string, key: string): void { if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string.`); }
function isUuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isSlot(value: unknown): value is Slot { return typeof value === "object" && value !== null && isUuid((value as Slot).id) && typeof (value as Slot).displayName === "string" && typeof (value as Slot).createdAtUtc === "string" && ((value as Slot).lastActivatedAtUtc === null || typeof (value as Slot).lastActivatedAtUtc === "string"); }
function ok(summary: string): OperationResult { return { succeeded: true, summary, detail: "" }; }
function fail(summary: string, detail: string): OperationResult { return { succeeded: false, summary, detail }; }
function unavailable(detail: string): OperationResult { return fail("This operation is unavailable.", detail); }
