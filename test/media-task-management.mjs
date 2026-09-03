import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rustRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src-tauri", "src");
const webRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src");
const read = (path) => readFileSync(path, "utf8");
const tasks = read(join(rustRoot, "media_tasks.rs"));
const process = read(join(rustRoot, "managed_process.rs"));
const media = read(join(rustRoot, "media_import.rs"));
const workflows = read(join(rustRoot, "workflows.rs"));
const commands = read(join(rustRoot, "commands.rs"));
const agent = read(join(rustRoot, "audio_capture.rs"));
const main = read(join(webRoot, "main.ts"));

assert.match(tasks, /media-tasks\.json/);
assert.match(tasks, /MediaTaskStatus::Cancelling/);
assert.match(tasks, /pub fn enqueue_import/);
assert.match(tasks, /pub fn enqueue_separation/);
assert.match(tasks, /pub fn cancel/);
assert.match(tasks, /pub fn retry/);
assert.match(process, /attach_child/);
assert.match(process, /process_tree\.terminate/);
assert.match(process, /STDOUT_LIMIT/);
assert.match(media, /run_managed_process/);
assert.match(workflows, /run_managed_command/);
assert.match(commands, /queue_media_import/);
assert.match(commands, /queue_media_separation/);
assert.match(commands, /cancel_media_task/);
assert.match(agent, /name: "list_media_tasks"/);
assert.match(agent, /name: "cancel_media_task"/);
assert.match(main, /data-cancel-media-task/);
assert.match(main, /data-retry-media-task/);

console.log("Media task management contracts passed.");
