import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rustRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src-tauri", "src");
const webRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src");
const read = (path) => readFileSync(path, "utf8");
const config = read(join(rustRoot, "config.rs"));
const commands = read(join(rustRoot, "commands.rs"));
const agent = read(join(rustRoot, "audio_capture.rs"));
const tasks = read(join(rustRoot, "media_tasks.rs"));
const types = read(join(webRoot, "types.ts"));
const main = read(join(webRoot, "main.ts"));

assert.match(config, /pub enum AgentWorkMode/);
assert.match(config, /Edit/);
assert.match(config, /Solo/);
assert.match(commands, /pub async fn set_agent_work_mode/);
assert.match(commands, /apply_agent_work_mode/);
assert.match(agent, /Edit 模式每轮只允许一次/);
assert.match(agent, /Solo 模式修改 SynthV 前必须先调用 create_project_checkpoint/);
assert.match(agent, /Solo 模式每轮最多执行八次/);
assert.match(agent, /name: "create_project_checkpoint"/);
assert.match(tasks, /creative_history::create_checkpoint/);
assert.match(types, /export type AgentWorkMode = "edit" \| "solo"/);
assert.match(main, /data-agent-work-mode="edit"/);
assert.match(main, /data-agent-work-mode="solo"/);

console.log("Agent work mode contracts passed.");
