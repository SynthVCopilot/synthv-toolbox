import { createHash, randomUUID } from "node:crypto";
import { access, cp, lstat, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { EmbeddedBridge } from "./synthv-bridge.js";
const bridgeProfiles = new Set(["sv2", "sv1", "flat"]);
const shortcutActions = new Set(["start", "startLegacy", "stop", "save", "undo", "refresh"]);

export type OperationResult = { succeeded: boolean; summary: string; detail: string };
export type ProcessInfo = { processId: number; processIdentity: string; name: string; productName: string; version: string; command: string; windowTitle: string; isSv2: boolean; sandboxed: boolean | null };
export const SESSION_OFFLINE_THRESHOLD_BYTES = 4096;
export type SessionSizeInspection = { status: "offline" | "online" | "unknown"; sizeBytes: number | null };
export async function inspectSessionSize(filePath: string): Promise<SessionSizeInspection> {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) return { status: "unknown", sizeBytes: null };
    return { status: metadata.size > SESSION_OFFLINE_THRESHOLD_BYTES ? "offline" : "online", sizeBytes: metadata.size };
  } catch {
    return { status: "unknown", sizeBytes: null };
  }
}
type RunOptions = { visible?: boolean };
type Runner = (command: string, args: string[], env?: NodeJS.ProcessEnv, options?: RunOptions) => Promise<{ stdout: string; stderr: string; code: number }>;
type Slot = { id: string; displayName: string; createdAtUtc: string; lastActivatedAtUtc: string | null };
type ProfileStore = { activeSlotId: string | null; slots: Slot[] };
export type AutostartController = {
  set(enabled: boolean): Promise<boolean>;
  get(): Promise<{ enabled: boolean; error: string | null }>;
};

export class SynthVService {
  private pendingRoute: Record<string, unknown> | null = null;
  private readonly syncPreviews = new Map<string, { sourceSlotId: string; targetSlotId: string; categories: string[] }>();
  // One chain for everything that rewrites the store, a slot or the official folder: two overlapping switches would each save the official folder over the slot they both read as active.
  private slotLock: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string, private readonly bridgeDirectory: string, private readonly bridge: Pick<EmbeddedBridge, "status" | "requestStop">, private readonly bridgeIpcDirectory: string, private readonly runner: Runner = runCommand, private readonly autostart?: AutostartController, private readonly platformDataRoot?: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async sessionSize(slotId: string): Promise<SessionSizeInspection> { const store = await this.readStore(); this.slot(store, slotId); return inspectSessionSize(this.sessionPath(slotId, store.activeSlotId === slotId)); }

  async scanInstallations(knownRows?: WindowsProcessRow[]): Promise<Array<Record<string, unknown>>> {
    const win = platform() === "win32";
    const candidates = win ? windowsCandidates(this.dataRoot(), this.env) : macCandidates(this.dataRoot());
    const found: Array<Record<string, unknown>> = [];
    for (const candidate of candidates) {
      const executable = await firstFile(candidate.executables);
      const scriptsPath = await firstDirectory(candidate.scripts);
      if (!executable && !scriptsPath) continue;
      found.push({ displayName: candidate.name, installPath: executable ? dirname(executable) : null, executablePath: executable, scriptsPath, source: candidate.source, bridgeProfile: bridgeProfile(candidate.name) });
    }
    if (win) {
      found.push(...await this.registeredInstallations());
      const rows = knownRows ?? await this.windowsProcessRows().catch(() => []);
      for (const row of rows) {
        const executable = windowsRowExecutable(row);
        const kind = executable ? windowsProcessKind(executable) : null;
        if (!executable || !kind) continue;
        found.push({ displayName: kind === "flat" ? "Synthesizer V Studio Flat" : kind === "sv2" ? "Synthesizer V Studio 2" : "Synthesizer V Studio", installPath: windowsDirname(executable), executablePath: executable, scriptsPath: null, source: "Windows running process", bridgeProfile: kind });
      }
      if (found.some(item => item.bridgeProfile === "flat" && item.installPath)) {
        for (const scriptsPath of windowsFlatScriptCandidates(this.env)) if (await firstDirectory([scriptsPath])) found.push({ displayName: "Synthesizer V Studio Flat", installPath: null, executablePath: null, scriptsPath, source: "Windows Flat scripts directory", bridgeProfile: "flat" });
      }
    }
    const seen = new Set<string>();
    return found.filter(item => { const key = [item.executablePath, item.installPath, item.scriptsPath].map(value => typeof value === "string" ? normalizePath(value) : "").join("|"); if (seen.has(key)) return false; seen.add(key); return true; })
      .sort((left, right) => String(left.displayName).localeCompare(String(right.displayName)));
  }

  private async registeredInstallations(): Promise<Array<Record<string, unknown>>> {
    const result = await this.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_UNINSTALL_QUERY]).catch(() => null);
    if (!result || result.code !== 0) return [];
    const found: Array<Record<string, unknown>> = [];
    for (const entry of parseJsonRows(result.stdout)) {
      const displayName = String(entry.DisplayName ?? "");
      if (!isSynthVHostDisplayName(displayName)) continue;
      for (const directory of registeredInstallDirectories(String(entry.InstallLocation ?? ""), String(entry.DisplayIcon ?? ""))) {
        const executable = await firstFile(windowsExecutableNames.map(name => join(directory, name)));
        if (!executable) continue;
        found.push({ displayName, installPath: dirname(executable), executablePath: executable, scriptsPath: null, source: "Windows installed application", bridgeProfile: bridgeProfile(displayName) });
        break;
      }
    }
    return found;
  }

  private async windowsProcessRows(): Promise<WindowsProcessRow[]> {
    const result = await this.runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_QUERY]);
    if (result.code !== 0) throw new Error(result.stderr || "Unable to enumerate SynthV processes.");
    return parseJsonRows(result.stdout).map(row => ({ processId: Number(row.ProcessId), parentProcessId: Number(row.ParentProcessId ?? 0), name: String(row.Name ?? ""), commandLine: String(row.CommandLine ?? ""), executablePath: String(row.ExecutablePath ?? "") }));
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    if (platform() !== "win32") {
      const result = await this.runner("ps", ["-axo", "pid=,comm=,args="]);
      if (result.code !== 0) throw new Error(result.stderr || "Unable to enumerate SynthV processes.");
      return parseMacProcesses(result.stdout);
    }
    const rows = await this.windowsProcessRows();
    const candidates = rows.flatMap(row => {
      const executable = windowsRowExecutable(row);
      return windowsRowIsHost(row, executable) ? processFrom(String(row.processId), row.name, row.commandLine || executable).map(info => ({ info, executable })) : [];
    });
    const installations = (await this.scanInstallations(rows)) as unknown as Installation[];
    const matched = matchProcessesToInstallations(candidates.map(item => ({ processId: item.info.processId, executablePath: item.executable })), installations);
    return candidates.map(({ info, executable }) => {
      const install = matched.get(info.processId);
      const kind = install ? install.bridgeProfile : executable ? windowsProcessKind(executable) : null;
      return { ...info, isSv2: kind ? kind === "sv2" : info.isSv2 };
    });
  }

  async focusInstance(processId: number, processIdentity: string): Promise<OperationResult> {
    await this.assertProcess(processId, processIdentity);
    if (platform() === "win32") await this.deliverWindowsKeys(processId, [], 0);
    else {
      const result = await this.run("osascript", ["-e", "on run argv\nset pidValue to item 1 of argv\ntell application \"System Events\" to set frontmost of first process whose unix id is (pidValue as integer) to true\nend run", String(processId)]);
      if (result.code !== 0) throw new Error(result.stderr || "Unable to focus the selected SynthV instance.");
    }
    return ok("SynthV instance focused.");
  }

  async terminateInstance(processId: number, processIdentity: string): Promise<OperationResult> {
    await this.assertProcess(processId, processIdentity);
    await this.run(platform() === "win32" ? "taskkill.exe" : "kill", platform() === "win32" ? ["/PID", String(processId), "/T", "/F"] : ["-TERM", String(processId)]);
    return ok("SynthV instance terminated.");
  }

  async sendShortcut(processId: number, processIdentity: string, action: string): Promise<OperationResult> {
    if (!shortcutActions.has(action)) throw new Error("Unsupported SynthV shortcut action.");
    const target = await this.verifiedProcess(processId, processIdentity);
    if (platform() === "win32") {
      await this.deliverWindowsKeys(processId, windowsShortcutKeys(action, target.isSv2), windowsPostableKey(action, target.isSv2));
      return ok("SynthV shortcut sent.");
    }
    await this.focusInstance(processId, processIdentity);
    const macKey = ({ start: "key code 105", startLegacy: "key code 105", stop: "key code 107", save: 'keystroke "s" using command down', undo: 'keystroke "z" using command down', refresh: "key code 96" } as Record<string, string>)[action];
    const result = await this.run("osascript", ["-e", `tell application "System Events" to ${macKey}`]);
    if (result.code !== 0) throw new Error(result.stderr || "The operating system did not send the SynthV shortcut.");
    return ok("SynthV shortcut sent.");
  }

  async autoConnectBridge(processId: number, processIdentity: string): Promise<OperationResult> {
    const target = await this.verifiedProcess(processId, processIdentity);
    const plan = bridgeStartPlan(target.isSv2);
    if (plan.refreshFirst) { await this.sendShortcut(processId, processIdentity, "refresh"); await delay(plan.refreshSettleMs); }
    await this.sendShortcut(processId, processIdentity, "start");
    for (let attempt = 0; attempt < BRIDGE_CONNECT_ATTEMPTS; attempt += 1) {
      if ((await this.bridge.status()).connected) return ok("SynthV Bridge is connected.");
      await delay(BRIDGE_CONNECT_INTERVAL_MS);
    }
    return fail("SynthV Bridge did not connect.", "The start shortcut was delivered but the bridge wrote no fresh heartbeat within 4 seconds.");
  }

  private async deliverWindowsKeys(processId: number, keys: number[], postKey: number): Promise<void> {
    const ids = windowTargetProcessIds(processId, await this.windowsProcessRows());
    if (ids.length === 0) throw new Error("No Flat editor child process was found.");
    const result = await this.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `& { ${WINDOWS_KEY_SCRIPT} } '${ids.join(",")}' '${keys.join(",")}' ${postKey}`]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "The operating system did not deliver the SynthV shortcut.");
  }

  private async verifiedProcess(processId: number, identity: string): Promise<ProcessInfo> {
    if (!Number.isSafeInteger(processId) || processId <= 0 || !identity) throw new Error("Invalid SynthV process target.");
    const found = (await this.listProcesses()).find(process => process.processId === processId && process.processIdentity === identity);
    if (!found) throw new Error("SynthV process identity changed.");
    return found;
  }

  shortcutProfile(): Record<string, string> { return { bridgeStart: platform() === "win32" ? "F13 / Ctrl+Alt+Shift+B (SV2)" : "F13", bridgeStop: platform() === "win32" ? "F14 / Ctrl+Alt+Shift+N (SV2)" : "F14", projectSave: platform() === "darwin" ? "⌘S" : "Ctrl+S", detail: "Shortcuts are sent only after the selected SynthV process identity is verified." }; }

  async installBridge(targets: Array<{ scriptsPath: string; bridgeProfile: string }>): Promise<Array<Record<string, unknown>>> {
    return Promise.all(targets.map(async target => ({ scriptsPath: target.scriptsPath, bridgeProfile: target.bridgeProfile, result: await this.installBridgeTarget(target) })));
  }

  async diagnoseBridge(targets: Array<{ scriptsPath: string; bridgeProfile: string }>): Promise<Array<Record<string, unknown>>> {
    return Promise.all(targets.map(async target => ({ scriptsPath: target.scriptsPath, bridgeProfile: target.bridgeProfile, result: await this.diagnoseBridgeTarget(target) })));
  }

  async profileState(): Promise<Record<string, unknown>> {
    const store = await this.readStore(), canonical = await exists(this.canonicalPath());
    const slots = await Promise.all(store.slots.map(async slot => {
      const isActive = slot.id === store.activeSlotId;
      const sessionSize = await inspectSessionSize(this.sessionPath(slot.id, isActive));
      const sessionCached = sessionSize.sizeBytes !== null;
      const accountProbe = { sessionStatus: sessionCached ? "ready" : "missing", checkedAtUtc: new Date().toISOString(), detail: "" };
      const protection = { status: sessionCached ? "ready" : "signInRequired", snapshotAvailable: false, detail: "" };
      const isolatedRoot = join(this.vaultPath(), "instances", slot.id.replaceAll("-", "").slice(0, 16));
      const isolatedDataPath = join(isolatedRoot, "user", "current", "AppData", "Roaming", "Dreamtonics", "Synthesizer V Studio 2");
      return { ...slot, color: "#6D5CE7", isActive, dataPath: isActive && canonical ? this.canonicalPath() : this.slotPath(slot.id), sessionCached, sessionSize, installedVoiceIds: [], accountProbe, concurrentAccountProbe: accountProbe, sessionProtection: protection, concurrentSessionProtection: protection, concurrent: { ready: await exists(isolatedDataPath), dataPath: isolatedDataPath, runningPids: [], detail: "", content: { appSettings: "global", voiceLibraries: "global", effectiveAppSettings: false, effectiveVoiceLibraries: false } } };
    }));
    const sandbox = await this.sandboxie();
    return { supported: platform() === "win32" || platform() === "darwin", canonicalPath: this.canonicalPath(), vaultPath: this.vaultPath(), activeSlotId: store.activeSlotId, canonicalRootExists: await exists(this.canonicalPath()), canImportCurrent: await exists(this.canonicalPath()), recoveryRequired: false, recoveryDetail: "", slots, blockers: [], concurrentProvider: sandbox ? { available: true, name: "Sandboxie", edition: "", version: "", installPath: dirname(sandbox.start), detail: "Sandboxie launch tools were found; a configured isolated box is required." } : { available: false, name: "Sandboxie", edition: "", version: "", installPath: "", detail: "Sandboxie Start.exe and SbieIni.exe were not found." }, concurrentDefaults: { appSettings: false, voiceLibraries: false } };
  }

  async createProfile(displayName: string): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      requireText(displayName, "displayName");
      const store = await this.readStore();
      const slot: Slot = { id: randomUUID(), displayName, createdAtUtc: new Date().toISOString(), lastActivatedAtUtc: null };
      await mkdir(this.slotPath(slot.id), { recursive: true });
      store.slots.push(slot);
      await this.writeStore(store);
      return this.profileState();
    });
  }

  async importCurrentProfile(displayName: string): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      requireText(displayName, "displayName"); const canonical = this.canonicalPath();
      const running = await this.runningSv2(); if (running.length) throw sv2RunningError(running, "importing its current data");
      if (!(await exists(canonical))) throw new Error("No current Synthesizer V Studio 2 data was found to import.");
      const store = await this.readStore(); const now = new Date().toISOString(); const slot: Slot = { id: randomUUID(), displayName, createdAtUtc: now, lastActivatedAtUtc: now };
      const previous = this.activeSlotId(store); if (previous) await replaceDirectory(canonical, this.slotPath(previous));
      await replaceDirectory(canonical, this.slotPath(slot.id));
      store.slots.push(slot); store.activeSlotId = slot.id; await this.writeStore(store); return this.profileState();
    });
  }

  async renameProfile(slotId: string, displayName: string): Promise<Record<string, unknown>> { return this.exclusive(async () => { const store = await this.readStore(); const slot = this.slot(store, slotId); requireText(displayName, "displayName"); slot.displayName = displayName; await this.writeStore(store); return this.profileState(); }); }
  async deleteProfile(slotId: string): Promise<Record<string, unknown>> { return this.exclusive(async () => { const store = await this.readStore(); this.slot(store, slotId); if (store.activeSlotId === slotId) throw new Error("The active profile cannot be deleted."); store.slots = store.slots.filter(slot => slot.id !== slotId); await rm(this.slotPath(slotId), { recursive: true, force: true }); await this.writeStore(store); return this.profileState(); }); }

  async activateProfile(slotId: string): Promise<Record<string, unknown>> { return this.exclusive(() => this.switchTo(slotId)); }
  private async switchTo(slotId: string): Promise<Record<string, unknown>> {
    const store = await this.readStore(); const slot = this.slot(store, slotId); const canonical = this.canonicalPath(); const target = this.slotPath(slotId);
    const previous = this.activeSlotId(store); const hasCanonical = await exists(canonical); const replace = previous !== slotId || !hasCanonical;
    // A running SV2 owns canonical, so re-activating its own slot touches neither copy and the next switch saves it. That path replaces nothing, so a failed scan counts as running there instead of blocking a normal launch.
    const running = await this.runningSv2().catch((error: unknown) => { if (replace) throw error; return null; });
    if (running?.length && replace) throw sv2RunningError(running, "switching account slots");
    if (replace && !(await exists(target))) throw new Error("The profile data folder was not found.");
    if (running?.length === 0 && hasCanonical && previous) await replaceDirectory(canonical, this.slotPath(previous));
    if (replace) {
      // Cleared while canonical is swapped, so an interrupted switch is backed up next time instead of being saved over the previous slot.
      if (previous) { store.activeSlotId = null; await this.writeStore(store); }
      try { await replaceDirectory(target, canonical, hasCanonical && !previous ? await this.backupPath() : undefined); }
      catch (error) { store.activeSlotId = previous; await this.writeStore(store); throw error; }
    }
    slot.lastActivatedAtUtc = new Date().toISOString(); store.activeSlotId = slotId; await this.writeStore(store); return this.profileState();
  }

  async prepareConcurrentProfile(slotId: string): Promise<Record<string, unknown>> { return this.exclusive(() => this.prepareIsolated(slotId)); }
  private async prepareIsolated(slotId: string): Promise<Record<string, unknown>> {
    const store = await this.readStore(); this.slot(store, slotId);
    // The isolated instance writes straight into the slot folder, and the next switch saves the official folder over the active slot's folder.
    if (store.activeSlotId === slotId) throw new Error("The active account slot cannot run in an isolated instance, because switching slots saves the official Synthesizer V Studio 2 folder over it. Launch it normally, or activate another slot first.");
    const sandbox = await this.sandboxie(); if (!sandbox) throw new Error("Sandboxie Start.exe and SbieIni.exe were not found.");
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
  async openProfileFolder(slotId: string): Promise<OperationResult> {
    await this.assertSlot(slotId);
    // The active slot's data lives in the official folder; its slot folder is only the copy saved when it was switched in,
    // and the next switch saves the official folder over it.
    const active = (await this.readStore()).activeSlotId === slotId && await exists(this.canonicalPath());
    await this.reveal(active ? this.canonicalPath() : this.slotPath(slotId));
    return ok("Profile folder opened.");
  }

  async syncProfile(slotId: string, categories: string[]): Promise<Record<string, unknown>> { return this.exclusive(async () => { await this.assertSlot(slotId); if (!Array.isArray(categories) || !categories.every(value => ["settings", "database", "voice"].includes(value))) throw new Error("Unsupported sync category."); for (const category of categories) { const source = join(this.canonicalPath(), category); if (await exists(source)) await cp(source, join(this.slotPath(slotId), category), { recursive: true, force: true }); } return { slotId, categories, succeeded: true }; }); }
  async previewSelectiveSync(sourceSlotId: string, targetSlotId: string, categories: string[], overwrite: boolean): Promise<Record<string, unknown>> { await this.assertSlot(sourceSlotId); await this.assertSlot(targetSlotId); if (sourceSlotId === targetSlotId) throw new Error("Choose two different account slots to sync."); if (!Array.isArray(categories) || !categories.every(value => ["settings", "database", "voice"].includes(value)) || typeof overwrite !== "boolean") throw new Error("Invalid selective sync request."); const token = randomUUID(); this.syncPreviews.set(token, { sourceSlotId, targetSlotId, categories }); return { token, sourceSlotId, targetSlotId, categories, overwrite, entries: [] }; }
  async executeSelectiveSync(sourceSlotId: string, targetSlotId: string, categories: string[], token: string): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const preview = this.syncPreviews.get(token); if (!preview || preview.sourceSlotId !== sourceSlotId || preview.targetSlotId !== targetSlotId || JSON.stringify(preview.categories) !== JSON.stringify(categories)) throw new Error("Selective sync preview is no longer valid."); await this.assertSlot(sourceSlotId);
      if (sourceSlotId === targetSlotId) throw new Error("Choose two different account slots to sync.");
      // The active slot's data lives in the official folder; its slot folder is the copy saved when it was switched in, and the
      // next switch saves the official folder over it. So the active slot is read from, and written to, the official folder,
      // which SV2 must not hold while it is copied.
      const activeSlotId = (await this.readStore()).activeSlotId, canonical = await exists(this.canonicalPath());
      const liveSource = canonical && activeSlotId === sourceSlotId, liveTarget = canonical && activeSlotId === targetSlotId;
      if (liveSource || liveTarget) { const running = await this.runningSv2(); if (running.length) throw sv2RunningError(running, liveTarget ? "syncing into the active account slot" : "syncing from the active account slot"); }
      const sourceRoot = liveSource ? this.canonicalPath() : this.slotPath(sourceSlotId), targetRoot = liveTarget ? this.canonicalPath() : this.slotPath(targetSlotId);
      for (const category of categories) { const source = join(sourceRoot, category); if (await exists(source)) await cp(source, join(targetRoot, category), { recursive: true, force: true }); } this.syncPreviews.delete(token); return { sourceSlotId, targetSlotId, categories, succeeded: true };
    });
  }
  async previewSvpRoute(projectPath: string): Promise<Record<string, unknown>> { requireText(projectPath, "projectPath"); const store = await this.readStore(); const route = { projectPath, selectedSlotId: store.activeSlotId, mode: "active", executablePath: (await this.scanInstallations()).find(item => item.bridgeProfile === "sv2")?.executablePath ?? null }; this.pendingRoute = route; return route; }
  async launchProfile(slotId: string, projectPath?: string): Promise<OperationResult> { return this.exclusive(async () => { await this.switchTo(slotId); const executable = (await this.scanInstallations()).find(item => item.bridgeProfile === "sv2")?.executablePath; if (typeof executable !== "string") return unavailable("No SynthV Studio 2 executable was found."); spawn(executable, projectPath ? [projectPath] : [], GUI_SPAWN_OPTIONS).unref(); return ok("SynthV profile launched."); }); }
  async launchConcurrentProfile(slotId: string, projectPath?: string): Promise<OperationResult> { return this.exclusive(async () => { await this.prepareIsolated(slotId); const sandbox = await this.sandboxie(); if (!sandbox) return unavailable("Sandboxie Start.exe and SbieIni.exe were not found."); const executable = (await this.scanInstallations()).find(item => item.bridgeProfile === "sv2")?.executablePath; if (typeof executable !== "string") return unavailable("No SynthV Studio 2 executable was found."); const box = `SV2TB${slotId.replaceAll("-", "").slice(0, 24)}`; const result = await this.runner(sandbox.start, [`/box:${box}`, "/silent", executable, ...(projectPath ? [resolve(projectPath)] : [])], undefined, { visible: true }); return result.code === 0 ? ok("SynthV profile launched in Sandboxie.") : fail("Sandboxie failed to launch SynthV.", result.stderr); }); }
  async launchSvpRoute(slotId: string, projectPath: string, _mode: string): Promise<OperationResult> { await this.assertSlot(slotId); requireText(projectPath, "projectPath"); return this.launchProfile(slotId, projectPath); }
  async accountPrecheck(slotId?: string): Promise<Record<string, unknown>> { const state = await this.profileState(); const selected = slotId ?? (state as { activeSlotId?: string }).activeSlotId; const size = selected ? await this.sessionSize(selected) : undefined; return { supported: true, checkedAtUtc: new Date().toISOString(), slotId: selected, localUse: false, localProcesses: [], concurrentPids: [], sessionStatus: size?.sizeBytes != null ? "ready" : "missing", sessionSize: size, sessionCached: size?.sizeBytes != null, recoveryPending: false, summary: "Local session file metadata was checked.", detail: "" }; }
  async concurrentDefaults(appSettings: boolean, voiceLibraries: boolean): Promise<Record<string, unknown>> { if (typeof appSettings !== "boolean" || typeof voiceLibraries !== "boolean") throw new Error("Concurrent defaults must be booleans."); await this.writeConfig("concurrent-defaults.json", { appSettings, voiceLibraries }); return this.profileState(); }
  async concurrentContent(slotId: string, appSettings: string, voiceLibraries: string): Promise<Record<string, unknown>> { await this.assertSlot(slotId); if (!["on", "off", "global"].includes(appSettings) || !["on", "off", "global"].includes(voiceLibraries)) throw new Error("Invalid concurrent content preference."); await this.writeConfig(`concurrent-${slotId}.json`, { appSettings, voiceLibraries }); return this.profileState(); }
  pendingSvpRoute(): Record<string, unknown> | null { return this.pendingRoute; }
  async openDefaultAppsSettings(): Promise<OperationResult> { const result = platform() === "win32" ? await this.run("explorer.exe", ["ms-settings:defaultapps"]) : platform() === "darwin" ? await this.run("open", ["x-apple.systempreferences:com.apple.preference.general"]) : { code: -1, stdout: "", stderr: "Default applications settings are unsupported on this platform." }; return result.code === 0 ? ok("Default application settings opened.") : fail("Unable to open default application settings.", result.stderr); }
  async connectBridge(): Promise<OperationResult> { const status = await this.bridge.status(); return { succeeded: true, summary: "Bridge transport is ready.", detail: status.connected ? "SynthV Bridge is connected." : String(status.reason ?? "Waiting for SynthV Bridge.") }; }
  async bridgeStatus(): Promise<Record<string, unknown>> { const status = await this.bridge.status(); return { connected: status.connected, sessionToken: status.status?.sessionToken ?? null, requestedProcessId: null, instanceOwnership: "unverified", detail: status.connected ? "SynthV Bridge is connected." : String(status.reason ?? "SynthV Bridge is unavailable.") }; }
  async stopBridge(): Promise<OperationResult> { await this.bridge.requestStop(); return ok("Bridge stop requested."); }
  async setAutostart(enabled: boolean): Promise<boolean> { if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean."); if (this.autostart) return this.autostart.set(enabled); await mkdir(this.root, { recursive: true }); await writeFile(join(this.root, "autostart.json"), JSON.stringify({ enabled }), "utf8"); return enabled; }
  async getAutostart(): Promise<{ enabled: boolean; error: string | null }> { if (this.autostart) return this.autostart.get(); try { return { enabled: Boolean(JSON.parse(await readFile(join(this.root, "autostart.json"), "utf8")).enabled), error: null }; } catch { return { enabled: false, error: null }; } }
  async reveal(path: string): Promise<void> { const absolute = resolve(path); if (platform() === "win32") await this.run("explorer.exe", ["/select,", absolute]); else await this.run("open", ["-R", absolute]); }

  private async installBridgeTarget(target: { scriptsPath: string; bridgeProfile: string }): Promise<OperationResult> {
    this.assertBridgeTarget(target);
    const installer = (name: string) => import(pathToFileURL(join(this.bridgeDirectory, "scripts", name)).href);
    const silent = () => undefined;
    try {
      if (target.bridgeProfile === "sv1") await (await installer("install-sv1-legacy-bridge.mjs")).installSv1LegacyBridge({ target: target.scriptsPath, log: silent });
      else await (await installer("install-synthv-bridge.mjs")).installSynthvBridge({ target: target.scriptsPath, ipcDirectory: this.bridgeIpcDirectory, log: silent, warn: silent });
      return ok("Bridge installed.");
    } catch (error) {
      return fail("Bridge installation failed.", error instanceof Error ? error.message : String(error));
    }
  }
  private async diagnoseBridgeTarget(target: { scriptsPath: string; bridgeProfile: string }): Promise<OperationResult> { this.assertBridgeTarget(target); const files = target.bridgeProfile === "sv1" ? [join(target.scriptsPath, "SynthV Agent Bridge SV1 Legacy", "SynthVAgentBridgeSV1Legacy.lua")] : [join(target.scriptsPath, "SynthV Agent Bridge", "SynthVAgentBridge.lua"), join(target.scriptsPath, "SynthV Agent Bridge", "StopSynthVAgentBridge.lua")]; return (await Promise.all(files.map(file => exists(file)))).every(Boolean) ? ok("Bridge scripts are installed.") : fail("Bridge scripts are unavailable.", "Expected bridge files are missing."); }
  private assertBridgeTarget(target: { scriptsPath: string; bridgeProfile: string }): void { requireText(target.scriptsPath, "scriptsPath"); if (!bridgeProfiles.has(target.bridgeProfile)) throw new Error("Unsupported Bridge profile."); }
  private async assertProcess(processId: number, identity: string): Promise<void> { await this.verifiedProcess(processId, identity); }
  private async assertSlot(slotId: string): Promise<void> { this.slot(await this.readStore(), slotId); }
  private slot(store: ProfileStore, id: string): Slot { if (!isUuid(id)) throw new Error("Invalid profile id."); const slot = store.slots.find(item => item.id === id); if (!slot) throw new Error("Profile was not found."); return slot; }
  private activeSlotId(store: ProfileStore): string | null { return store.slots.some(item => item.id === store.activeSlotId) ? store.activeSlotId : null; }
  private exclusive<T>(task: () => Promise<T>): Promise<T> { const next = this.slotLock.then(task); this.slotLock = next.catch(() => undefined); return next; }
  private async runningSv2(): Promise<ProcessInfo[]> { try { return (await this.listProcesses()).filter(process => process.isSv2); } catch (error) { throw new Error(`Unable to confirm that Synthesizer V Studio 2 is closed: ${error instanceof Error ? error.message : String(error)}`); } }
  private async backupPath(): Promise<string> { const path = join(this.vaultPath(), "backups", new Date().toISOString().replace(/[:.]/g, "-")); return await exists(path) ? `${path}-${randomUUID().slice(0, 8)}` : path; }
  private async readStore(): Promise<ProfileStore> { try { const value = JSON.parse(await readFile(this.storePath(), "utf8")); return { activeSlotId: typeof value.activeSlotId === "string" ? value.activeSlotId : null, slots: Array.isArray(value.slots) ? value.slots.filter((slot: unknown): slot is Slot => isSlot(slot)) : [] }; } catch { return { activeSlotId: null, slots: [] }; } }
  private async writeStore(store: ProfileStore): Promise<void> { await mkdir(dirname(this.storePath()), { recursive: true }); await writeFile(this.storePath(), JSON.stringify(store), "utf8"); }
  private dataRoot(): string { return dataRootFor(platform(), this.platformDataRoot, this.env.APPDATA, homedir(), this.root); }
  private canonicalPath(): string { return canonicalPathFor(platform(), this.dataRoot()); }
  private vaultPath(): string { return `${this.canonicalPath()}.toolbox-slots`; }
  private slotPath(id: string): string { return join(this.vaultPath(), "slots", id); }
  private sessionPath(id: string, active = false): string { return join(active ? this.canonicalPath() : this.slotPath(id), "license", "session"); }
  private storePath(): string { return join(this.root, "sv2-profiles.json"); }
  private async writeConfig(name: string, value: unknown): Promise<void> { await mkdir(this.root, { recursive: true }); await writeFile(join(this.root, name), JSON.stringify(value), "utf8"); }
  private async sandboxie(): Promise<{ start: string; ini: string } | null> { if (platform() !== "win32") return null; const roots = [this.env.SANDBOXIE_HOME, this.env.ProgramW6432, this.env.ProgramFiles, this.env["ProgramFiles(x86)"]].filter((value): value is string => typeof value === "string" && value.length > 0).flatMap(root => root.endsWith("Sandboxie") || root.endsWith("Sandboxie-Plus") ? [root] : [join(root, "Sandboxie-Plus"), join(root, "Sandboxie")]); for (const root of roots) { const start = join(root, "Start.exe"); const ini = join(root, "SbieIni.exe"); if (await exists(start) && await exists(ini)) return { start, ini }; } return null; }
  private async run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> { return this.runner(command, args, env); }
}

// Pure so the win32 branch is testable from any host platform without stubbing os.platform() or mutating process.env.
export function dataRootFor(platformName: string, platformDataRoot: string | undefined, appDataEnv: string | undefined, home: string, fallbackRoot: string): string {
  if (platformDataRoot) return platformDataRoot;
  return platformName === "win32" ? appDataEnv ?? fallbackRoot : home;
}
export function canonicalPathFor(platformName: string, dataRoot: string): string {
  return platformName === "win32" ? join(dataRoot, "Dreamtonics", "Synthesizer V Studio 2") : join(dataRoot, "Library", "Application Support", "Dreamtonics", "Synthesizer V Studio 2");
}
function windowsCandidates(dataRoot: string, env: NodeJS.ProcessEnv) { const base = env.ProgramFiles ?? "C:\\Program Files"; return [candidate("Synthesizer V Studio 2 Pro", join(base, "Dreamtonics", "Synthesizer V Studio 2"), [join(dataRoot, "Dreamtonics", "Synthesizer V Studio 2", "scripts")]), candidate("Synthesizer V Studio Pro", join(base, "Dreamtonics", "Synthesizer V Studio Pro"), [join(dataRoot, "Dreamtonics", "Synthesizer V Studio", "scripts")])]; }
function macCandidates(dataRoot: string) { return [candidate("Synthesizer V Studio 2 Pro", "/Applications/Synthesizer V Studio 2 Pro.app", [join(dataRoot, "Library/Application Support/Dreamtonics/Synthesizer V Studio 2/scripts")]), candidate("Synthesizer V Studio Pro", "/Applications/Synthesizer V Studio Pro.app", [join(dataRoot, "Library/Application Support/Dreamtonics/Synthesizer V Studio/scripts")])]; }
function candidate(name: string, root: string, scripts: string[]) { return { name, source: platform() === "win32" ? "Windows standard installation directory" : "macOS Applications", executables: [join(root, "synthv-studio.exe"), join(root, "Contents/MacOS/synthv-studio")], scripts }; }
function parseWindowsProcesses(text: string): ProcessInfo[] { const parsed: unknown = JSON.parse(text || "[]"); return (Array.isArray(parsed) ? parsed : [parsed]).flatMap(value => processFrom(String((value as Record<string, unknown>).ProcessId ?? ""), String((value as Record<string, unknown>).Name ?? ""), String((value as Record<string, unknown>).CommandLine ?? ""))); }
function parseMacProcesses(text: string): ProcessInfo[] { return text.split(/\r?\n/).flatMap(line => { const match = line.trim().match(/^(\d+)\s+(\S+)\s*(.*)$/); return match ? processFrom(match[1], basename(match[2]), match[3]) : []; }); }
function processFrom(pidValue: string, name: string, command: string): ProcessInfo[] { const processId = Number(pidValue); if (!Number.isSafeInteger(processId) || !/synthesizer v|synthv/i.test(`${name} ${command}`)) return []; return [{ processId, processIdentity: `${processId}:${sha256(Buffer.from(command)).slice(0, 16)}`, name, productName: name, version: "", command, windowTitle: "", isSv2: /studio 2/i.test(`${name} ${command}`), sandboxed: /sandbox/i.test(command) }]; }
async function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv, options?: RunOptions): Promise<{ stdout: string; stderr: string; code: number }> { return new Promise(resolveResult => { const child = spawn(command, args, { shell: false, windowsHide: !options?.visible, env: env ?? process.env }); let stdout = ""; let stderr = ""; child.stdout?.on("data", chunk => { stdout += String(chunk); }); child.stderr?.on("data", chunk => { stderr += String(chunk); }); child.on("error", error => resolveResult({ stdout, stderr: error.message, code: -1 })); child.on("close", code => resolveResult({ stdout, stderr, code: code ?? -1 })); }); }
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
// Copies beside the target and swaps by rename, so an interruption leaves the old or the new tree whole (plus a stray sibling), never a half-written one.
async function replaceDirectory(source: string, target: string, keepPreviousAt?: string): Promise<void> {
  const suffix = randomUUID().slice(0, 8); const incoming = `${target}.toolbox-incoming-${suffix}`; const outgoing = keepPreviousAt ?? `${target}.toolbox-outgoing-${suffix}`;
  await mkdir(dirname(target), { recursive: true });
  try { await cp(source, incoming, { recursive: true }); } catch (error) { await discard(incoming); throw error; }
  const hadTarget = await exists(target);
  if (hadTarget) { try { await mkdir(dirname(outgoing), { recursive: true }); await moveDirectory(target, outgoing); } catch (error) { await discard(incoming); throw error; } }
  try { await moveDirectory(incoming, target); } catch (error) {
    if (hadTarget) { try { await moveDirectory(outgoing, target); } catch { await discard(incoming); throw new Error(`Unable to replace ${target}; its previous content was kept at ${outgoing}.`); } }
    await discard(incoming); throw error;
  }
  // A cleanup failure must not report the completed swap as failed, or callers would roll their bookkeeping back over new data.
  if (hadTarget && !keepPreviousAt) await discard(outgoing);
}
// Windows briefly locks freshly written trees (indexer, antivirus), so a directory rename is retried before it counts as a failure.
async function moveDirectory(from: string, to: string): Promise<void> { for (let attempt = 1; ; attempt += 1) { try { return await rename(from, to); } catch (error) { if (attempt >= 10 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; await delay(50 * attempt); } } }
async function discard(path: string): Promise<void> { await rm(path, { recursive: true, force: true }).catch(() => undefined); }
function sv2RunningError(processes: ProcessInfo[], action: string): Error { return new Error(`Synthesizer V Studio 2 is running (PID ${processes.map(item => item.processId).join(", ")}). Close it before ${action}.`); }
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

export type HostKind = "sv1" | "sv2" | "flat";
export type WindowsProcessRow = { processId: number; parentProcessId: number; name: string; commandLine: string; executablePath: string };
type Installation = { installPath?: string | null; bridgeProfile: string };
const GUI_SPAWN_OPTIONS = { detached: true, stdio: "ignore" as const, windowsHide: false };
const BRIDGE_CONNECT_ATTEMPTS = 16;
const BRIDGE_CONNECT_INTERVAL_MS = 250;
const WINDOWS_PROCESS_QUERY = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress";
const WINDOWS_UNINSTALL_QUERY = "$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; @(Get-ItemProperty -Path $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Synthesizer V' } | Select-Object DisplayName,InstallLocation,DisplayIcon) | ConvertTo-Json -Compress";
// Foreground activation can be refused by Windows, so plain key messages are posted to the window instead when the action allows it.
const WINDOWS_KEY_SCRIPT = `param($ids,$keys,$post)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class SvWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  public static IntPtr Find(uint[] ids) {
    IntPtr found = IntPtr.Zero; var set = new HashSet<uint>(ids);
    EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; uint p; GetWindowThreadProcessId(h, out p); if (set.Contains(p)) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static bool Activate(IntPtr h) {
    ShowWindow(h, 9);
    if (SetForegroundWindow(h) && GetForegroundWindow() == h) return true;
    IntPtr front = GetForegroundWindow(); if (front == IntPtr.Zero) return false;
    uint pid; uint frontThread = GetWindowThreadProcessId(front, out pid); uint self = GetCurrentThreadId();
    if (frontThread == 0 || frontThread == self) return false;
    if (!AttachThreadInput(self, frontThread, true)) return false;
    bool ok = BringWindowToTop(h) && SetForegroundWindow(h) && GetForegroundWindow() == h;
    AttachThreadInput(self, frontThread, false);
    return ok;
  }
  public static void Press(int[] keys) {
    foreach (int k in keys) keybd_event((byte)k, 0, 0, UIntPtr.Zero);
    for (int i = keys.Length - 1; i >= 0; i--) keybd_event((byte)keys[i], 0, 2, UIntPtr.Zero);
  }
  public static bool Post(IntPtr h, int vk) {
    return PostMessage(h, 0x100, new IntPtr(vk), IntPtr.Zero) && PostMessage(h, 0x101, new IntPtr(vk), new IntPtr(unchecked((int)0xC0000000)));
  }
}
'@
$h=[SvWin]::Find([uint32[]]@($ids.Split(',')|ForEach-Object{[uint32]$_}))
if($h -eq [IntPtr]::Zero){throw 'No visible SynthV window was found.'}
$k=[int[]]@($keys.Split(',')|Where-Object{$_}|ForEach-Object{[int]$_})
if([SvWin]::Activate($h)){ if($k.Length -gt 0){[SvWin]::Press($k)} }
elseif([int]$post -gt 0){ if(-not [SvWin]::Post($h,[int]$post)){throw 'Unable to post the shortcut to the SynthV window.'} }
else{throw 'Windows refused to focus the SynthV window.'}`;
export const windowsExecutableNames = ["synthv-studio.exe", "Synthesizer V Studio 2 Pro.exe", "Synthesizer V Studio Pro.exe", "Synthesizer V Studio.exe", "Synthesizer V Flat.exe", "Synthesizer V Studio Flat.exe", "synthesizer-v-flat.exe", "synthv-flat.exe"];
const flatExecutableNames = new Set(["synthesizer v flat", "synthesizer v flat.exe", "synthesizer-v-flat.exe", "synthv-flat.exe"]);
const sv2ExecutableNames = new Set(["svstudio2.exe", "svstudio2-pro.exe", "svstudio2", "svstudio2 pro"]);
const hostProcessNames = new Set([...flatExecutableNames, ...sv2ExecutableNames, "synthv-studio.exe", "svstudio.exe", "synthesizer v studio.exe", "synthesizer v studio pro.exe", "synthesizer v studio 2.exe", "synthesizer v studio 2 pro.exe"]);

export function bridgeProfile(name: string): "sv2" | "sv1" | "flat" | "unsupported" {
  const lower = name.toLowerCase();
  if (lower.includes("flat")) return "flat";
  if (lower.includes("studio 2")) return "sv2";
  if (lower.includes("studio basic")) return "unsupported";
  return lower.includes("synthesizer v studio") ? "sv1" : "unsupported";
}
export function isFlatExecutableName(value: string): boolean { return flatExecutableNames.has(win32.basename(value.trim().replaceAll('"', "")).toLowerCase()); }
export function isSynthVHostDisplayName(displayName: string): boolean { return /synthesizer v (flat|studio flat|studio 2|studio pro|studio basic)/i.test(displayName); }
export function windowsProcessExecutable(command: string): string | null {
  const trimmed = command.trim();
  const executable = trimmed.startsWith('"') ? trimmed.slice(1).split('"')[0] : trimmed.match(/^.*?\.exe(?=\s|$)/i)?.[0] ?? "";
  return executable ? executable : null;
}
/** Classifies a Windows executable path by its file name and install folder; an unrecognised folder is not an official install. */
export function windowsProcessKind(executable: string): HostKind | null {
  const fileName = win32.basename(executable).toLowerCase();
  if (isFlatExecutableName(fileName)) return "flat";
  if (!(fileName === "synthv-studio.exe" || fileName === "synthv-studio" || sv2ExecutableNames.has(fileName))) return null;
  const folders = win32.dirname(executable).split(/[\\/]/).map(part => part.toLowerCase());
  if (sv2ExecutableNames.has(fileName) || folders.some(part => part === "synthesizer v studio 2" || part === "synthesizer v studio 2 pro")) return "sv2";
  return folders.some(part => part === "synthesizer v studio" || part === "synthesizer v studio pro") ? "sv1" : null;
}
function windowsDirname(path: string): string { return win32.dirname(path); }
function windowsRowExecutable(row: WindowsProcessRow): string { return row.executablePath || windowsProcessExecutable(row.commandLine) || ""; }
function windowsRowIsHost(row: WindowsProcessRow, executable: string): boolean { return hostProcessNames.has(row.name.toLowerCase()) || (executable !== "" && hostProcessNames.has(win32.basename(executable).toLowerCase())); }
function parseJsonRows(text: string): Array<Record<string, unknown>> { const parsed: unknown = JSON.parse(text.trim() || "[]"); return (Array.isArray(parsed) ? parsed : [parsed]).filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null); }
export function registeredInstallDirectories(installLocation: string, displayIcon: string): string[] {
  const directories: string[] = [];
  const location = installLocation.trim().replaceAll('"', "");
  if (location) directories.push(location);
  const icon = displayIcon.trim().replaceAll('"', "").replace(/,-?\d+$/, "");
  if (icon) directories.push(/\.(exe|ico)$/i.test(icon) ? win32.dirname(icon) : icon);
  return directories;
}
function windowsFlatScriptCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  if (env.USERPROFILE) candidates.push(win32.join(env.USERPROFILE, "Documents", "Dreamtonics", "Synthesizer V Studio", "scripts"), win32.join(env.USERPROFILE, "Documents", "Anthronics", "Synthesizer V Studio", "scripts"));
  for (const root of [env.APPDATA, env.LOCALAPPDATA]) if (root) candidates.push(win32.join(root, "Anthronics", "Synthesizer V Studio", "scripts"));
  return candidates;
}
/** Maps each process to the one installation whose directory holds its executable; folder-derived kinds must agree with the installation's profile. */
export function matchProcessesToInstallations<I extends Installation>(processes: Array<{ processId: number; executablePath: string }>, installations: I[]): Map<number, I> {
  const matches = new Map<number, I>();
  for (const process of processes) {
    if (!process.executablePath || matches.has(process.processId)) continue;
    const directory = normalizePath(win32.dirname(process.executablePath));
    const kind = windowsProcessKind(process.executablePath);
    const hits = installations.filter(item => typeof item.installPath === "string" && normalizePath(item.installPath) === directory && (kind === null || kind === item.bridgeProfile));
    if (hits.length > 0 && hits.every(item => item.bridgeProfile === hits[0].bridgeProfile)) matches.set(process.processId, hits[0]);
  }
  return matches;
}
export function windowsShortcutKeys(action: string, isSv2: boolean): number[] {
  const CTRL = 0x11, ALT = 0x12, SHIFT = 0x10;
  switch (action) {
    case "start": return isSv2 ? [CTRL, ALT, SHIFT, 0x42] : [0x7c];
    case "startLegacy": return [0x7c];
    case "stop": return isSv2 ? [CTRL, ALT, SHIFT, 0x4e] : [0x7d];
    case "save": return [CTRL, 0x53];
    case "undo": return [CTRL, 0x5a];
    case "refresh": return [0x74];
    default: throw new Error("Unsupported SynthV shortcut action.");
  }
}
/** The single key that may be posted to the window when foreground activation is refused; chords and edit shortcuts need real input. */
export function windowsPostableKey(action: string, isSv2 = false): number {
  const keys = windowsShortcutKeys(action, isSv2);
  return keys.length === 1 ? keys[0] : 0;
}
/** A Flat launcher owns no window; its editor is the synthv-studio.mz descendant. */
export function windowTargetProcessIds(processId: number, rows: WindowsProcessRow[]): number[] {
  const target = rows.find(row => row.processId === processId);
  if (!target || !isFlatExecutableName(windowsRowExecutable(target) || target.name)) return [processId];
  const family = new Set([processId]);
  for (let grown = true; grown;) { grown = false; for (const row of rows) if (family.has(row.parentProcessId) && !family.has(row.processId)) { family.add(row.processId); grown = true; } }
  return rows.filter(row => family.has(row.processId) && row.name.toLowerCase() === "synthv-studio.mz").map(row => row.processId);
}
/** SV2 loads bridge scripts at startup, so it rescans them before the start shortcut. */
export function bridgeStartPlan(isSv2: boolean): { refreshFirst: boolean; refreshSettleMs: number } { return { refreshFirst: isSv2, refreshSettleMs: 800 }; }
