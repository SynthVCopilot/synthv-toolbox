import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const servicePath = new URL("../src/PiDesktop.Tauri/electron/services/synthv-service.ts", import.meta.url);
const { SynthVService, dataRootFor, canonicalPathFor } = await import(servicePath.href);
const { registerSynthVCommands } = await import(new URL("../src/PiDesktop.Tauri/electron/services/synthv-commands.ts", import.meta.url).href);
const bridgeDirectory = fileURLToPath(new URL("../src/PiDesktop.Tauri/components/synthv-agent-bridge/", import.meta.url));
const noBridge = { status: async () => ({ connected: false }), requestStop: async () => {} };

test("SynthV commands use argument arrays and verify a stable process identity", async () => {
  const commands = [];
  const windowsProcess = JSON.stringify({ ProcessId: 42, Name: "synthv-studio.exe", CommandLine: "C:\\SynthV\\synthv-studio.exe" });
  const macProcess = "42 /Applications/Synthesizer V Studio 2.app/Contents/MacOS/Synthesizer V Studio 2 --started\n";
  const runner = async (command, args) => {
    commands.push([command, args]);
    if (command === "powershell.exe" && args.some(value => value.includes("Get-CimInstance Win32_Process"))) return { stdout: windowsProcess, stderr: "", code: 0 };
    if (command === "ps") return { stdout: macProcess, stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
  const root = await mkdtemp(join(tmpdir(), "synthv-service-"));
  try {
    const service = new SynthVService(root, root, noBridge, root, runner);
    const [synthvProcess] = await service.listProcesses();
    await service.terminateInstance(synthvProcess.processId, synthvProcess.processIdentity);
    assert.deepEqual(commands.at(-1), process.platform === "win32" ? ["taskkill.exe", ["/PID", "42", "/T", "/F"]] : ["kill", ["-TERM", "42"]]);
    await assert.rejects(() => service.terminateInstance(42, "changed"), /identity changed/);
    assert.equal(commands.some(([command, args]) => command === "taskkill.exe" && args.includes("changed")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("profiles persist locally without session content APIs", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthv-profile-"));
  try {
    const service = new SynthVService(root, root, noBridge, root, async () => ({ stdout: "", stderr: "", code: 0 }), undefined, root);
    const state = await service.createProfile("Primary");
    const slotId = state.slots[0].id;
    assert.deepEqual(await service.sessionSize(slotId), { status: "unknown", sizeBytes: null });
    for (const name of ["readSession", "writeSession", "inspectOfflineLicense", "setOfflineLicense"]) assert.equal(service[name], undefined);
    assert.equal((await service.profileState()).slots[0].id, slotId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bridge diagnosis checks the files the installers actually write", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthv-bridge-diagnose-"));
  try {
    const service = new SynthVService(root, root, noBridge, root, async () => ({ stdout: "", stderr: "", code: 0 }), undefined, root);
    const scriptsPath = join(root, "scripts");
    const sv2Result = await service.diagnoseBridge([{ scriptsPath, bridgeProfile: "sv2" }]);
    assert.equal(sv2Result[0].result.succeeded, false);
    const sv2Directory = join(scriptsPath, "SynthV Agent Bridge");
    await mkdir(sv2Directory, { recursive: true });
    await writeFile(join(sv2Directory, "SynthVAgentBridge.lua"), "", "utf8");
    await writeFile(join(sv2Directory, "StopSynthVAgentBridge.lua"), "", "utf8");
    assert.equal((await service.diagnoseBridge([{ scriptsPath, bridgeProfile: "sv2" }]))[0].result.succeeded, true);

    const sv1Result = await service.diagnoseBridge([{ scriptsPath, bridgeProfile: "sv1" }]);
    assert.equal(sv1Result[0].result.succeeded, false);
    const sv1Directory = join(scriptsPath, "SynthV Agent Bridge SV1 Legacy");
    await mkdir(sv1Directory, { recursive: true });
    await writeFile(join(sv1Directory, "SynthVAgentBridgeSV1Legacy.lua"), "", "utf8");
    assert.equal((await service.diagnoseBridge([{ scriptsPath, bridgeProfile: "sv1" }]))[0].result.succeeded, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent profiles map the sandbox AppData directory to the account slot", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "synthv-sandbox-"));
  const sandboxHome = join(root, "Sandboxie-Plus");
  await mkdir(sandboxHome, { recursive: true });
  await Promise.all([writeFile(join(sandboxHome, "Start.exe"), ""), writeFile(join(sandboxHome, "SbieIni.exe"), "")]);
  const commands = []; let configuredRoot = "";
  const runner = async (command, args) => { commands.push([command, args]); if (args[0] === "set" && args[2] === "FileRootPath") configuredRoot = args[3]; return { stdout: args[0] === "queryex" ? `FileRootPath=${configuredRoot}\n` : "", stderr: "", code: 0 }; };
  try {
    const service = new SynthVService(root, root, noBridge, root, runner, undefined, root, { SANDBOXIE_HOME: sandboxHome }); const state = await service.createProfile("Isolated"); const slotId = state.slots[0].id;
    await service.prepareConcurrentProfile(slotId);
    const overlay = join(configuredRoot, "user", "current", "AppData", "Roaming", "Dreamtonics", "Synthesizer V Studio 2");
    assert.equal((await lstat(overlay)).isSymbolicLink(), true);
    assert.ok(commands.some(([, args]) => args[0] === "append" && args[2] === "OpenFilePath"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bridgeStatus and connectBridge map a fake bridge.status(), and stopBridge calls requestStop", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthv-bridge-status-"));
  const requestStopCalls = [];
  try {
    const connectedBridge = { status: async () => ({ connected: true, ipcDirectory: root, status: { sessionToken: "tok" } }), requestStop: async () => { requestStopCalls.push(true); } };
    const connectedService = new SynthVService(root, root, connectedBridge, root);
    assert.deepEqual(await connectedService.bridgeStatus(), { connected: true, sessionToken: "tok", requestedProcessId: null, instanceOwnership: "unverified", detail: "SynthV Bridge is connected." });
    assert.equal((await connectedService.connectBridge()).detail, "SynthV Bridge is connected.");

    const disconnectedBridge = { status: async () => ({ connected: false, ipcDirectory: root, reason: "no heartbeat" }), requestStop: async () => { requestStopCalls.push(true); } };
    const disconnectedService = new SynthVService(root, root, disconnectedBridge, root);
    assert.deepEqual(await disconnectedService.bridgeStatus(), { connected: false, sessionToken: null, requestedProcessId: null, instanceOwnership: "unverified", detail: "no heartbeat" });
    assert.equal((await disconnectedService.connectBridge()).detail, "no heartbeat");

    await disconnectedService.stopBridge();
    assert.equal(requestStopCalls.length, 1, "stopBridge calls bridge.requestStop()");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dataRootFor/canonicalPathFor compute the win32 path even when the host platform is not Windows", () => {
  assert.equal(dataRootFor("win32", undefined, "C:\\Users\\rin\\AppData\\Roaming", "/Users/rin", "/fallback"), "C:\\Users\\rin\\AppData\\Roaming");
  assert.equal(dataRootFor("win32", undefined, undefined, "/Users/rin", "/fallback"), "/fallback");
  assert.equal(dataRootFor("darwin", undefined, "C:\\ignored", "/Users/rin", "/fallback"), "/Users/rin");
  assert.equal(dataRootFor("win32", "/injected", "C:\\ignored", "/Users/rin", "/fallback"), "/injected");
  assert.equal(canonicalPathFor("win32", "C:\\Users\\rin\\AppData\\Roaming"), join("C:\\Users\\rin\\AppData\\Roaming", "Dreamtonics", "Synthesizer V Studio 2"));
  assert.equal(canonicalPathFor("darwin", "/Users/rin"), join("/Users/rin", "Library", "Application Support", "Dreamtonics", "Synthesizer V Studio 2"));
});

test("scanInstallations reads scripts under the injected data root, not the real home directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthv-scan-"));
  try {
    const scriptsDirectory = process.platform === "win32"
      ? join(root, "Dreamtonics", "Synthesizer V Studio 2", "scripts")
      : join(root, "Library/Application Support/Dreamtonics/Synthesizer V Studio 2/scripts");
    await mkdir(scriptsDirectory, { recursive: true });
    const service = new SynthVService(root, root, noBridge, root, async () => ({ stdout: "", stderr: "", code: 0 }), undefined, root);
    const found = (await service.scanInstallations()).find((entry) => entry.displayName === "Synthesizer V Studio 2 Pro");
    assert.equal(found.scriptsPath, scriptsDirectory);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installBridge runs the real installers in-process, always through the explicit IPC directory, and the fixed diagnosis then reports them as installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthv-bridge-install-"));
  const bridgeDir = await mkdtemp(join(tmpdir(), "synthv-bridge-ipc-"));
  const realManifest = join(tmpdir(), "synthv-agent-bridge.install.json");
  const before = await manifestFingerprint(realManifest);
  const spawned = [];
  const runner = async (command, args) => { spawned.push([command, args]); return { stdout: "", stderr: "", code: 0 }; };
  try {
    // env deliberately carries no SYNTHV_AGENT_BRIDGE_DIR: the explicit bridgeIpcDirectory parameter alone must govern it.
    const service = new SynthVService(root, bridgeDirectory, noBridge, bridgeDir, runner, undefined, root, { ...process.env });
    const scriptsPath = join(root, "scripts");

    const sv2Install = await service.installBridge([{ scriptsPath, bridgeProfile: "sv2" }]);
    assert.equal(sv2Install[0].result.succeeded, true, sv2Install[0].result.detail);
    const sv2Diagnosis = await service.diagnoseBridge([{ scriptsPath, bridgeProfile: "sv2" }]);
    assert.equal(sv2Diagnosis[0].result.succeeded, true);
    assert.equal((await readFile(join(scriptsPath, "SynthV Agent Bridge", "SynthVAgentBridge.lua"), "utf8")).length > 0, true);
    assert.equal((await stat(join(bridgeDir, "synthv-agent-bridge.install.json"))).isFile(), true, "the installer wrote its manifest into the explicit IPC directory");

    const sv1Install = await service.installBridge([{ scriptsPath, bridgeProfile: "sv1" }]);
    assert.equal(sv1Install[0].result.succeeded, true, sv1Install[0].result.detail);
    const sv1Diagnosis = await service.diagnoseBridge([{ scriptsPath, bridgeProfile: "sv1" }]);
    assert.equal(sv1Diagnosis[0].result.succeeded, true);

    assert.deepEqual(await manifestFingerprint(realManifest), before, "the installer never fell back to the real temp directory");
    assert.equal(spawned.some(([command]) => command === process.execPath), false, "a hardened Electron binary cannot act as Node, so the installers must not be spawned through it");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(bridgeDir, { recursive: true, force: true });
  }
});

test("Bridge installers import when an app launch has flags rather than a script as argv[1]", () => {
  for (const name of ["install-synthv-bridge.mjs", "install-sv1-legacy-bridge.mjs"]) {
    const url = new URL(`../src/PiDesktop.Tauri/components/synthv-agent-bridge/scripts/${name}`, import.meta.url).href;
    const loaded = spawnSync(process.execPath, ["--input-type=module", "-e", `process.argv[1] = '--hidden'; await import(${JSON.stringify(url)});`], { encoding: "utf8" });
    assert.equal(loaded.status, 0, loaded.stderr);
  }
});

test("packaged resources install modern and legacy Bridge without starting Electron as Node", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthv-packaged-bridge-"));
  try {
    const yaml = createRequire(new URL("../src/PiDesktop.Tauri/node_modules/electron-updater/package.json", import.meta.url))("js-yaml");
    const config = yaml.load(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
    for (const resource of config.extraResources.filter(value => value.from.includes("components/synthv-agent-bridge/") && !value.from.endsWith("/dist"))) {
      await cp(fileURLToPath(new URL(`../${resource.from}`, import.meta.url)), join(root, "resources", resource.to), { recursive: true });
    }
    const service = new SynthVService(root, join(root, "resources/components/synthv-agent-bridge"), noBridge, join(root, "ipc"), async () => { throw new Error("The signed Electron binary cannot run as Node"); }, undefined, root);
    for (const bridgeProfile of ["sv2", "sv1"]) {
      const target = { scriptsPath: join(root, "scripts"), bridgeProfile };
      const [result] = await service.installBridge([target]);
      assert.equal(result.result.succeeded, true, result.result.detail);
      assert.equal((await service.diagnoseBridge([target]))[0].result.succeeded, true);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installBridge reports a failed installation instead of throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthv-bridge-missing-"));
  try {
    const service = new SynthVService(root, join(root, "no-bridge"), noBridge, root, async () => ({ stdout: "", stderr: "", code: 0 }), undefined, root);
    const [install] = await service.installBridge([{ scriptsPath: join(root, "scripts"), bridgeProfile: "sv2" }]);
    assert.equal(install.result.succeeded, false);
    assert.equal(install.result.summary, "Bridge installation failed.");
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Regression guard: the real installer defaults its manifest path to os.tmpdir(), so this proves the test never touched it.
async function manifestFingerprint(path) {
  try {
    const [info, content] = await Promise.all([stat(path), readFile(path)]);
    return { mtimeMs: info.mtimeMs, sha256: createHash("sha256").update(content).digest("hex") };
  } catch {
    return null;
  }
}

test("save shortcut sends the platform save key and reports operating system failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthv-save-"));
  const calls = []; let denied = false;
  const runner = async (command, args) => {
    calls.push([command, args]);
    if (command === "ps") return { stdout: "42 /Applications/Synthesizer V Studio 2.app/Contents/MacOS/Synthesizer V Studio 2 --started\n", stderr: "", code: 0 };
    if (args.some(value => value.includes("Get-CimInstance"))) return { stdout: JSON.stringify({ ProcessId: 42, Name: "synthv-studio.exe", CommandLine: "Synthesizer V Studio 2" }), stderr: "", code: 0 };
    return { stdout: "", stderr: denied ? "Accessibility denied" : "", code: denied ? 1 : 0 };
  };
  try {
    const service = new SynthVService(root, root, noBridge, root, runner);
    const [target] = await service.listProcesses();
    await service.sendShortcut(target.processId, target.processIdentity, "save");
    assert.ok(calls.at(-1)[1].some(value => process.platform === "win32" ? value === "^s" : value.includes('keystroke "s" using command down')));
    denied = true;
    await assert.rejects(service.sendShortcut(target.processId, target.processIdentity, "save"), /Accessibility denied/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// A temp data root whose process scan reports one SV2 instance only while `running` is set, on either host platform.
async function slotFixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const fixture = { root, running: false, scanFails: false };
  const runner = async command => {
    if (fixture.scanFails) return { stdout: "", stderr: "process scan denied", code: 1 };
    if (!fixture.running) return { stdout: "", stderr: "", code: 0 };
    return command === "ps"
      ? { stdout: "4242 /Applications/Synthesizer V Studio 2.app/Contents/MacOS/Synthesizer V Studio 2 --started\n", stderr: "", code: 0 }
      : { stdout: JSON.stringify([{ ProcessId: 4242, Name: "synthv-studio.exe", CommandLine: "\"C:\\Program Files\\Dreamtonics\\Synthesizer V Studio 2\\synthv-studio.exe\"" }]), stderr: "", code: 0 };
  };
  fixture.service = new SynthVService(root, root, noBridge, root, runner, undefined, root, {});
  fixture.canonical = canonicalPathFor(process.platform, root);
  fixture.vault = `${fixture.canonical}.toolbox-slots`;
  fixture.slot = id => join(fixture.vault, "slots", id);
  return fixture;
}
async function writeTree(directory, files) { for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), content, "utf8"); } }
async function readTree(directory, prefix = "") {
  const tree = {};
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(tree, await readTree(directory, path)); else tree[path] = await readFile(join(directory, path), "utf8");
  }
  return tree;
}
const created = async (service, displayName) => (await service.createProfile(displayName)).slots.find(slot => slot.displayName === displayName).id;

test("switching slots saves the live SV2 data into the active slot before replacing it", async () => {
  const fixture = await slotFixture("synthv-switch-"); const { service, canonical } = fixture;
  try {
    const a = await created(service, "A"); const b = await created(service, "B");
    await writeTree(fixture.slot(a), { "license/session": "a-session", "voices/old.bin": "old voice" });
    await writeTree(fixture.slot(b), { "license/session": "b-session" });
    await service.activateProfile(a);
    assert.deepEqual(await readTree(canonical), { "license/session": "a-session", "voices/old.bin": "old voice" });

    // What SV2 did while A was active: renewed the session, installed the Bridge, and removed a voice.
    const live = { "license/session": "a-renewed", "scripts/SynthV Agent Bridge/SynthVAgentBridge.lua": "bridge" };
    await rm(join(canonical, "voices"), { recursive: true }); await writeTree(canonical, live);
    assert.equal((await service.activateProfile(b)).activeSlotId, b);
    assert.deepEqual(await readTree(fixture.slot(a)), live, "the slot is replaced by the live data, not merged with its stale copy");
    assert.deepEqual(await readTree(canonical), { "license/session": "b-session" });

    await service.activateProfile(a);
    assert.deepEqual(await readTree(canonical), live);
    assert.deepEqual(await readTree(fixture.slot(b)), { "license/session": "b-session" });
    assert.deepEqual((await readdir(dirname(canonical))).sort(), [basename(canonical), basename(fixture.vault)].sort(), "no staging siblings are left beside the official folder");
    assert.deepEqual((await readdir(join(fixture.vault, "slots"))).sort(), [a, b].sort(), "no staging siblings are left beside the slots");
    assert.deepEqual(await readdir(join(fixture.vault, "backups")).catch(() => []), [], "switching away from an active slot needs no backup");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("re-activating the active slot keeps the live SV2 data and refreshes the slot copy", async () => {
  const fixture = await slotFixture("synthv-reactivate-"); const { service, canonical } = fixture;
  try {
    const main = await created(service, "Main");
    await writeTree(fixture.slot(main), { "license/session": "saved" });
    await service.activateProfile(main);
    const live = { "license/session": "renewed", "settings/settings.xml": "<changed/>" };
    await writeTree(canonical, live);
    assert.equal((await service.activateProfile(main)).activeSlotId, main);
    assert.deepEqual(await readTree(canonical), live, "the older slot copy never replaces the live folder");
    assert.deepEqual(await readTree(fixture.slot(main)), live);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("the first activation without an active slot backs the official folder up under the vault", async () => {
  const fixture = await slotFixture("synthv-backup-"); const { service, canonical } = fixture;
  try {
    const original = { "license/session": "real-session", "scripts/SynthV Agent Bridge/SynthVAgentBridge.lua": "bridge", "voices/Voice/voice.bin": "voice" };
    await writeTree(canonical, original);
    const fresh = await created(service, "Fresh");
    assert.equal((await service.activateProfile(fresh)).activeSlotId, fresh);
    assert.deepEqual(await readTree(canonical), {}, "the empty slot is now the official folder");
    const backups = await readdir(join(fixture.vault, "backups"));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/, "the timestamp is safe as a Windows folder name");
    assert.deepEqual(await readTree(join(fixture.vault, "backups", backups[0])), original);

    await service.activateProfile(await created(service, "Second"));
    assert.deepEqual(await readdir(join(fixture.vault, "backups")), backups, "later switches save into the active slot instead");
    assert.deepEqual(await readTree(join(fixture.vault, "backups", backups[0])), original, "backups are never pruned");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("importing the current SV2 data copies it into a new slot that becomes active", async () => {
  const fixture = await slotFixture("synthv-import-"); const { service, canonical } = fixture;
  try {
    const original = { "license/session": "real-session", "settings/settings.xml": "<settings/>", "scripts/SynthV Agent Bridge/SynthVAgentBridge.lua": "bridge" };
    await writeTree(canonical, original);
    const handlers = new Map(); registerSynthVCommands({ register: (name, handler) => handlers.set(name, handler) }, service);
    const state = await handlers.get("import_current_sv2_profile")({ displayName: "Current" });
    const [imported] = state.slots;
    assert.equal(state.activeSlotId, imported.id); assert.equal(imported.isActive, true); assert.equal(typeof imported.lastActivatedAtUtc, "string");
    assert.deepEqual(await readTree(fixture.slot(imported.id)), original);
    assert.deepEqual(await readTree(canonical), original);

    // The reported data loss: activating an imported slot replaced the official folder with an empty one.
    await service.activateProfile(imported.id);
    assert.deepEqual(await readTree(canonical), original);

    const live = { ...original, "license/session": "renewed" }; await writeTree(canonical, live);
    const again = await service.importCurrentProfile("Copy"); const copy = again.slots.find(slot => slot.displayName === "Copy");
    assert.equal(again.activeSlotId, copy.id);
    assert.deepEqual(await readTree(fixture.slot(imported.id)), live, "the previously active slot keeps what SV2 wrote before the import");
    assert.deepEqual(await readTree(fixture.slot(copy.id)), live);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("importing without current SV2 data fails without creating a slot", async () => {
  const fixture = await slotFixture("synthv-import-missing-"); const { service } = fixture;
  try {
    await assert.rejects(service.importCurrentProfile("Nothing"), /^Error: No current Synthesizer V Studio 2 data was found to import\.$/);
    assert.deepEqual((await service.profileState()).slots, []);
    assert.deepEqual(await readdir(join(fixture.vault, "slots")).catch(() => []), []);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("a running SV2 blocks switching and importing but not re-activating its own slot", async () => {
  const fixture = await slotFixture("synthv-running-"); const { service, canonical } = fixture;
  try {
    await writeTree(canonical, { "license/session": "live" });
    const current = (await service.importCurrentProfile("Current")).slots[0].id; const other = await created(service, "Other");
    fixture.running = true;
    await writeTree(canonical, { "license/session": "written-while-running" });
    await assert.rejects(service.activateProfile(other), /Synthesizer V Studio 2 is running \(PID 4242\)\. Close it before switching account slots\./);
    await assert.rejects(service.importCurrentProfile("Again"), /Synthesizer V Studio 2 is running \(PID 4242\)\. Close it before importing its current data\./);
    assert.equal((await service.profileState()).slots.length, 2);
    assert.equal((await service.activateProfile(current)).activeSlotId, current);
    assert.deepEqual(await readTree(canonical), { "license/session": "written-while-running" });
    assert.deepEqual(await readTree(fixture.slot(current)), { "license/session": "live" }, "the slot copy waits until SV2 releases the official folder");

    fixture.running = false; fixture.scanFails = true;
    await assert.rejects(service.activateProfile(other), /Unable to confirm that Synthesizer V Studio 2 is closed: process scan denied/);
    fixture.scanFails = false;
    await service.activateProfile(other);
    assert.deepEqual(await readTree(fixture.slot(current)), { "license/session": "written-while-running" });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("activating a slot whose folder is missing fails before touching the official folder", async () => {
  const fixture = await slotFixture("synthv-missing-slot-"); const { service, canonical } = fixture;
  try {
    await writeTree(canonical, { "license/session": "live" });
    const current = (await service.importCurrentProfile("Current")).slots[0].id; const gone = await created(service, "Gone");
    await rm(fixture.slot(gone), { recursive: true });
    await assert.rejects(service.activateProfile(gone), /The profile data folder was not found\./);
    assert.deepEqual(await readTree(canonical), { "license/session": "live" });
    assert.equal((await service.profileState()).activeSlotId, current);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
