import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertProperty, fc } from "../_lib/props.mjs";

const {
  SynthVService, bridgeProfile, bridgeStartPlan, isFlatExecutableName, isSynthVHostDisplayName, matchProcessesToInstallations,
  registeredInstallDirectories, windowTargetProcessIds, windowsPostableKey, windowsProcessExecutable, windowsProcessKind, windowsShortcutKeys,
} = await import(new URL("../../../src/PiDesktop.Tauri/electron/services/synthv-service.ts", import.meta.url).href);
const noBridge = { status: async () => ({ connected: false }), requestStop: async () => {} };
const windowsOnly = { skip: process.platform !== "win32" };

test("Windows process executables are read from quoted and unquoted command lines", () => {
  assert.equal(windowsProcessExecutable('"D:\\Synthesizer V Studio 2 Pro\\synthv-studio.exe" --project song.svp'), "D:\\Synthesizer V Studio 2 Pro\\synthv-studio.exe");
  assert.equal(windowsProcessExecutable("D:\\Synthesizer V Studio 2 Pro\\synthv-studio.exe --project song.svp"), "D:\\Synthesizer V Studio 2 Pro\\synthv-studio.exe");
  assert.equal(windowsProcessExecutable("D:\\Synthesizer V Studio Flat\\synthv-flat.exe"), "D:\\Synthesizer V Studio Flat\\synthv-flat.exe");
  assert.equal(windowsProcessExecutable("   "), null);
});

test("running processes are classified by executable name and install folder", () => {
  assert.equal(windowsProcessKind("D:\\Synthesizer V Studio Pro\\synthv-studio.exe"), "sv1");
  assert.equal(windowsProcessKind("D:\\Synthesizer V Studio 2 Pro\\synthv-studio.exe"), "sv2");
  assert.equal(windowsProcessKind("D:\\Synthesizer V Studio Flat\\synthv-flat.exe"), "flat");
  assert.equal(windowsProcessKind("D:\\Other\\synthv-studio.exe"), null);
  assert.equal(windowsProcessKind("C:\\x\\svstudio2-pro.exe"), "sv2");
  assert.equal(isFlatExecutableName("synthv-flat.exe"), true);
  assert.equal(isFlatExecutableName("D:\\Flat\\SYNTHV-FLAT.EXE"), true);
  assert.equal(isFlatExecutableName("flat-helper.exe"), false);
});

test("registry entries resolve to install folders and bridge profiles", () => {
  assert.deepEqual(registeredInstallDirectories("", '"D:\\Synthesizer V Studio Flat\\synthv-flat.exe",0'), ["D:\\Synthesizer V Studio Flat"]);
  assert.deepEqual(registeredInstallDirectories('"D:\\SV2"', ""), ["D:\\SV2"]);
  assert.equal(isSynthVHostDisplayName("Synthesizer V Studio Flat"), true);
  assert.equal(isSynthVHostDisplayName("Synthesizer V Studio 2 Pro"), true);
  assert.equal(isSynthVHostDisplayName("Visual Studio"), false);
  assert.equal(bridgeProfile("Synthesizer V Studio Flat"), "flat");
  assert.equal(bridgeProfile("Synthesizer V Studio 2 Pro"), "sv2");
  assert.equal(bridgeProfile("Synthesizer V Studio Pro"), "sv1");
  assert.equal(bridgeProfile("Synthesizer V Studio Basic"), "unsupported");
});

test("SV1 and SV2 processes sharing an executable name match their own install directories", () => {
  const installs = [
    { installPath: "D:\\Synthesizer V Studio Pro", bridgeProfile: "sv1" },
    { installPath: "D:\\Synthesizer V Studio 2 Pro", bridgeProfile: "sv2" },
    { installPath: "E:\\Flat", bridgeProfile: "flat" },
  ];
  const matches = matchProcessesToInstallations([
    { processId: 12, executablePath: "D:\\Synthesizer V Studio Pro\\synthv-studio.exe" },
    { processId: 13, executablePath: "d:\\synthesizer v studio 2 pro\\synthv-studio.exe" },
    { processId: 14, executablePath: "E:\\Flat\\synthv-flat.exe" },
    { processId: 15, executablePath: "C:\\Unregistered\\synthv-studio.exe" },
  ], installs);
  assert.equal(matches.get(12), installs[0]);
  assert.equal(matches.get(13), installs[1]);
  assert.equal(matches.get(14), installs[2]);
  assert.equal(matches.has(15), false);
});

test("a process never matches an install whose profile contradicts its folder", () => {
  const matches = matchProcessesToInstallations([{ processId: 1, executablePath: "D:\\Synthesizer V Studio 2 Pro\\synthv-studio.exe" }], [{ installPath: "D:\\Synthesizer V Studio 2 Pro", bridgeProfile: "sv1" }]);
  assert.equal(matches.size, 0);
});

test("process matching is order independent and only pairs a process with the install holding its executable", () => {
  const directory = fc.constantFrom("D:\\A", "D:\\B", "d:\\a", "E:\\C\\", "F:\\Synthesizer V Studio 2 Pro");
  const profile = fc.constantFrom("sv1", "sv2", "flat");
  const install = fc.record({ installPath: directory, bridgeProfile: profile });
  const processes = fc.uniqueArray(fc.record({ processId: fc.integer({ min: 1, max: 50 }), executablePath: fc.tuple(directory, fc.constantFrom("synthv-studio.exe", "synthv-flat.exe")).map(([dir, name]) => `${dir.replace(/\\$/, "")}\\${name}`) }), { selector: item => item.processId, maxLength: 8 });
  assertProperty(fc.record({ processes, installs: fc.array(install, { maxLength: 6 }) }), ({ processes: list, installs }) => {
    const forward = matchProcessesToInstallations(list, installs);
    const backward = matchProcessesToInstallations(list, [...installs].reverse());
    assert.ok(forward.size <= list.length);
    for (const [processId, match] of forward) {
      const process = list.find(item => item.processId === processId);
      const folder = value => value.replace(/\\[^\\]*$/, "").replace(/\\+$/, "").toLowerCase();
      assert.equal(folder(process.executablePath), match.installPath.replace(/\\+$/, "").toLowerCase());
      const peers = installs.filter(item => item.installPath.replace(/\\+$/, "").toLowerCase() === match.installPath.replace(/\\+$/, "").toLowerCase() && item.bridgeProfile === match.bridgeProfile);
      assert.ok(peers.length >= 1);
      assert.equal(backward.get(processId).bridgeProfile, match.bridgeProfile);
    }
  });
});

test("SV2 bridge shortcuts use the documented chords while other hosts use F13 and F14", () => {
  assert.deepEqual(windowsShortcutKeys("start", true), [0x11, 0x12, 0x10, 0x42]);
  assert.deepEqual(windowsShortcutKeys("stop", true), [0x11, 0x12, 0x10, 0x4e]);
  assert.deepEqual(windowsShortcutKeys("start", false), [0x7c]);
  assert.deepEqual(windowsShortcutKeys("stop", false), [0x7d]);
  assert.deepEqual(windowsShortcutKeys("startLegacy", true), [0x7c]);
  assert.deepEqual(windowsShortcutKeys("save", true), [0x11, 0x53]);
  assert.equal(windowsPostableKey("start", false), 0x7c);
  assert.equal(windowsPostableKey("start", true), 0);
  assert.equal(windowsPostableKey("save", false), 0);
});

test("SV2 rescans scripts before the start shortcut and other hosts do not", () => {
  assert.deepEqual(bridgeStartPlan(true), { refreshFirst: true, refreshSettleMs: 800 });
  assert.equal(bridgeStartPlan(false).refreshFirst, false);
});

test("a Flat launcher is focused through its editor child process", () => {
  const rows = [
    { processId: 5, parentProcessId: 1, name: "synthv-flat.exe", commandLine: "", executablePath: "D:\\Flat\\synthv-flat.exe" },
    { processId: 6, parentProcessId: 5, name: "synthv-studio.mz", commandLine: "", executablePath: "" },
    { processId: 7, parentProcessId: 6, name: "helper.exe", commandLine: "", executablePath: "" },
    { processId: 8, parentProcessId: 1, name: "synthv-studio.mz", commandLine: "", executablePath: "" },
    { processId: 9, parentProcessId: 1, name: "synthv-studio.exe", commandLine: "", executablePath: "D:\\Synthesizer V Studio 2 Pro\\synthv-studio.exe" },
  ];
  assert.deepEqual(windowTargetProcessIds(5, rows), [6]);
  assert.deepEqual(windowTargetProcessIds(9, rows), [9]);
  assert.deepEqual(windowTargetProcessIds(404, rows), [404]);
  assert.deepEqual(windowTargetProcessIds(5, rows.slice(0, 1)), []);
});

async function installFixture(prefix, entries) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const entry of entries) { await mkdir(entry.directory, { recursive: true }); await writeFile(join(entry.directory, entry.executable), ""); }
  return root;
}
function windowsRunner(state) {
  return async (command, args, _env, options) => {
    state.calls.push({ command, args, options });
    const script = args.at(-1) ?? "";
    if (script.includes("Get-ItemProperty")) return { stdout: JSON.stringify(state.registry ?? []), stderr: "", code: 0 };
    if (script.includes("Get-CimInstance")) return { stdout: JSON.stringify(state.processes ?? []), stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
}

test("registered Flat installs outside the standard folders are discovered by their launcher", windowsOnly, async () => {
  const state = { calls: [] };
  const root = await installFixture("synthv-flat-registered-", []);
  const flatDirectory = join(root, "Flat");
  await mkdir(flatDirectory, { recursive: true }); await writeFile(join(flatDirectory, "synthv-flat.exe"), "");
  state.registry = [{ DisplayName: "Synthesizer V Studio Flat", InstallLocation: "", DisplayIcon: `${join(flatDirectory, "synthv-flat.exe")},0` }, { DisplayName: "Unrelated", InstallLocation: root, DisplayIcon: "" }];
  try {
    const service = new SynthVService(root, root, noBridge, root, windowsRunner(state), undefined, root, { ProgramFiles: join(root, "none") });
    const flat = (await service.scanInstallations([])).filter(item => item.bridgeProfile === "flat");
    assert.equal(flat.length, 1);
    assert.equal(flat[0].executablePath, join(flatDirectory, "synthv-flat.exe"));
    assert.equal(flat[0].installPath, flatDirectory);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a running SV2 in a registered custom folder is recognised as SV2 and Flat editor children are not listed", windowsOnly, async () => {
  const root = await installFixture("synthv-custom-sv2-", []);
  const sv2Directory = join(root, "Tools", "Audio");
  await mkdir(sv2Directory, { recursive: true }); await writeFile(join(sv2Directory, "synthv-studio.exe"), "");
  const state = {
    calls: [],
    registry: [{ DisplayName: "Synthesizer V Studio 2 Pro", InstallLocation: sv2Directory, DisplayIcon: "" }],
    processes: [
      { ProcessId: 21, ParentProcessId: 1, Name: "synthv-studio.exe", CommandLine: `"${join(sv2Directory, "synthv-studio.exe")}" song.svp`, ExecutablePath: join(sv2Directory, "synthv-studio.exe") },
      { ProcessId: 22, ParentProcessId: 1, Name: "synthv-flat.exe", CommandLine: "D:\\Flat\\synthv-flat.exe", ExecutablePath: "D:\\Flat\\synthv-flat.exe" },
      { ProcessId: 23, ParentProcessId: 22, Name: "synthv-studio.mz", CommandLine: "D:\\Flat\\synthv-studio.mz", ExecutablePath: "D:\\Flat\\synthv-studio.mz" },
    ],
  };
  try {
    const service = new SynthVService(root, root, noBridge, root, windowsRunner(state), undefined, root, { ProgramFiles: join(root, "none") });
    const listed = await service.listProcesses();
    assert.deepEqual(listed.map(item => [item.processId, item.isSv2]), [[21, true], [22, false]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shortcuts reach the Flat editor child and use the SV2 chord for SV2", windowsOnly, async () => {
  const root = await installFixture("synthv-shortcut-target-", []);
  const state = {
    calls: [],
    processes: [
      { ProcessId: 5, ParentProcessId: 1, Name: "synthv-flat.exe", CommandLine: "D:\\Flat\\synthv-flat.exe", ExecutablePath: "D:\\Flat\\synthv-flat.exe" },
      { ProcessId: 6, ParentProcessId: 5, Name: "synthv-studio.mz", CommandLine: "", ExecutablePath: "" },
      { ProcessId: 9, ParentProcessId: 1, Name: "synthv-studio.exe", CommandLine: '"D:\\Synthesizer V Studio 2 Pro\\synthv-studio.exe"', ExecutablePath: "D:\\Synthesizer V Studio 2 Pro\\synthv-studio.exe" },
    ],
  };
  try {
    const service = new SynthVService(root, root, noBridge, root, windowsRunner(state), undefined, root, { ProgramFiles: join(root, "none") });
    const [flat, sv2] = await service.listProcesses();
    await service.sendShortcut(flat.processId, flat.processIdentity, "start");
    assert.ok(state.calls.at(-1).args.at(-1).endsWith("'6' '124' 124"));
    await service.sendShortcut(sv2.processId, sv2.processIdentity, "start");
    assert.ok(state.calls.at(-1).args.at(-1).endsWith("'9' '17,18,16,66' 0"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sandboxed SV2 launches keep their window visible", windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), "synthv-visible-launch-"));
  const sandboxHome = join(root, "Sandboxie-Plus");
  const sv2Directory = join(root, "Synthesizer V Studio 2 Pro");
  await mkdir(sandboxHome, { recursive: true }); await mkdir(sv2Directory, { recursive: true });
  await Promise.all([writeFile(join(sandboxHome, "Start.exe"), ""), writeFile(join(sandboxHome, "SbieIni.exe"), ""), writeFile(join(sv2Directory, "synthv-studio.exe"), "")]);
  const state = { calls: [], registry: [{ DisplayName: "Synthesizer V Studio 2 Pro", InstallLocation: sv2Directory, DisplayIcon: "" }] };
  const base = windowsRunner(state);
  let configuredRoot = "";
  const runner = async (command, args, env, options) => {
    if (args[0] === "set" && args[2] === "FileRootPath") configuredRoot = args[3];
    if (args[0] === "queryex") return { stdout: `FileRootPath=${configuredRoot}\n`, stderr: "", code: 0 };
    return base(command, args, env, options);
  };
  try {
    const service = new SynthVService(root, root, noBridge, root, runner, undefined, root, { SANDBOXIE_HOME: sandboxHome, ProgramFiles: join(root, "none") });
    await service.createProfile("Isolated"); await service.createProfile("Second");
    const slots = (await service.profileState()).slots;
    const slotId = slots.find(slot => slot.displayName === "Isolated").id;
    await service.activateProfile(slots.find(slot => slot.displayName === "Second").id);
    const result = await service.launchConcurrentProfile(slotId);
    assert.equal(result.succeeded, true);
    const start = state.calls.find(call => call.command.endsWith("Start.exe") && call.args[0].startsWith("/box:"));
    assert.equal(start.options?.visible, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
