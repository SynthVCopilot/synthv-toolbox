import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const servicePath = new URL("../src/PiDesktop.Tauri/electron/services/synthv-service.ts", import.meta.url);
const { SynthVService } = await import(servicePath.href);

test("SynthV commands use argument arrays and verify a stable process identity", async () => {
  const commands = [];
  const processJson = JSON.stringify({ ProcessId: 42, Name: "synthv-studio.exe", CommandLine: "C:\\SynthV\\synthv-studio.exe" });
  const runner = async (command, args) => {
    commands.push([command, args]);
    if (command === "powershell.exe" && args.some(value => value.includes("Get-CimInstance Win32_Process"))) return { stdout: processJson, stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
  const root = await mkdtemp(join(tmpdir(), "synthv-service-"));
  try {
    const service = new SynthVService(root, root, runner);
    const [process] = await service.listProcesses();
    await service.terminateInstance(process.processId, process.processIdentity);
    assert.deepEqual(commands.at(-1), ["taskkill.exe", ["/PID", "42", "/T", "/F"]]);
    await assert.rejects(() => service.terminateInstance(42, "changed"), /identity changed/);
    assert.equal(commands.some(([command, args]) => command === "taskkill.exe" && args.includes("changed")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("profiles persist locally and session writes reject stale hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "synthv-profile-"));
  const previousAppData = process.env.APPDATA;
  if (process.platform === "win32") process.env.APPDATA = root;
  try {
    const service = new SynthVService(root, root, async () => ({ stdout: "", stderr: "", code: 0 }));
    const state = await service.createProfile("Primary");
    const slotId = state.slots[0].id;
    const written = await service.writeSession(slotId, "offline-license=false", "");
    await assert.rejects(() => service.writeSession(slotId, "changed", "0".repeat(64)), /changed before write/);
    assert.match(written.sha256, /^[0-9a-f]{64}$/);
    assert.equal((await service.inspectOfflineLicense(slotId)).available, true);
  } finally { if (process.platform === "win32") { if (previousAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = previousAppData; } await rm(root, { recursive: true, force: true }); }
});

test("concurrent profiles map the sandbox AppData directory to the account slot", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "synthv-sandbox-"));
  const sandboxHome = join(root, "Sandboxie-Plus");
  await mkdir(sandboxHome, { recursive: true });
  await Promise.all([writeFile(join(sandboxHome, "Start.exe"), ""), writeFile(join(sandboxHome, "SbieIni.exe"), "")]);
  const previous = process.env.SANDBOXIE_HOME; const previousAppData = process.env.APPDATA; process.env.SANDBOXIE_HOME = sandboxHome; process.env.APPDATA = root;
  const commands = []; let configuredRoot = "";
  const runner = async (command, args) => { commands.push([command, args]); if (args[0] === "set" && args[2] === "FileRootPath") configuredRoot = args[3]; return { stdout: args[0] === "queryex" ? `FileRootPath=${configuredRoot}\n` : "", stderr: "", code: 0 }; };
  try {
    const service = new SynthVService(root, root, runner); const state = await service.createProfile("Isolated"); const slotId = state.slots[0].id;
    await service.prepareConcurrentProfile(slotId);
    const overlay = join(configuredRoot, "user", "current", "AppData", "Roaming", "Dreamtonics", "Synthesizer V Studio 2");
    assert.equal((await lstat(overlay)).isSymbolicLink(), true);
    assert.ok(commands.some(([, args]) => args[0] === "append" && args[2] === "OpenFilePath"));
  } finally { if (previous === undefined) delete process.env.SANDBOXIE_HOME; else process.env.SANDBOXIE_HOME = previous; if (previousAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = previousAppData; await rm(root, { recursive: true, force: true }); }
});
