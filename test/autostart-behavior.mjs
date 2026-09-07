import assert from "node:assert/strict";
import fs from "node:fs";

const mainSource = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");
const libSource = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src-tauri/src/lib.rs", import.meta.url), "utf8");

function presentStatus(status) {
  const enabled = status?.enabled;
  return {
    enabled,
    disabled: enabled === undefined || enabled === null,
    error: status?.error ?? null,
  };
}

async function refreshStatus(fetchStatus, state) {
  if (state.pending) return false;
  state.pending = true;
  try {
    const next = presentStatus(await fetchStatus());
    state.value = next.enabled;
    state.error = next.error;
    return true;
  } catch (error) {
    state.value = undefined;
    state.error = String(error);
    return false;
  } finally {
    state.pending = false;
  }
}

const unknown = presentStatus({ enabled: null, error: "registry unavailable" });
assert.equal(unknown.disabled, true);
assert.equal(unknown.error, "registry unavailable");

const state = { pending: false, value: false, error: null };
let calls = 0;
const rejected = () => { calls += 1; return Promise.reject(new Error("query failed")); };
assert.equal(await refreshStatus(rejected, state), false);
assert.equal(state.value, undefined);
assert.equal(state.error, "Error: query failed");
assert.equal(await refreshStatus(rejected, state), false);
assert.equal(calls, 2, "a completed failure may be retried once on a later settings entry");

const enabled = { pending: false, value: undefined, error: "old" };
assert.equal(await refreshStatus(async () => ({ enabled: true, error: null }), enabled), true);
assert.deepEqual(enabled, { pending: false, value: true, error: null });

function startupMode(args) {
  return args.includes("--autostart") ? "hidden" : "interactive";
}
assert.equal(startupMode(["toolbox.exe", "--autostart"]), "hidden");
assert.equal(startupMode(["toolbox.exe"]), "interactive");
assert.equal(startupMode(["toolbox.exe", "song.svp"]), "interactive");

assert.match(mainSource, /api\.getAutostart\(\)/);
assert.match(mainSource, /api\.setAutostart\(enabled\)/);
assert.match(mainSource, /autostartEnabled === undefined/);
assert.match(libSource, /arg == "--autostart"/);
assert.match(libSource, /else if autostart_launch/);
assert.match(libSource, /handle_svp_activation[\s\S]*?arg == "--autostart"/);

console.log("Autostart status, failure handling, and launch-mode behavior passed.");
