// The data folder moves from the pre-Toneshuttle name on the first start. --toolbox-app-data-dir stands in for the OS app-data
// folder, and a run with --user-data-dir=<appData>/synthv-toolbox plays the part of the old build.
import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { invoke, isolatedEnv, makeTemporaryDirectory, openPage, quitApp, startApp } from "./_lib/app.mjs";

const anthropicKey = (state) => state.providers.find((provider) => provider.id === "anthropic")?.apiKeys?.find((key) => key.label === "Migrated key");

/** Runs the app on the old folder name, as an installed pre-Toneshuttle build would have, and leaves real data behind. */
async function seedLegacyFolder(legacy, env) {
  const app = await startApp([`--user-data-dir=${legacy}`], env);
  let page;
  try {
    page = await openPage(app);
    await invoke(page, "complete_onboarding", { mode: "toolbox" });
    await invoke(page, "set_integration", { integration: "synthv", preference: "off" });
    await invoke(page, "set_mode", { mode: "ai" });
    await invoke(page, "add_ai_api_key", { provider: "anthropic", label: "Migrated key", apiKey: "test-api-key" });
    return { token: (await invoke(page, "get_http_api_status")).token };
  } finally {
    await quitApp(app, page);
  }
}

test("the data folder moves from its old name on the first start and keeps everything working", async (t) => {
  const cleanups = [];
  const homeDir = await makeTemporaryDirectory("toneshuttle-migrate-home-", cleanups);
  const env = isolatedEnv(homeDir);
  const sandbox = async () => { const appData = await makeTemporaryDirectory("toneshuttle-appdata-", cleanups); return { appData, legacy: join(appData, "synthv-toolbox"), target: join(appData, "Toneshuttle") }; };
  try {
    await t.test("settings, sealed credentials, the MCP token and stored paths survive the move", async () => {
      const { appData, legacy, target } = await sandbox();
      const { token } = await seedLegacyFolder(legacy, env);
      const job = "3f2b8f6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
      mkdirSync(join(legacy, "creative", "cover-jobs"), { recursive: true });
      writeFileSync(join(legacy, "creative", "cover-jobs", `${job}.json`), JSON.stringify({ id: job, kind: "media-import", status: "failed", imported: { audioPath: join(legacy, "creative", "media", job, "source.wav") }, request: {} }));

      const app = await startApp([`--toolbox-app-data-dir=${appData}`], env);
      let page;
      try {
        page = await openPage(app);
        const state = await invoke(page, "bootstrap");
        assert.equal(state.dataDirectory.path, target);
        assert.equal(state.dataDirectory.migratedFrom, legacy);
        assert.equal(state.dataDirectory.deferred, null);
        assert.equal(state.onboardingCompleted, true, "onboarding is not shown again");
        assert.equal(state.integrations.synthv.preference, "off");
        assert.equal(state.mode, "ai");
        assert.equal((await invoke(page, "get_http_api_status")).token, token, "MCP clients keep working without re-pairing");
        assert.equal(anthropicKey(await invoke(page, "ai_provider_state"))?.healthy, true, "the credential key moved with the sealed credentials, so they still decrypt");
      } finally {
        await quitApp(app, page);
      }
      assert.equal(existsSync(legacy), false, "nothing recreates the old folder");
      assert.ok(existsSync(join(target, "Local State")), "Chromium writes its own state to the new folder");
      assert.equal(JSON.parse(readFileSync(join(target, "creative", "cover-jobs", `${job}.json`), "utf8")).imported.audioPath, join(target, "creative", "media", job, "source.wav"), "a retried job finds its earlier step's files");
    });

    await t.test("a file held open in the old folder keeps it in use for this start and the next start completes the move", { skip: process.platform !== "win32" && "only Windows refuses to rename a folder with open files" }, async () => {
      const { appData, legacy, target } = await sandbox();
      await seedLegacyFolder(legacy, env);
      const handle = openSync(join(legacy, "desktop-settings.json"), "r");
      let app, page;
      try {
        app = await startApp([`--toolbox-app-data-dir=${appData}`], env);
        page = await openPage(app);
        const state = await invoke(page, "bootstrap");
        assert.equal(state.dataDirectory.path, legacy);
        assert.equal(state.dataDirectory.deferred?.reason, "in-use");
        assert.equal(state.onboardingCompleted, true, "the old folder's data is used meanwhile");
      } finally {
        await quitApp(app, page);
        closeSync(handle);
      }
      assert.equal(existsSync(target), false);
      const retry = await startApp([`--toolbox-app-data-dir=${appData}`], env);
      let retryPage;
      try {
        retryPage = await openPage(retry);
        assert.equal((await invoke(retryPage, "bootstrap")).dataDirectory.migratedFrom, legacy, "the next start completes the move");
      } finally {
        await quitApp(retry, retryPage);
      }
    });

    await t.test("while an older instance still runs on the old folder, the new start hands over to it and moves nothing", async () => {
      const { appData, legacy, target } = await sandbox();
      await seedLegacyFolder(legacy, env);
      const old = await startApp([`--user-data-dir=${legacy}`], env);
      let oldPage;
      try {
        oldPage = await openPage(old);
        const next = await startApp([`--toolbox-app-data-dir=${appData}`], env);
        const result = await Promise.race([next.exited, new Promise((resolve) => setTimeout(() => resolve(undefined), 30000))]);
        if (!result) next.child.kill();
        const log = next.stdout() + next.stderr();
        assert.ok(result, `the second start must exit on its own; output:\n${log}`);
        assert.match(log, /stays at/u, "the deferral is logged");
        assert.equal(existsSync(target), false);
        assert.ok((await invoke(oldPage, "bootstrap")).configPath.startsWith(legacy), "the running instance keeps serving from the old folder");
        assert.ok(existsSync(join(legacy, "desktop-settings.json")));
      } finally {
        await quitApp(old, oldPage);
      }
    });
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});
