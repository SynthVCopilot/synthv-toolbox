import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = fs.readFileSync(new URL("../../../src/PiDesktop.Tauri/src/accountStatus.ts", import.meta.url), "utf8");
const status = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: "transform" })).toString("base64")}`);

const base = { launchEnabled: true, localBlocked: false };
assert.deepEqual(status.evaluateAccountEnvironment({ ...base, sessionStatus: "ready" }), { available: true, busy: false, unavailable: false });
assert.deepEqual(status.evaluateAccountEnvironment({ ...base, sessionStatus: "inUse" }), { available: true, busy: true, unavailable: false });
assert.deepEqual(status.evaluateAccountEnvironment({ ...base, sessionStatus: "ready", localBlocked: true }), { available: false, busy: true, unavailable: true });
assert.deepEqual(status.evaluateAccountEnvironment({ ...base, sessionStatus: "ready", launchEnabled: false }), { available: false, busy: false, unavailable: true });
assert.equal(status.evaluateAccountEnvironment({ ...base, sessionStatus: "missing" }).available, false);
assert.equal(status.evaluateAccountEnvironment({ ...base, sessionStatus: "expired" }).available, false);
assert.deepEqual(status.summarizeAccountEnvironments([
  { ...base, sessionStatus: "expired" },
  { ...base, sessionStatus: "ready" },
]), { available: true, busy: false, allUnavailable: false });

console.log("Account availability states passed.");
