import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BRAND, STABLE_IDENTIFIERS } from "../src/PiDesktop.Tauri/dist/electron/brand.js";
import { agentSystemPrompt } from "../src/PiDesktop.Tauri/dist/electron/services/agent-identity.js";
import { executableOf, migrateAutostart, parseRunKey, staleAutostartEntries } from "../src/PiDesktop.Tauri/dist/electron/services/autostart-migration.js";
import { DesktopStateService } from "../src/PiDesktop.Tauri/dist/electron/services/desktop-state.js";
import { isIntegrationPreference, resolveSynthVIntegration } from "../src/PiDesktop.Tauri/dist/electron/services/integrations.js";
import { unavailableBridge } from "../src/PiDesktop.Tauri/dist/electron/services/synthv-bridge.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const noEvidence = { installations: 0, profiles: 0, bridgeConnected: false, bridgeLoaded: true };

test("explicit integration preferences always win over machine evidence", () => {
  assert.equal(resolveSynthVIntegration("on", noEvidence), true);
  assert.equal(resolveSynthVIntegration("off", { installations: 2, profiles: 1, bridgeConnected: true, bridgeLoaded: true }), false);
  assert.equal(isIntegrationPreference("auto"), true);
  assert.equal(isIntegrationPreference("enabled"), false);
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
  const bridge = unavailableBridge("missing dist/src/embedded.js");
  assert.deepEqual(bridge.tools, []);
  assert.equal((await bridge.status()).connected, false);
  await withState(undefined, synthvProbe({ bridgeStatus: () => bridge.status() }), async (state) => {
    const app = await state.bootstrap();
    assert.equal(app.bridgeBundled, false);
    assert.equal(app.integrations.synthv.bridgeLoaded, false);
    assert.ok(app.integrations.synthv.errors.includes("missing dist/src/embedded.js"));
  }, "missing dist/src/embedded.js");
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

test("stale launch-at-login entries from a renamed executable are replaced", async () => {
  const output = [
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "    OneDrive    REG_SZ    \"C:\\Program Files\\OneDrive\\OneDrive.exe\" /background",
    "    electron.app.synthv-toolbox    REG_SZ    \"C:\\Users\\me\\AppData\\Local\\Programs\\synthv-toolbox\\Synthesizer V Toolbox.exe\" --toolbox-autostart",
    "",
  ].join("\r\n");
  const entries = parseRunKey(output);
  assert.equal(entries.length, 2);
  assert.equal(executableOf(entries[1].command), "C:\\Users\\me\\AppData\\Local\\Programs\\synthv-toolbox\\Synthesizer V Toolbox.exe");
  const current = "C:\\Users\\me\\AppData\\Local\\Programs\\synthv-toolbox\\Toneshuttle.exe";
  assert.deepEqual(staleAutostartEntries(entries, current, () => false).map(entry => entry.name), ["electron.app.synthv-toolbox"]);
  assert.deepEqual(staleAutostartEntries(entries, current, () => true), [], "an entry whose executable still exists belongs to another install");
  const actions = [];
  const migrated = await migrateAutostart({ execPath: current, queryRunKey: async () => output, removeRunValue: async name => { actions.push(`remove:${name}`); }, enableAutostart: async () => { actions.push("enable"); }, fileExists: () => false });
  assert.deepEqual(migrated, ["electron.app.synthv-toolbox"]);
  assert.deepEqual(actions, ["remove:electron.app.synthv-toolbox", "enable"], "removal must precede re-registration because the value name may be reused");
  assert.deepEqual(await migrateAutostart({ execPath: current, queryRunKey: async () => "", removeRunValue: async () => { throw new Error("unexpected"); }, enableAutostart: async () => { throw new Error("unexpected"); }, fileExists: () => false }), []);
});

test("product identity is consistent and the stable identifiers keep their legacy values", async () => {
  const renderer = await readFile(join(root, "src/PiDesktop.Tauri/src/brand.ts"), "utf8");
  for (const value of [BRAND.productName, BRAND.productNameZh, BRAND.slug, BRAND.repositoryUrl]) assert.ok(renderer.includes(`"${value}"`), `src/brand.ts must mirror ${value}`);
  const builder = await readFile(join(root, "electron-builder.yml"), "utf8");
  assert.match(builder, new RegExp(`^productName: ${BRAND.productName}$`, "m"));
  assert.match(builder, new RegExp(`^appId: ${STABLE_IDENTIFIERS.appId.replaceAll(".", "\\.")}$`, "m"));
  assert.match(builder, new RegExp(`guid: ${STABLE_IDENTIFIERS.nsisGuid}`));
  assert.equal(STABLE_IDENTIFIERS.userDataDirectory, "synthv-toolbox");
  const main = await readFile(join(root, "src/PiDesktop.Tauri/electron/main.ts"), "utf8");
  assert.ok(main.indexOf("app.setPath(\"userData\"") < main.indexOf("requestSingleInstanceLock"), "userData must be pinned before the single-instance lock reads it");
  assert.match(main, /hasSwitch\("user-data-dir"\)/, "an explicit --user-data-dir must still win over the pinned folder");
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
  for (const [operation, params] of [["run_score_to_synthv", {}], ["confirm_lyric_bridge_fit", {}], ["run_retake_workbench", {}], ["run_audio_to_project", { importToSynthv: true }], ["queue_cover", { request: {} }], ["retry_media_task", { id: "c1" }]]) {
    await assert.rejects(capabilities.invoke("host.internal", "creative", operation, params), (error) => error.clientSafe === true && /turned off/.test(error.message), operation);
  }
  assert.deepEqual(await capabilities.invoke("host.internal", "creative", "run_audio_to_project", { importToSynthv: false }), { ok: true, params: { importToSynthv: false } }, "MIDI export alone needs no SynthV");
  assert.deepEqual(await capabilities.invoke("host.internal", "creative", "retry_media_task", { id: "s1" }), { ok: true, params: { id: "s1" } }, "retrying a non-Cover job is not a Cover");
  synthv = true; ai = false;
  await assert.rejects(capabilities.invoke("host.internal", "creative", "queue_cover", { request: {} }), (error) => error.clientSafe === true && /AI mode/.test(error.message));
  await assert.rejects(capabilities.invoke("host.internal", "creative", "retry_media_task", { id: "c1" }), /AI mode/);
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
  assert.doesNotMatch(one, /toolbox_|sv_\*|toolbox_cover/, "tool names stay out of the base prompt; Cover repair and tuning sessions have different tools");
});

test("agent tools only accept absolute paths on a local drive", async () => {
  const { TOOLBOX_AGENT_TOOLS, validate } = await import("../src/PiDesktop.Tauri/dist/electron/services/toolbox-agent-tools.js");
  const probe = TOOLBOX_AGENT_TOOLS.find((spec) => spec.name === "toolbox_audio_probe");
  for (const path of ["\\\\attacker\\share\\x.wav", "//attacker/share/x.wav", "\\\\?\\UNC\\attacker\\share\\x.wav", "relative.wav"]) assert.throws(() => validate(probe, { path }), /local drive/, path);
  const local = process.platform === "win32" ? "C:\\Music\\take.wav" : "/home/me/take.wav";
  assert.deepEqual(validate(probe, { path: local }), { path: local });
});

test("an autostart entry whose path did not survive decoding is never treated as stale", () => {
  const entries = [{ name: "electron.app.synthv-toolbox", command: "\"C:\\Users\\\uFFFD\uFFFD\\AppData\\Local\\Programs\\synthv-toolbox\\Synthesizer V Toolbox.exe\" --toolbox-autostart" }];
  assert.deepEqual(staleAutostartEntries(entries, "C:\Other\Toneshuttle.exe", () => false), []);
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
