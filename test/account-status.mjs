import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/accountStatus.ts", import.meta.url), "utf8");
const status = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: "transform" })).toString("base64")}`);

const verified = { launchEnabled: true, localBlocked: false, authorizationStatus: "verified" };
assert.deepEqual(status.evaluateAccountEnvironment({ ...verified, sessionStatus: "ready", remoteUse: "unknown" }), { available: true, busy: false, unavailable: false });
assert.deepEqual(status.evaluateAccountEnvironment({ ...verified, sessionStatus: "inUse", remoteUse: "unknown" }), { available: true, busy: true, unavailable: false });
assert.equal(status.evaluateAccountEnvironment({ ...verified, sessionStatus: "ready", remoteUse: "detected" }).available, false);
assert.equal(status.evaluateAccountEnvironment({ ...verified, sessionStatus: "expired", remoteUse: "unknown" }).available, false);
assert.equal(status.evaluateAccountEnvironment({ ...verified, authorizationStatus: "unknown", sessionStatus: "ready", remoteUse: "unknown" }).available, false);
assert.deepEqual(status.summarizeAccountEnvironments([
  { ...verified, sessionStatus: "expired", remoteUse: "unknown" },
  { ...verified, sessionStatus: "ready", remoteUse: "unknown" },
]), { available: true, busy: false, allUnavailable: false });

console.log("Account availability states passed.");
