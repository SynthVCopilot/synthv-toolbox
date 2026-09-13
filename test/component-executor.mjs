import assert from "node:assert/strict";
import { createComponentExecutor } from "../src/PiDesktop.Tauri/dist/electron/services/component-executor.js";

const calls = [];
const execute = async (file, args) => { calls.push({ file, args }); return { outputPath: "result.svp" }; };
const run = createComponentExecutor("C:/components", "python", execute);
const result = await run("run_project_probe", { projectPath: "song.svp" });
assert.equal(result.succeeded, true);
assert.deepEqual(calls[0].args.slice(-2), ["probe", "song.svp"]);
await assert.rejects(run("unknown", {}), /No local component implements/);
console.log("Component executor routes supported workflows without a sidecar host.");
