import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const servicePath = new URL("../src/PiDesktop.Tauri/electron/services/synthv-service.ts", import.meta.url);
const { SynthVService, dataRootFor, canonicalPathFor } = await import(servicePath.href);
const bridgeDirectory = fileURLToPath(new URL("../src/PiDesktop.Tauri/components/synthv-agent-bridge/", import.meta.url));

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
    const service = new SynthVService(root, root, runner);
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
    const service = new SynthVService(root, root, async () => ({ stdout: "", stderr: "", code: 0 }), undefined, root);
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
    const service = new SynthVService(root, root, async () => ({ stdout: "", stderr: "", code: 0 }), undefined, root);
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
    const service = new SynthVService(root, root, runner, undefined, root, { SANDBOXIE_HOME: sandboxHome }); const state = await service.createProfile("Isolated"); const slotId = state.slots[0].id;
    await service.prepareConcurrentProfile(slotId);
    const overlay = join(configuredRoot, "user", "current", "AppData", "Roaming", "Dreamtonics", "Synthesizer V Studio 2");
    assert.equal((await lstat(overlay)).isSymbolicLink(), true);
    assert.ok(commands.some(([, args]) => args[0] === "append" && args[2] === "OpenFilePath"));
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
    const service = new SynthVService(root, root, async () => ({ stdout: "", stderr: "", code: 0 }), undefined, root);
    const found = (await service.scanInstallations()).find((entry) => entry.displayName === "Synthesizer V Studio 2 Pro");
    assert.equal(found.scriptsPath, scriptsDirectory);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installBridge runs the real installers, and the fixed diagnosis then reports them as installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthv-bridge-install-"));
  try {
    const service = new SynthVService(root, bridgeDirectory, undefined, undefined, root);
    const scriptsPath = join(root, "scripts");

    const sv2Install = await service.installBridge([{ scriptsPath, bridgeProfile: "sv2" }]);
    assert.equal(sv2Install[0].result.succeeded, true, sv2Install[0].result.detail);
    const sv2Diagnosis = await service.diagnoseBridge([{ scriptsPath, bridgeProfile: "sv2" }]);
    assert.equal(sv2Diagnosis[0].result.succeeded, true);
    assert.equal((await readFile(join(scriptsPath, "SynthV Agent Bridge", "SynthVAgentBridge.lua"), "utf8")).length > 0, true);

    const sv1Install = await service.installBridge([{ scriptsPath, bridgeProfile: "sv1" }]);
    assert.equal(sv1Install[0].result.succeeded, true, sv1Install[0].result.detail);
    const sv1Diagnosis = await service.diagnoseBridge([{ scriptsPath, bridgeProfile: "sv1" }]);
    assert.equal(sv1Diagnosis[0].result.succeeded, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
