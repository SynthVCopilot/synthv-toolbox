import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compiled } from "../_lib/load.mjs";
import { assertAsyncProperty, fc, runsCapped } from "../_lib/props.mjs";

const { DesktopStateService, savedIntegrationPreference } = await compiled("services/desktop-state.js");
const { INTEGRATION_IDS, INTEGRATION_PREFERENCES } = await compiled("services/integrations.js");
const { AGENT_EFFORT_LEVELS } = await import(new URL("../../../packages/runtime-protocol/dist/index.js", import.meta.url).href);

const probe = {
  scanInstallations: async () => [],
  profileState: async () => ({ supported: true, slots: [], concurrentProvider: { available: false, detail: "none" } }),
  bridgeStatus: async () => ({ connected: false }),
  getAutostart: async () => ({ enabled: false, error: null }),
};
const runtime = { settingsSnapshot: () => ({ pluginInternalFunctionsEnabled: false, pluginAdvancedFunctionsEnabled: false }) };
const ai = { ai_provider_state: async () => ({ providers: [] }), agent_budgets: async () => ({}) };

const newState = directory => new DesktopStateService(directory, "0.0.0", runtime, ai, probe);

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "toneshuttle-settings-"));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

// bootstrap() probes ffmpeg and is far too slow to run per generated case, so the view is built from accessors and the saved file.
const saved = directory => readFile(join(directory, "desktop-settings.json"), "utf8").then(JSON.parse);
const accessorView = state => ({ preference: state.synthvPreference(), effort: state.agentEffort(), workMode: state.agentWorkMode(), transcripts: state.agentTranscriptsEnabled(), ai: state.aiModeEnabled() });

// Real files are whatever JSON a hand edit, an older build or a partial write left behind.
const fileContents = fc.oneof(
  fc.jsonValue(),
  fc.record({ integrations: fc.jsonValue(), agentEffort: fc.jsonValue(), mode: fc.jsonValue(), mcpServers: fc.jsonValue() }, { requiredKeys: [] }),
  fc.record({ integrations: fc.record({ synthv: fc.oneof(fc.constantFrom(...INTEGRATION_PREFERENCES), fc.jsonValue()) }), agentEffort: fc.oneof(fc.constantFrom(...AGENT_EFFORT_LEVELS), fc.jsonValue()) }, { requiredKeys: [] }),
);

test("any settings file loads into valid integration and effort settings", async () => {
  await assertAsyncProperty(fileContents, contents => withDirectory(async directory => {
    await writeFile(join(directory, "desktop-settings.json"), JSON.stringify(contents), "utf8");
    const state = newState(directory);
    await state.load();
    assert.ok(INTEGRATION_PREFERENCES.includes(state.synthvPreference()));
    assert.ok(AGENT_EFFORT_LEVELS.includes(state.agentEffort()));
    assert.equal(typeof state.aiModeEnabled(), "boolean");
    assert.equal(typeof state.synthvEnabled(), "boolean");
    assert.ok(Array.isArray(state.enabledMcpServers()), "enabledMcpServers() feeds the external MCP pool at startup");
    // main.ts reads the preference before the services exist, so the early read and the loaded state must agree.
    assert.equal(await savedIntegrationPreference(directory, INTEGRATION_IDS[0]), state.synthvPreference());
  }), { numRuns: runsCapped(25) });
});

test("normalization is idempotent: saving a loaded state and loading again changes nothing", async () => {
  await assertAsyncProperty(fileContents, contents => withDirectory(async directory => {
    await writeFile(join(directory, "desktop-settings.json"), JSON.stringify(contents), "utf8");
    const first = newState(directory);
    await first.load();
    await first.update({});
    const afterFirst = await saved(directory);
    const second = newState(directory);
    await second.load();
    await second.update({});
    assert.deepEqual(accessorView(second), accessorView(first));
    assert.deepEqual(await saved(directory), afterFirst);
  }), { numRuns: runsCapped(25) });
});

test("saved settings round-trip through a fresh load", async () => {
  const settings = fc.record({
    mode: fc.constantFrom("toolbox", "ai"),
    agentWorkMode: fc.constantFrom("edit", "solo"),
    agentEffort: fc.constantFrom(...AGENT_EFFORT_LEVELS),
    agentTranscriptsEnabled: fc.boolean(),
    updateChannel: fc.constantFrom("stable", "nightly"),
    onboardingCompleted: fc.boolean(),
  }, { requiredKeys: [] });
  await assertAsyncProperty(fc.tuple(settings, fc.constantFrom(...INTEGRATION_PREFERENCES)), ([values, preference]) => withDirectory(async directory => {
    const state = newState(directory);
    await state.load();
    await state.update(values);
    await state.setIntegration("synthv", preference);
    const reloaded = newState(directory);
    await reloaded.load();
    assert.deepEqual(accessorView(reloaded), accessorView(state));
    assert.equal(reloaded.synthvPreference(), preference);
    const file = await saved(directory);
    for (const [key, value] of Object.entries(values)) assert.equal(file[key], value, key);
    assert.deepEqual(file.integrations, { synthv: preference });
  }), { numRuns: runsCapped(25) });
});

test("a missing or unreadable settings file yields the defaults", async () => {
  await withDirectory(async directory => {
    const state = newState(directory);
    await state.load();
    assert.equal(state.synthvPreference(), "auto");
    assert.equal(state.aiModeEnabled(), false);
    await writeFile(join(directory, "desktop-settings.json"), "{ not json", "utf8");
    const corrupt = newState(directory);
    await corrupt.load();
    assert.equal(corrupt.synthvPreference(), "auto");
  });
});
