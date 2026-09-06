import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mainPath = join(repositoryRoot, "src", "PiDesktop.Tauri", "src", "main.ts");
const source = readFileSync(mainPath, "utf8");

function block(name, kind = "function") {
  const start = source.indexOf(`${kind} ${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) { if (char === "\\") index += 1; else if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function statement(name) {
  const start = source.indexOf(`let ${name}`);
  assert.notEqual(start, -1, `missing state ${name}`);
  return source.slice(start, source.indexOf(";", start) + 1);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createHistoryHarness(api) {
  const timers = [];
  const calls = { render: 0 };
  const extracted = [
    statement("projectBackupState"), statement("historyRefreshTimer"), statement("historyRefreshGeneration"),
    statement("historyLoadState"), statement("historyLoadError"), statement("creativeHistory"), statement("projectCheckpoints"),
    block("stopHistoryRefresh"), block("scheduleHistoryRefresh"),
  ].join("\n");
  const harnessSource = `// @ts-nocheck
    module.exports = (function (__api, __window) {
      const api = __api; const window = __window; let page = "history"; let error = "";
      const calls = __calls; const render = () => { calls.render += 1; };
      const formatError = (value) => value?.message ?? String(value);
      ${extracted}
      return {
        scheduleHistoryRefresh, stopHistoryRefresh,
        setPage: (value) => { page = value; },
        state: () => ({ projectBackupState, historyRefreshTimer, historyRefreshGeneration, historyLoadState, historyLoadError }),
      };
    })(__api, __window);`;
  const output = stripTypeScriptTypes(harnessSource, { mode: "transform", sourceUrl: "history-behavior-harness.ts" });
  const window = {
    setTimeout(callback) { timers.push(callback); return timers.length - 1; },
    clearTimeout(timer) { timers[timer] = undefined; },
  };
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, __api: api, __window: window, __calls: calls, console });
  return {
    ...module.exports,
    pendingTimers: () => timers.filter(Boolean).length,
    renderCount: () => calls.render,
  };
}

{
  const backup = deferred(); const workflow = deferred(); const checkpoints = deferred();
  const harness = createHistoryHarness({ projectBackupState: () => backup.promise, listCreativeHistory: () => workflow.promise, listProjectCheckpoints: () => checkpoints.promise });
  harness.scheduleHistoryRefresh();
  harness.setPage("import");
  harness.stopHistoryRefresh();
  backup.resolve({ intervalSeconds: 60, projects: [], lastError: null }); workflow.resolve([]); checkpoints.resolve([]);
  await settle();
  assert.equal(harness.state().historyLoadState, "loading", "a late response after leaving must not change page state");
  assert.equal(harness.pendingTimers(), 0, "leaving history must cancel future refresh scheduling");
}

{
  let response = { projectBackupState: Promise.resolve({ intervalSeconds: 60, projects: [], lastError: null }), listCreativeHistory: Promise.reject(new Error("temporary")), listProjectCheckpoints: Promise.resolve([]) };
  const harness = createHistoryHarness({ projectBackupState: () => response.projectBackupState, listCreativeHistory: () => response.listCreativeHistory, listProjectCheckpoints: () => response.listProjectCheckpoints });
  harness.scheduleHistoryRefresh(); await settle();
  assert.equal(harness.state().historyLoadState, "error");
  assert.equal(harness.state().historyLoadError, "temporary");
  response = { projectBackupState: Promise.resolve({ intervalSeconds: 60, projects: [], lastError: null }), listCreativeHistory: Promise.resolve([]), listProjectCheckpoints: Promise.resolve([]) };
  harness.scheduleHistoryRefresh(); await settle();
  assert.equal(harness.state().historyLoadState, "ready");
  assert.equal(harness.state().historyLoadError, "", "success must clear the previous error");
  assert.equal(harness.pendingTimers(), 1, "successful refresh should schedule the next refresh");
  harness.stopHistoryRefresh();
  assert.equal(harness.pendingTimers(), 0, "stop must cancel the next refresh");
}

assert.ok(source.includes('class="tool-tabs"') && source.includes('aria-current="page"'));
assert.ok(!source.includes("workflow-tool-tabs") && !source.includes("data-close-workflow"));
assert.equal((source.match(/refreshAudioPreparationIfSelected\(\);/g) ?? []).length, 2, "default and direct tool entry share audio initialization");
assert.match(source, /historyLoadState === "ready" && !backup\?\.lastError && !itemError/);

console.log("Automatic history and direct tool workspace behavior tests passed.");
