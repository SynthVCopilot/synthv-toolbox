import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const servicePath = new URL("../src/PiDesktop.Tauri/electron/services/synthv-service.ts", import.meta.url);
const { SynthVService, dataRootFor, canonicalPathFor } = await import(servicePath.href);
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

test("profiles persist locally and session writes reject stale hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthv-profile-"));
  try {
    const service = new SynthVService(root, root, noBridge, root, async () => ({ stdout: "", stderr: "", code: 0 }), undefined, root);
    const state = await service.createProfile("Primary");
    const slotId = state.slots[0].id;
    const written = await service.writeSession(slotId, "offline-license=false", "");
    await assert.rejects(() => service.writeSession(slotId, "changed", "0".repeat(64)), /changed before write/);
    assert.match(written.sha256, /^[0-9a-f]{64}$/);
    assert.equal((await service.inspectOfflineLicense(slotId)).available, true);
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

test("installBridge runs the real installers, always through the explicit IPC directory, and the fixed diagnosis then reports them as installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthv-bridge-install-"));
  const bridgeDir = await mkdtemp(join(tmpdir(), "synthv-bridge-ipc-"));
  // Second layer of defense: even if the installer ever fell back to TMPDIR, this must not be the real one.
  const childTmp = await mkdtemp(join(tmpdir(), "synthv-bridge-childtmp-"));
  try {
    // env deliberately carries no SYNTHV_AGENT_BRIDGE_DIR: the explicit bridgeIpcDirectory parameter alone must govern it.
    const service = new SynthVService(root, bridgeDirectory, noBridge, bridgeDir, undefined, undefined, root, { ...process.env, TMPDIR: childTmp });
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

    assert.equal(await manifestFingerprint(join(childTmp, "synthv-agent-bridge.install.json")), null, "the installer never fell back to the child's TMPDIR either");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(bridgeDir, { recursive: true, force: true });
    await rm(childTmp, { recursive: true, force: true });
  }
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
