import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/PiDesktop.Tauri/src-tauri/src/agent_files.rs", import.meta.url), "utf8");
assert.match(source, /"svp", "svprj", "mid", "midi", "wav"/);
assert.match(source, /"pass"/);
assert.match(source, /"human-approval-required"/);
assert.match(source, /USERPROFILE/);
assert.match(source, /\\\\\?\\/);
assert.match(source, /to_ascii_lowercase\(\)\.replace\('_', ""\)/);
assert.match(source, /session_id != session_id/);
assert.doesNotMatch(source, /ends_with\("file"\)/);
assert.match(source, /purpose 必须为 1–240/);
console.log("agent file approval contract passed");
