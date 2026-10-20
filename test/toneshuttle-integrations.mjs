import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BRAND, FILE_NAMES, LEGACY_FILE_NAMES, STABLE_IDENTIFIERS } from "../src/PiDesktop.Tauri/dist/electron/brand.js";
import { agentSystemPrompt } from "../src/PiDesktop.Tauri/dist/electron/services/agent-identity.js";
import { legacyExecutableCandidates, loginItemLookupPath, migrateAutostart } from "../src/PiDesktop.Tauri/dist/electron/services/autostart-migration.js";
import { DesktopStateService } from "../src/PiDesktop.Tauri/dist/electron/services/desktop-state.js";
import { isIntegrationPreference, resolveSynthVIntegration } from "../src/PiDesktop.Tauri/dist/electron/services/integrations.js";
import { unavailableBridge } from "../src/PiDesktop.Tauri/dist/electron/services/synthv-bridge.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const noEvidence = { installations: 0, profiles: 0, bridgeConnected: false };

test("explicit integration preferences always win over machine evidence", () => {
  assert.equal(resolveSynthVIntegration("on", noEvidence), true);
  assert.equal(resolveSynthVIntegration("off", { installations: 2, profiles: 1, bridgeConnected: true }), false);
  assert.equal(isIntegrationPreference("auto"), true);
  assert.equal(isIntegrationPreference("enabled"), false);
});

test("auto enables SynthV only when this machine shows it is in use", () => {
  assert.equal(resolveSynthVIntegration("auto", noEvidence), false, "nothing found: the toolbox starts without SynthV");
  assert.equal(resolveSynthVIntegration("auto", { ...noEvidence, installations: 1 }), true, "an installed Synthesizer V");
  assert.equal(resolveSynthVIntegration("auto", { ...noEvidence, profiles: 1 }), true, "SV2 account slots kept in the app");
  assert.equal(resolveSynthVIntegration("auto", { ...noEvidence, bridgeConnected: true }), true, "a Bridge script connected from SynthV, wherever it is installed");
});

function fakeServices(probe) {
  const runtime = { settingsSnapshot: () => ({ pluginInternalFunctionsEnabled: false, pluginAdvancedFunctionsEnabled: false }) };
  const ai = { ai_provider_state: async () => ({ providers: [] }), agent_budgets: async () => ({}) };
  return { runtime, ai, probe };
}

function synthvProbe(overrides = {}) {
  const calls = [];
  return {
    calls,
    scanInstallations: async () => { calls.push("scan"); return [{ displayName: "Synthesizer V Studio 2 Pro", bridgeProfile: "sv2" }]; },
    profileState: async () => { calls.push("profiles"); return { supported: true, slots: [{ id: "a" }], concurrentProvider: { available: false, detail: "none" } }; },
    bridgeStatus: async () => { calls.push("bridge"); return { connected: true }; },
    getAutostart: async () => ({ enabled: false, error: null }),
    ...overrides,
  };
}

async function withState(settings, probe, run, bridgeLoadError) {
  const directory = await mkdtemp(join(tmpdir(), "toneshuttle-state-"));
  try {
    if (settings) await writeFile(join(directory, "desktop-settings.json"), JSON.stringify(settings), "utf8");
    const { runtime, ai } = fakeServices(probe);
    const state = new DesktopStateService(directory, "9.9.9", runtime, ai, probe, undefined, undefined, bridgeLoadError);
    await state.load();
    await run(state, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("existing settings files without integrations default to auto and keep SynthV features", async () => {
  const probe = synthvProbe();
  await withState({ onboardingCompleted: true, mode: "ai" }, probe, async (state) => {
    const app = await state.bootstrap();
    assert.equal(app.integrations.synthv.preference, "auto");
    assert.equal(app.integrations.synthv.enabled, true);
    assert.equal(app.installations.length, 1);
    assert.equal(app.bridgeConnected, true);
    assert.ok(app.components.some(component => component.id === "cvrs"));
    assert.equal(state.synthvEnabled(), true);
  });
});

test("auto with nothing detected hides SynthV but keeps probing, and turns it on once SynthV shows up", async () => {
  let installed = false;
  const probe = synthvProbe({
    scanInstallations: async () => { probe.calls.push("scan"); return installed ? [{ displayName: "Synthesizer V Studio 2 Pro", bridgeProfile: "sv2" }] : []; },
    profileState: async () => { probe.calls.push("profiles"); return { supported: true, slots: [], concurrentProvider: { available: false, detail: "none" } }; },
    bridgeStatus: async () => { probe.calls.push("bridge"); return { connected: false }; },
  });
  await withState({ onboardingCompleted: true }, probe, async (state) => {
    const app = await state.bootstrap();
    assert.equal(app.integrations.synthv.preference, "auto");
    assert.equal(app.integrations.synthv.enabled, false);
    assert.equal(app.integrations.synthv.detected, false);
    assert.ok(!app.components.some(component => component.id === "cvrs"));
    assert.equal(state.synthvEnabled(), false);
    assert.ok(probe.calls.includes("scan"), "auto keeps looking for SynthV while it resolves to off");
    installed = true;
    const next = await state.bootstrap();
    assert.equal(next.integrations.synthv.enabled, true, "the next refresh picks up a new installation");
    assert.equal(next.integrations.synthv.detected, true);
    assert.equal(next.installations.length, 1);
    assert.equal(state.synthvEnabled(), true);
  });
});

test("auto re-detects without a renderer refresh, keeps a Bridge it has seen, and counts the scripts folder set up for it", async () => {
  let installed = false, connected = false;
  const probe = synthvProbe({
    scanInstallations: async () => { probe.calls.push("scan"); return installed ? [{ displayName: "Synthesizer V Studio 2 Pro", bridgeProfile: "sv2" }] : []; },
    profileState: async () => ({ supported: true, slots: [], concurrentProvider: { available: false, detail: "none" } }),
    bridgeStatus: async () => ({ connected }),
  });
  await withState({ onboardingCompleted: true }, probe, async (state) => {
    assert.equal(state.synthvEnabled(), false);
    assert.equal(await state.refreshSynthV(), false, "nothing new: no change to report");
    connected = true;
    assert.equal(await state.refreshSynthV(), true, "the main process notices a Bridge without the renderer calling bootstrap");
    assert.equal(state.synthvEnabled(), true);
    connected = false;
    assert.equal(await state.refreshSynthV(), true, "the renderer hears that the Bridge went down...");
    assert.equal(state.synthvEnabled(), true, "...but a missed heartbeat or a stopped Bridge does not hide SynthV mid-session");
  });
  const scripts = await mkdtemp(join(tmpdir(), "toneshuttle-flat-scripts-"));
  try {
    // A Flat user set up the Bridge through the manual form; the scanner knows no Flat path.
    await withState({ onboardingCompleted: true, scriptsPath: scripts }, synthvProbe({ scanInstallations: async () => [], profileState: async () => ({ supported: true, slots: [] }), bridgeStatus: async () => ({ connected: false }) }), async (state) => {
      const app = await state.bootstrap();
      assert.equal(app.integrations.synthv.enabled, true, "the scripts folder the app installed the Bridge into counts as an installation");
      assert.equal(app.integrations.synthv.detected, true);
      await rm(scripts, { recursive: true, force: true });
      assert.equal(await state.refreshSynthV(), true, "a folder that no longer exists is not evidence");
      assert.equal(state.synthvEnabled(), false);
    });
  } finally { await rm(scripts, { recursive: true, force: true }); }
  const preferenceOn = synthvProbe();
  await withState({ integrations: { synthv: "on" } }, preferenceOn, async (state) => {
    preferenceOn.calls.length = 0;
    assert.equal(await state.refreshSynthV(), false, "On still probes, for the Bridge state, but reports only changes");
    assert.ok(preferenceOn.calls.includes("bridge"));
  });
  const main = await readFile(join(root, "src/PiDesktop.Tauri/electron/main.ts"), "utf8");
  assert.match(main, /app\.on\("browser-window-focus", \(\) => \{ void refreshSynthV\(\); \}\)/, "focus re-detects");
  assert.match(main, /setInterval\(\(\) => \{ if \(!desktop\.synthvEnabled\(\)\) void refreshSynthV\(\); \}, 10_000\)\.unref\(\)/, "a timer re-detects while auto is off");
  assert.match(main, /emitToRenderer\("integrations\.changed", null\)/);
  const renderer = await readFile(join(root, "src/PiDesktop.Tauri/src/main.ts"), "utf8");
  assert.match(renderer, /listenDesktop<null>\("integrations\.changed"/, "the renderer re-bootstraps when detection changes");
  assert.match(renderer, /await listenForIntegrationChanges\(\);/);
});

test("a refresh reports a Bridge that connects while the integration is already on", async () => {
  let connected = false;
  const probe = synthvProbe({ bridgeStatus: async () => ({ connected }) });
  await withState({ onboardingCompleted: true }, probe, async (state) => {
    assert.equal(state.synthvEnabled(), true, "the installation already turned auto on");
    assert.equal(await state.refreshSynthV(), false);
    connected = true;
    assert.equal(await state.refreshSynthV(), true, "the renderer must learn that the Bridge is up, though the switch did not move");
    assert.equal((await state.bootstrap()).bridgeConnected, true);
    assert.equal(await state.refreshSynthV(), false, "nothing new since");
  });
  const off = synthvProbe();
  await withState({ integrations: { synthv: "off" } }, off, async (state) => {
    assert.equal(await state.refreshSynthV(), false);
    assert.deepEqual(off.calls, [], "off never probes");
  });
});

test("History and the renderer's command path leave .svp backups alone while SynthV is off", async () => {
  const { ElectronCommandRegistry } = await import("../src/PiDesktop.Tauri/dist/electron/services/command-registry.js");
  const calls = [];
  let enabled = false;
  const creative = { invoke: async (command, params) => { calls.push(command); return { ok: true }; } };
  const host = { settingsSnapshot: () => ({}), runtime: {} };
  const inert = new Proxy({}, { get: () => async () => ({}) });
  const registry = new ElectronCommandRegistry(host, { ai: inert, creative, desktop: { ...inert, synthvEnabled: () => enabled, update: async () => ({}) }, synthv: inert, approvals: inert, componentAudio: { dataRoot: process.cwd() } });
  await assert.rejects(registry.invoke("restore_project_checkpoint", { id: "c1", outputName: "a.svp" }), /turned off/);
  await assert.rejects(registry.invoke("list_project_checkpoints", {}), /turned off/);
  assert.deepEqual(await registry.invoke("list_creative_history", {}), { ok: true }, "workflow history stays");
  // The renderer's pasted-lyrics form sends projectPath: null; only a real path is project work.
  assert.deepEqual(await registry.invoke("run_pronunciation_diagnostics", { projectPath: null, lyrics: "你好" }), { ok: true }, "lyrics-only checks pass with the integration off");
  await assert.rejects(registry.invoke("run_pronunciation_diagnostics", { projectPath: "C:\\Songs\\a.svp", lyrics: null }), /turned off/);
  enabled = true;
  assert.deepEqual(await registry.invoke("restore_project_checkpoint", { id: "c1", outputName: "a.svp" }), { ok: true });
  assert.deepEqual(calls, ["list_creative_history", "run_pronunciation_diagnostics", "restore_project_checkpoint"]);
  const renderer = await readFile(join(root, "src/PiDesktop.Tauri/src/main.ts"), "utf8");
  assert.match(renderer, /synthv \? api\.projectBackupState\(\) : Promise\.resolve\(undefined\)/, "History does not read backups with the integration off");
  assert.match(renderer, /synthv \? api\.listProjectCheckpoints\(\) : Promise\.resolve\(\[\]\)/);
  assert.match(renderer, /\$\{synthvOn\(\) \? `<section class="panel history-checkpoint-grid">/, "nor offers restore buttons");
  assert.match(renderer, /if \(busy\) \{ integrationRefreshPending = true; return; \}/, "a change during a task is kept");
  for (const probe of ["listSynthvProcesses()", "synthvShortcutProfile()", "bridgeSessionStatus()"]) assert.ok(renderer.includes(`synthv ? api.${probe}`), `refresh() skips ${probe} with the integration off`);
  assert.match(renderer, /\$\{synthvOn\(\) \? renderLyricBridgeFit\(\) : ""\}/, "the Lyrics page keeps its editor but drops the Bridge panel");
  assert.match(renderer, /busy = false;\r?\n    if \(integrationRefreshPending\) refreshForIntegrations\(\);/, "and replayed when it ends");
  const main = await readFile(join(root, "src/PiDesktop.Tauri/electron/main.ts"), "utf8");
  assert.match(main, /servers: \(\) => desktop\.aiModeEnabled\(\) \? mcpServerConfigs\(desktop\.enabledMcpServers\(\)\) : \[\]/, "a session initialized after AI mode was turned off starts no external server");
});

test("Cover and creative bridge calls report a gate refusal or a non-JSON failure instead of a SyntaxError", async () => {
  const { gatedBridge } = await import("../src/PiDesktop.Tauri/dist/electron/services/synthv-bridge.js");
  const { createCoverHost } = await import("../src/PiDesktop.Tauri/dist/electron/services/cover-host.js");
  const raw = { tools: ["sv_status", "sv_query", "sv_command", "sv_ui", "sv_describe"].map((name) => ({ name, title: name, description: "", annotations: {}, inputSchema: {}, call: async () => ({ text: "{}", isError: false }) })), instructions: "", classify: () => ({ category: "read", risk: "normal" }), status: async () => ({ connected: true, status: { sessionToken: "s", projectFile: "/songs/a.svp" } }), requestStop: async () => undefined, close: async () => undefined };
  const cover = createCoverHost(gatedBridge(raw, () => false), { listProcesses: async () => [], sendShortcut: async () => ({}) });
  const failure = await Promise.resolve().then(() => cover.verify({ sessionToken: "s", projectFile: "/songs/a.svp", trackIndex: 1, groupIndex: 1, groupName: "g", timeline: [], notes: [] })).then(() => undefined, (error) => error);
  assert.ok(failure instanceof Error && !(failure instanceof SyntaxError), `expected a readable refusal, got ${failure}`);
  assert.match(failure.message, /SYNTHV_INTEGRATION_OFF/);
  // A host failure that is not JSON keeps its own text; a success that is not JSON is still a protocol error.
  const { createCreativeBridge } = await import("../src/PiDesktop.Tauri/dist/electron/services/creative-bridge.js");
  for (const [reply, expected] of [[{ text: "host crashed", isError: true }, /BRIDGE_ERROR: host crashed/], [{ text: "not json", isError: false }, SyntaxError]]) {
    const host = { ...raw, tools: raw.tools.map((tool) => ({ ...tool, call: async () => reply })) };
    const creative = createCreativeBridge(host);
    const outcome = await Promise.resolve().then(() => creative.invoke("read_lyric_bridge_selection", {})).then(() => undefined, (error) => error);
    assert.ok(expected instanceof RegExp ? expected.test(String(outcome?.message)) : outcome instanceof expected, `${reply.text}: ${outcome}`);
  }
});

test("turning SynthV off skips every SynthV probe and hides its components", async () => {
  const probe = synthvProbe();
  await withState({ integrations: { synthv: "off" } }, probe, async (state, directory) => {
    const app = await state.bootstrap();
    assert.deepEqual(probe.calls, [], "no SynthV probe may run while the integration is off");
    assert.equal(app.integrations.synthv.enabled, false);
    assert.deepEqual(app.installations, []);
    assert.equal(app.bridgeConnected, false);
    assert.deepEqual(app.sv2Profiles.slots, []);
    assert.equal(app.svpAssociation.supported, false);
    assert.ok(!app.components.some(component => component.id === "cvrs" || component.id === "sandboxie"));
    assert.ok(app.components.some(component => component.id === "ffmpeg"));
    assert.equal(state.synthvEnabled(), false);
    const next = await state.setIntegration("synthv", "on");
    assert.equal(next.integrations.synthv.enabled, true);
    assert.equal(JSON.parse(await readFile(join(directory, "desktop-settings.json"), "utf8")).integrations.synthv, "on");
  });
});

test("a failing SynthV probe degrades to an error instead of failing bootstrap", async () => {
  const probe = synthvProbe({ scanInstallations: async () => { throw new Error("registry unavailable"); } });
  await withState(undefined, probe, async (state) => {
    const app = await state.bootstrap();
    assert.deepEqual(app.installations, []);
    assert.deepEqual(app.integrations.synthv.errors, ["registry unavailable"]);
    assert.equal(app.sv2Profiles.slots.length, 1);
  });
});

test("a bridge that failed to load is reported, not fatal", async () => {
  const bridge = unavailableBridge("missing dist/src/embedded.js", {});
  assert.deepEqual(bridge.tools, []);
  assert.equal((await bridge.status()).connected, false);
  // Repairing the Bridge install needs no embedded client, only the folder the SynthV scripts and the component agree on.
  assert.equal((await bridge.status()).ipcDirectory, resolve(tmpdir()));
  assert.equal((await unavailableBridge("x", { SYNTHV_AGENT_BRIDGE_DIR: " /custom/ipc " }).status()).ipcDirectory, resolve("/custom/ipc"));
  await withState(undefined, synthvProbe({ bridgeStatus: () => bridge.status() }), async (state) => {
    const app = await state.bootstrap();
    assert.equal(app.bridgeBundled, false);
    assert.equal(app.integrations.synthv.bridgeLoaded, false);
    assert.ok(app.integrations.synthv.errors.includes("missing dist/src/embedded.js"));
  }, "missing dist/src/embedded.js");
});

test("the agent's SynthV tools check the integration on every call, so turning it off stops a run or approval in progress", async () => {
  const { gatedBridge, SYNTHV_OFF_MESSAGE } = await import("../src/PiDesktop.Tauri/dist/electron/services/synthv-bridge.js");
  let enabled = true;
  const calls = [];
  const raw = { tools: [{ name: "sv_write_notes", title: "Write", description: "", annotations: {}, inputSchema: {}, call: async (input) => { calls.push(input); return { text: "written", isError: false }; } }], instructions: "use sv_*", classify: () => ({ category: "projectWrite", risk: "normal" }), status: async () => ({ connected: true, ipcDirectory: "/ipc" }), requestStop: async () => {}, close: async () => {} };
  const bridge = gatedBridge(raw, () => enabled);
  assert.deepEqual(await bridge.tools[0].call({ notes: 1 }), { text: "written", isError: false });
  enabled = false;
  const refused = await bridge.tools[0].call({ notes: 2 });
  assert.equal(refused.isError, true);
  // The bridge's own failure envelope, so Cover, the creative workflows and approvals read it as a failed call.
  assert.deepEqual(JSON.parse(refused.text), { outcome: "failed", phase: "accepted", wrote: false, undoRequired: false, retry: "correct_request", error: { code: "SYNTHV_INTEGRATION_OFF", message: SYNTHV_OFF_MESSAGE } });
  assert.match(SYNTHV_OFF_MESSAGE, /set to Off, or Auto has not detected/, "the refusal does not claim the user chose Off");
  assert.deepEqual(calls, [{ notes: 1 }], "nothing reaches SynthV once the integration is off");
  assert.equal((await bridge.status()).connected, true, "status and install stay available");
  const main = await readFile(join(root, "src/PiDesktop.Tauri/electron/main.ts"), "utf8");
  assert.match(main, /const gatedSynthvBridge = gatedBridge\(bridge, \(\) => desktop\.synthvEnabled\(\)\)/);
  for (const use of ["createCoverHost(gatedSynthvBridge", "execute: async (item) => gatedSynthvBridge.tools", "createSynthVToolsExtension({ bridge: gatedSynthvBridge", "}, gatedSynthvBridge, cover);"]) assert.ok(main.includes(use), use);
  assert.match(main, /invoke: \(command, args\) => desktop\.synthvEnabled\(\) \? cover\.invoke\(command, args\) : Promise\.reject/);
});

test("toolbox-only mode stops agent runs in progress and refuses new ones", async () => {
  const main = await readFile(join(root, "src/PiDesktop.Tauri/electron/main.ts"), "utf8");
  assert.match(main, /agentAllowed: \(\) => desktop\.aiModeEnabled\(\)/u, "every run checks the mode before it starts");
  assert.match(main, /if \(!desktop\.aiModeEnabled\(\)\) void ai\.cancel_all_agent_runs\(\)/u, "leaving AI mode stops toolbox_agent tasks, chats and Cover phases already running");
});

test("the agent introduces itself as the toolbox and names only active integrations", () => {
  const on = agentSystemPrompt({ synthv: true });
  const off = agentSystemPrompt({ synthv: false });
  assert.match(on, new RegExp(BRAND.productName));
  assert.match(on, /Active integrations: Synthesizer V/);
  assert.match(off, /Active integrations: none\./);
  assert.notEqual(on, off, "toggling an integration must change the prompt so the Pi session is recreated");
  assert.doesNotMatch(on, /coding assistant/i);
});

test("launch-at-login entries of the renamed executable move to the new one and keep their enabled state", async () => {
  // A non-ASCII profile path: `reg query` would have garbled it, Electron's login-item API does not.
  const current = "C:\\Users\\张三\\AppData\\Local\\Programs\\Toneshuttle\\Toneshuttle.exe";
  const candidates = legacyExecutableCandidates(current, LEGACY_FILE_NAMES, "C:\\Users\\张三\\AppData\\Local");
  assert.deepEqual(candidates, ["C:\\Users\\张三\\AppData\\Local\\Programs\\Toneshuttle\\Synthesizer V Toolbox.exe", "C:\\Users\\张三\\AppData\\Local\\Programs\\synthv-toolbox\\Synthesizer V Toolbox.exe"], "the default old folder is listed once");
  assert.deepEqual(legacyExecutableCandidates("E:\\Apps\\Toneshuttle\\Toneshuttle.exe", LEGACY_FILE_NAMES, "C:\\Users\\me\\AppData\\Local").at(-1), "C:\\Users\\me\\AppData\\Local\\Programs\\synthv-toolbox\\Synthesizer V Toolbox.exe", "an upgrade installed elsewhere with /D= still finds the default old folder");
  const items = { [candidates[1]]: [
    { name: "electron.app.synthv-toolbox", path: candidates[1].toUpperCase(), scope: "user", enabled: false },
    { name: "Policy", path: candidates[1], scope: "machine", enabled: true },
    // What an unquoted lookup returned on a real machine: another app's entry whose own path was cut at a space.
    { name: "Docker Desktop", path: "C:\\Program", scope: "user", enabled: true },
  ] };
  const actions = [];
  const ports = (overrides = {}) => ({ execPath: current, legacyExecutables: candidates, fileExists: () => false, launchItems: (path) => items[path] ?? [], remove: (name) => actions.push(`remove:${name}`), register: (enabled) => actions.push(`register:${enabled}`), ...overrides });
  assert.deepEqual(migrateAutostart(ports()), ["electron.app.synthv-toolbox"]);
  assert.deepEqual(actions, ["remove:electron.app.synthv-toolbox", "register:false"], "removal comes first, other apps' and machine-wide entries are untouched, and an entry disabled in Task Manager stays disabled");
  actions.length = 0;
  assert.deepEqual(migrateAutostart(ports({ fileExists: () => true })), [], "an old executable that still exists belongs to another install");
  assert.deepEqual(migrateAutostart(ports({ launchItems: () => [] })), []);
  assert.deepEqual(actions, [], "nothing is registered when there was nothing to move");
  assert.deepEqual(legacyExecutableCandidates("C:\\Programs\\synthv-toolbox\\Synthesizer V Toolbox.exe", LEGACY_FILE_NAMES), [], "the old build never migrates its own entry");
  // Electron parses the lookup as a command line; unquoted, "...\\Synthesizer V Toolbox.exe" would be read as "...\\Synthesizer".
  assert.equal(loginItemLookupPath(candidates[1]), `"${candidates[1]}"`);
  const main = await readFile(join(root, "src/PiDesktop.Tauri/electron/main.ts"), "utf8");
  assert.match(main, /launchItems: path => app\.getLoginItemSettings\(\{ path: loginItemLookupPath\(path\)/u);
});

test("file names agree across brand.ts, the builder config and the installer hooks, and install identifiers are unchanged", async () => {
  const renderer = await readFile(join(root, "src/PiDesktop.Tauri/src/brand.ts"), "utf8");
  for (const value of [BRAND.productName, BRAND.productNameZh, BRAND.slug, BRAND.repositoryUrl]) assert.ok(renderer.includes(`"${value}"`), `src/brand.ts must mirror ${value}`);
  const builder = await readFile(join(root, "electron-builder.yml"), "utf8");
  assert.match(builder, new RegExp(`^productName: ${BRAND.productName}$`, "m"));
  assert.match(builder, new RegExp(`^appId: ${STABLE_IDENTIFIERS.appId.replaceAll(".", "\\.")}$`, "m"));
  assert.match(builder, new RegExp(`guid: ${STABLE_IDENTIFIERS.nsisGuid}`));
  assert.match(builder, new RegExp(`^  executableName: ${FILE_NAMES.windowsExecutable.replace(/\.exe$/u, "")}$`, "m"));
  const pkg = JSON.parse(await readFile(join(root, "src/PiDesktop.Tauri/package.json"), "utf8"));
  assert.equal(pkg.name, STABLE_IDENTIFIERS.packageName, "the package name fixes app.name: the login-item value name and the macOS keychain item");
  assert.equal(LEGACY_FILE_NAMES.windowsInstallDirectory, STABLE_IDENTIFIERS.packageName, "electron-builder names the default per-user folder after the package name");
  const nsh = await readFile(join(root, "src/PiDesktop.Tauri/electron/assets/installer.nsh"), "utf8");
  const define = (name) => new RegExp(`^!define ${name} "([^"]+)"$`, "m").exec(nsh)?.[1];
  assert.equal(define("INSTALL_DIRECTORY"), FILE_NAMES.windowsInstallDirectory);
  assert.equal(define("LEGACY_INSTALL_DIRECTORY"), LEGACY_FILE_NAMES.windowsInstallDirectory);
  assert.equal(define("LEGACY_EXECUTABLE"), LEGACY_FILE_NAMES.windowsExecutable);
  assert.equal(FILE_NAMES.userDataDirectory, BRAND.productName, "the NSIS --delete-app-data cleanup removes $APPDATA\\<product file name>");
  const main = await readFile(join(root, "src/PiDesktop.Tauri/electron/main.ts"), "utf8");
  const order = ["resolveUserDataDirectory({", "app.setPath(\"userData\"", "requestSingleInstanceLock"].map((marker) => main.indexOf(marker));
  assert.ok(order.every((index, position) => index > 0 && (position === 0 || index > order[position - 1])), "the folder must be moved, then pinned, before the single-instance lock creates it");
  assert.match(main, /hasSwitch\("user-data-dir"\) \? undefined/, "an explicit --user-data-dir wins and is never migrated");
  assert.match(main, /if \(dataDirectory\?\.busy \|\| !app\.requestSingleInstanceLock\(\)\)/u, "a start that finds another one mid-migration leaves like a second instance");
});

test("the installer moves the install folder without touching the registry or the uninstaller", async () => {
  const nsh = await readFile(join(root, "src/PiDesktop.Tauri/electron/assets/installer.nsh"), "utf8");
  const code = nsh.split(/\r?\n/u).filter((line) => !line.trimStart().startsWith(";")).join("\n");
  assert.doesNotMatch(code, /WriteReg/u, "writing InstallLocation before the old uninstaller runs would make it clean the new folder");
  assert.doesNotMatch(code, /customUnInstall|customRemoveFiles|customUnInit|!macro un\./u, "the old build's stock uninstaller runs during this upgrade, so uninstaller hooks would not");
  const guard = code.indexOf("!ifndef BUILD_UNINSTALLER");
  assert.ok(guard >= 0 && code.indexOf("Var legacyInstallDir") > guard, "an installer-only variable would be an unused-variable error in the uninstaller pass");
  assert.ok(code.lastIndexOf("!endif") > code.indexOf("!macroend", code.indexOf("!macro customInstall")), "the guard closes after the last installer hook");
  assert.match(code, /\$\{AndIfNot\} \$\{isUpdated\}\n\s+!insertmacro FIND_LEGACY_APP\n\s+\$\{if\} \$R3 == 0\n\s+MessageBox MB_OKCANCEL/u, "a manual upgrade asks before the old app is closed");
  assert.match(code, /!insertmacro FIND_LEGACY_APP\n\s+\$\{if\} \$R3 == 0\n\s+DetailPrint/u, "a still-running old copy is never half deleted");
  assert.match(code, /!insertmacro GetDParameter \$R0\n\s+\$\{if\} \$R0 == ""/u, "an explicit /D= folder is kept");
  assert.match(code, /RMDir \/r "\$legacyInstallDir"/u);
  assert.match(code, /StrCpy \$legacyInstallDir "\$INSTDIR"/u, "only a folder that came from the registry is ever removed");
  const builder = await readFile(join(root, "electron-builder.yml"), "utf8");
  assert.match(builder, /^ {2}include: src\/PiDesktop\.Tauri\/electron\/assets\/installer\.nsh$/mu);
});

test("generic agent tools route to existing host commands and reject untrusted arguments", async () => {
  const { createToolboxAgentToolsExtension, TOOLBOX_AGENT_TOOLS } = await import("../src/PiDesktop.Tauri/dist/electron/services/toolbox-agent-tools.js");
  const registry = await readFile(join(root, "src/PiDesktop.Tauri/electron/services/command-registry.ts"), "utf8");
  const audio = await readFile(join(root, "src/PiDesktop.Tauri/electron/services/component-audio-commands.ts"), "utf8");
  for (const spec of TOOLBOX_AGENT_TOOLS) {
    assert.ok(registry.includes(`"${spec.command}"`) || audio.includes(`registry.register("${spec.command}"`), `${spec.name} targets an unregistered command ${spec.command}`);
    assert.match(spec.name, /^toolbox_[a-z_]+$/, "tool names must satisfy the Anthropic and OpenAI name pattern");
  }
  const calls = [];
  const tools = new Map();
  let prompt = "base";
  createToolboxAgentToolsExtension({ invoke: async (command, args) => { calls.push([command, args]); return { ok: true }; } }).factory({
    on: (event, handler) => { if (event === "before_agent_start") prompt = handler({ systemPrompt: prompt }).systemPrompt; },
    registerTool: (tool) => tools.set(tool.name, tool),
  });
  assert.match(prompt, /## Toolbox tools/);
  assert.deepEqual([...tools.keys()], TOOLBOX_AGENT_TOOLS.map(spec => spec.name));
  for (const tool of tools.values()) assert.equal(tool.parameters.type, "object");
  const take = process.platform === "win32" ? "C:\\takes\\a.wav" : "/takes/a.wav";
  const features = await tools.get("toolbox_audio_features").execute("1", { path: take, notes: true });
  assert.deepEqual(calls.at(-1), ["run_audio_probe", { audioPath: take, advanced: true }]);
  assert.equal(features.content[0].text, JSON.stringify({ ok: true }));
  await tools.get("toolbox_history").execute("2", {});
  assert.deepEqual(calls.at(-1), ["list_creative_history", { limit: 20 }]);
  await assert.rejects(tools.get("toolbox_audio_probe").execute("3", {}), /requires path/);
  await assert.rejects(tools.get("toolbox_audio_probe").execute("4", { path: "x", command: "rm" }), /does not accept command/);
  await assert.rejects(tools.get("toolbox_lyrics_rhymes").execute("5", { query: "风", matchMode: "fuzzy" }), /matchMode is invalid/);
  await assert.rejects(tools.get("toolbox_history").execute("6", { limit: 500 }), /out of range/);
  assert.equal(calls.length, 2, "rejected calls must never reach the host");
});

test("toolbox_history gives the agent summaries, and every toolbox tool result is bounded", async () => {
  const { createToolboxAgentToolsExtension, TOOLBOX_TOOL_OUTPUT_LIMIT } = await import("../src/PiDesktop.Tauri/dist/electron/services/toolbox-agent-tools.js");
  const history = [{ id: "h1", kind: "batch", title: "Batch", summary: "3 files", createdAtUtc: "2026-10-19T00:00:00Z", outputPath: "C:\\out\\report.json", parameters: { files: ["x".repeat(5_000)] }, result: { rows: "y".repeat(5_000) } }];
  const tools = new Map();
  createToolboxAgentToolsExtension({ invoke: async (command, args) => command === "list_creative_history" ? history : { text: "z".repeat(TOOLBOX_TOOL_OUTPUT_LIMIT + 10) } }).factory({ on: () => {}, registerTool: (tool) => tools.set(tool.name, tool) });
  const listed = JSON.parse((await tools.get("toolbox_history").execute("1", {})).content[0].text);
  assert.deepEqual(listed, [{ id: "h1", kind: "batch", title: "Batch", summary: "3 files", createdAtUtc: "2026-10-19T00:00:00Z", outputPath: "C:\\out\\report.json" }], "parameters and full results stay out of the model context");
  const huge = (await tools.get("toolbox_lyrics_check").execute("2", { lyrics: "你好" })).content[0].text;
  assert.ok(huge.length < TOOLBOX_TOOL_OUTPUT_LIMIT + 200);
  assert.match(huge, /\[Output truncated: showing 50000 of \d+ characters\.\]$/u);
});

test("MCP and plugin callers cannot reach SynthV operations while the integration is off", async () => {
  const { HostCapabilities } = await import("../src/PiDesktop.Tauri/dist/electron/services/host-capabilities.js");
  let enabled = false;
  const calls = [];
  const synthv = { scanInstallations: async () => { calls.push("scan"); return []; } };
  const creative = { invoke: async (operation) => { calls.push(operation); return { ok: true }; } };
  const capabilities = new HostCapabilities(synthv, creative, {}, () => enabled);
  await assert.rejects(capabilities.invoke("host.internal", "synthv", "scan", {}), (error) => error.clientSafe === true && /turned off/.test(error.message));
  await assert.rejects(capabilities.invoke("host.advanced", "synthv", "activate-profile", { slotId: "a" }), /turned off/);
  assert.deepEqual(await capabilities.invoke("host.internal", "creative", "list_creative_history", {}), { ok: true });
  enabled = true;
  assert.deepEqual(await capabilities.invoke("host.internal", "synthv", "scan", {}), []);
  assert.deepEqual(calls, ["list_creative_history", "scan"]);
});

test("SynthV-backed creative operations and Cover are refused through MCP and plugins when their gate is closed", async () => {
  const { HostCapabilities } = await import("../src/PiDesktop.Tauri/dist/electron/services/host-capabilities.js");
  let synthv = false, ai = true;
  const calls = [];
  const creative = { invoke: async (operation, params) => { calls.push(operation); return operation === "media_tasks" ? [{ id: "c1", kind: "cover" }, { id: "s1", kind: "source-separation" }] : { ok: true, params }; } };
  const capabilities = new HostCapabilities({}, creative, {}, () => synthv, () => ai);
  const offlineProjectWork = ["get_project_backup_state", "create_project_checkpoint", "list_project_checkpoints", "restore_project_checkpoint", "run_project_probe", "run_project_doctor", "add_project_reference", "export_project_without_parameters", "export_project_lyrics", "run_batch_workflow"].map((operation) => [operation, { projectPath: "C:\\Songs\\a.svp" }]);
  for (const [operation, params] of [["run_score_to_synthv", {}], ["confirm_lyric_bridge_fit", {}], ["run_retake_workbench", {}], ["run_audio_to_project", { importToSynthv: true }], ["queue_cover", { request: {} }], ["retry_media_task", { id: "c1" }], ...offlineProjectWork, ["run_pronunciation_diagnostics", { projectPath: "C:\\Songs\\a.svp" }]]) {
    await assert.rejects(capabilities.invoke("host.internal", "creative", operation, params), (error) => error.clientSafe === true && /turned off/.test(error.message), operation);
  }
  assert.deepEqual(await capabilities.invoke("host.internal", "creative", "run_audio_to_project", { importToSynthv: false }), { ok: true, params: { importToSynthv: false } }, "MIDI export alone needs no SynthV");
  assert.deepEqual(await capabilities.invoke("host.internal", "creative", "run_pronunciation_diagnostics", { lyrics: "你好" }), { ok: true, params: { lyrics: "你好" } }, "plain lyrics stay checkable, as the agent's toolbox_lyrics_check does");
  assert.ok(!calls.some((operation) => offlineProjectWork.some(([refused]) => refused === operation)), "offline .svp work, hidden in the UI with the integration, is refused for MCP and plugins too");
  const audioBatch = { recipeId: "render-review", inputPaths: ["C:\\Renders\\take.wav"] };
  assert.deepEqual(await capabilities.invoke("host.internal", "creative", "run_batch_workflow", audioBatch), { ok: true, params: audioBatch }, "an audio-only batch needs no SynthV");
  await assert.rejects(capabilities.invoke("host.internal", "creative", "run_batch_workflow", { recipeId: "project-doctor", inputPaths: ["C:\\Songs\\a.svp"] }), /turned off/, "project recipes stay with the integration");
  // creative-service snapshots and keeps backing up any projectPath, so a project slipped into an audio operation is refused too.
  await assert.rejects(capabilities.invoke("host.internal", "creative", "run_batch_workflow", { ...audioBatch, options: { projectPath: "C:\\Songs\\a.svp" } }), /turned off/, "batch options cannot carry a project");
  await assert.rejects(capabilities.invoke("host.internal", "creative", "run_render_review", { audioPath: "C:\\Renders\\take.wav", projectPath: "C:\\Songs\\a.svp" }), /turned off/, "nor can an audio review");
  assert.deepEqual(await capabilities.invoke("host.internal", "creative", "retry_media_task", { id: "s1" }), { ok: true, params: { id: "s1" } }, "retrying a non-Cover job is not a Cover");
  synthv = true; ai = false;
  await assert.rejects(capabilities.invoke("host.internal", "creative", "queue_cover", { request: {} }), (error) => error.clientSafe === true && /AI mode/.test(error.message));
  await assert.rejects(capabilities.invoke("host.internal", "creative", "retry_media_task", { id: "c1" }), /AI mode/);
  await assert.rejects(capabilities.invoke("host.internal", "creative", "retry_media_task", { taskId: "c1" }), /AI mode/, "the cover service accepts taskId too, so the gate resolves it");
  assert.deepEqual(await capabilities.invoke("host.internal", "creative", "run_score_to_synthv", {}), { ok: true, params: {} });
  ai = true;
  assert.deepEqual(await capabilities.invoke("host.internal", "creative", "queue_cover", { request: {} }), { ok: true, params: { request: {} } });
  assert.ok(!calls.some((operation) => ["confirm_lyric_bridge_fit", "run_retake_workbench"].includes(operation)), "refused operations never reach the creative service");
});

test("changing the external MCP server set changes the agent prompt, so the runtime builds a new session", () => {
  const base = agentSystemPrompt({ synthv: false, mcpServers: [] });
  const one = agentSystemPrompt({ synthv: false, mcpServers: [{ id: "a", name: "Files", command: "npx", args: ["server-a"] }] });
  const changed = agentSystemPrompt({ synthv: false, mcpServers: [{ id: "a", name: "Files", command: "npx", args: ["server-b"] }] });
  assert.doesNotMatch(base, /External MCP servers/);
  assert.match(one, /External MCP servers: Files \(configuration [0-9a-f]{8}\)\./);
  assert.notEqual(one, changed, "a changed command must recreate the session even when the name is unchanged");
  const servers = [{ id: "a", name: "Files", command: "npx", args: ["server-a"] }];
  assert.notEqual(agentSystemPrompt({ synthv: false, mcpServers: servers, mcpToolsRevision: 1 }), agentSystemPrompt({ synthv: false, mcpServers: servers, mcpToolsRevision: 2 }), "a server announcing new tools must recreate the session too");
  assert.doesNotMatch(one, /toolbox_|sv_\*|toolbox_cover/, "tool names stay out of the base prompt; Cover repair and tuning sessions have different tools");
});

test("agent tools only accept absolute paths on a local drive", async () => {
  const { TOOLBOX_AGENT_TOOLS, validate } = await import("../src/PiDesktop.Tauri/dist/electron/services/toolbox-agent-tools.js");
  const probe = TOOLBOX_AGENT_TOOLS.find((spec) => spec.name === "toolbox_audio_probe");
  for (const path of ["\\\\attacker\\share\\x.wav", "//attacker/share/x.wav", "\\\\?\\UNC\\attacker\\share\\x.wav", "relative.wav"]) assert.throws(() => validate(probe, { path }), /local drive/, path);
  const local = process.platform === "win32" ? "C:\\Music\\take.wav" : "/home/me/take.wav";
  assert.deepEqual(validate(probe, { path: local }), { path: local });
});

test("a loaded bridge is reported as loaded even when SynthV is off and was never probed", async () => {
  const probe = synthvProbe();
  await withState({ integrations: { synthv: "off" } }, probe, async (state) => {
    const app = await state.bootstrap();
    assert.equal(app.integrations.synthv.bridgeLoaded, true);
    assert.equal(app.bridgeBundled, true);
    assert.deepEqual(probe.calls, []);
  });
});
