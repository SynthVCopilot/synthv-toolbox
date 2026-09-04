import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rustRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src-tauri");
const read = (path) => readFileSync(path, "utf8");
const tasks = read(join(rustRoot, "src", "media_tasks.rs"));
const control = read(join(rustRoot, "src", "synthv_control.rs"));
const workflows = read(join(rustRoot, "src", "bridge_workflows.rs"));
const parser = read(join(rustRoot, "components", "synthv-agent-bridge", "scripts", "cover-score-notes.mjs"));

assert.match(tasks, /standard_call\("synthv_hosts"/);
assert.match(tasks, /standard_call\("synthv_connect"/);
assert.match(tasks, /current_project_file_from_standard_reads/);
assert.match(tasks, /bulk_score_import/);
assert.match(tasks, /"part\.create"/);
assert.match(tasks, /"note\.create"/);
assert.match(tasks, /"voice\.assign"/);
assert.match(tasks, /databaseName/);
assert.match(tasks, /validate_cover_notes/);
assert.match(tasks, /已创建检查点/);
assert.match(tasks, /部分音符可能已经写入/);
assert.match(tasks, /BridgeShortcutAction::Save/);
assert.match(tasks, /BridgeShortcutAction::Refresh/);
assert.match(control, /Self::Refresh => "F5"/);
assert.doesNotMatch(tasks, /fn ensure_bridge/);
assert.doesNotMatch(tasks, /start_bridge_and_connect/);

assert.match(workflows, /pub fn parse_cover_midi/);
assert.match(workflows, /scripts\/cover-score-notes\.mjs/);
assert.match(workflows, /current_project_file_from_standard_reads/);
assert.match(parser, /importScoreSnapshotMonophonic/);
assert.match(parser, /exactly one non-empty track/);
assert.doesNotMatch(parser, /function parseMidi/);

console.log("Unified Cover routing contracts passed.");
