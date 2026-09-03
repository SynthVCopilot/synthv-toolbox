import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rust = join(root, "src", "PiDesktop.Tauri", "src-tauri", "src");
const read = (path) => readFileSync(path, "utf8");
const solo = read(join(rust, "solo_tuning.rs"));
const control = read(join(rust, "synthv_control.rs"));
const commands = read(join(rust, "commands.rs"));
const agent = read(join(rust, "audio_capture.rs"));

assert.match(solo, /AgentWorkMode::Solo/);
assert.match(solo, /create_checkpoint/);
assert.match(solo, /capture_clip/);
assert.match(solo, /feature_distance/);
assert.match(solo, /record_outcome/);
assert.match(solo, /BridgeShortcutAction::Save/);
assert.match(solo, /BridgeShortcutAction::Undo/);
assert.match(solo, /rollback_verified/);
assert.match(control, /Ctrl\+Z/);
assert.match(commands, /pub async fn run_solo_tuning/);
assert.match(agent, /name: "run_solo_tuning"/);

console.log("Solo tuning contracts passed.");
