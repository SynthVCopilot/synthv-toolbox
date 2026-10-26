// Boots the built app, checks the preload bridge, runtime and persisted settings through IPC, then quits it normally.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { evaluate, invoke, isolatedEnv, makeTemporaryDirectory, openPage, quitApp, startApp, waitFor } from "./_lib/app.mjs";

test("the built app boots, serves IPC, persists settings and quits cleanly", async (t) => {
  const cleanups = [];
  const profileDir = await makeTemporaryDirectory("toneshuttle-boot-profile-", cleanups);
  const homeDir = await makeTemporaryDirectory("toneshuttle-boot-home-", cleanups);
  const tmpDir = await makeTemporaryDirectory("toneshuttle-boot-tmp-", cleanups);
  const bridgeDir = await makeTemporaryDirectory("toneshuttle-boot-bridge-", cleanups);
  const app = await startApp([`--user-data-dir=${profileDir}`], isolatedEnv(homeDir, { TMPDIR: tmpDir, SYNTHV_AGENT_BRIDGE_DIR: bridgeDir }));
  let page;
  let exit;
  try {
    page = await openPage(app);

    await t.test("the preload exposes only the desktop bridge and no Node globals", async () => {
      assert.deepEqual(await evaluate(page, "Object.keys(window.toolboxDesktop).sort()"), ["invoke", "listen", "onFileDrop", "openDialog"]);
      assert.deepEqual(await evaluate(page, "[typeof window.require, typeof window.process]"), ["undefined", "undefined"]);
    });

    await t.test("the agent runtime is running and the updater is idle", async () => {
      assert.equal((await invoke(page, "get_agent_runtime_status")).running, true);
      assert.equal((await invoke(page, "updater.state")).phase, "idle");
    });

    await t.test("onboarding completes through IPC", async () => {
      const state = await invoke(page, "complete_onboarding", { mode: "toolbox" });
      assert.equal(state.onboardingCompleted, true);
      assert.equal(state.mode, "toolbox");
    });

    await t.test("effort budgets are reported and the chosen effort persists", async () => {
      const budgets = await invoke(page, "agent_budgets");
      assert.deepEqual(Object.keys(budgets).sort(), ["high", "low", "max", "mid"]);
      for (const level of ["low", "mid", "high"]) {
        assert.equal(typeof budgets[level].maxTurns, "number", `${level} maxTurns`);
        assert.equal(typeof budgets[level].maxTokens, "number", `${level} maxTokens`);
      }
      assert.equal(budgets.max.maxTurns, null);
      assert.equal(budgets.max.maxTokens, null);
      assert.equal((await invoke(page, "set_agent_effort", { effort: "high" })).agentEffort, "high");
      const settings = await waitFor(async () => JSON.parse(await readFile(join(profileDir, "desktop-settings.json"), "utf8")), { label: "desktop-settings.json" });
      assert.equal(settings.agentEffort, "high");
    });

    await t.test("the agent transcripts setting toggles", async () => {
      assert.equal((await invoke(page, "set_agent_transcripts", { enabled: true })).agentTranscriptsEnabled, true);
      assert.equal((await invoke(page, "set_agent_transcripts", { enabled: false })).agentTranscriptsEnabled, false);
    });
  } finally {
    exit = await quitApp(app, page);
    for (const cleanup of cleanups) await cleanup();
  }

  await t.test("the app quits with code 0 and the main process logs no error lines", () => {
    assert.ok(exit, "the app must exit rather than be force-killed");
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    // macOS Chromium helper processes write their own NSLog lines (e.g. XPC errors) to this stream; they are not main-process logs.
    const helperLog = /^\d{4}-\d{2}-\d{2} [\d:.]+ Electron Helper( \([A-Za-z]+\))?\[\d+:\d+\]/;
    assert.deepEqual(app.stderr().split("\n").filter((line) => /error/i.test(line) && !helperLog.test(line)), []);
  });
});
