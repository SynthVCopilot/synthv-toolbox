import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const executorUrl = process.env.COMPONENT_EXECUTOR_MODULE ?? new URL("../src/PiDesktop.Tauri/dist/electron/services/component-executor.js", import.meta.url).href;
const { createComponentExecutor } = await import(executorUrl);

const directory = await mkdtemp(path.join(os.tmpdir(), "component-executor-"));
const project = path.join(directory, "song.svp");
const audio = path.join(directory, "audio.wav");
await writeFile(project, "{}");
await writeFile(audio, "fixture");
const calls = [];
const execute = async (file, args, env) => {
  calls.push({ file, args, env });
  if (args.includes("pair-diff")) return { tool: "pi-audio/pair-diff", mono_notes: 3, midi_out: path.join(directory, "song.mid") };
  return { tool: "cvrs/probe", version: 187, era: "SV2", trackCount: 1, tracks: [] };
};
const run = createComponentExecutor("/components", "python", execute, { dataRoot: path.join(directory, "data") });
const result = await run("run_project_probe", { projectPath: project });
assert.deepEqual(result, {
  kind: "project-probe",
  summary: "Project probe completed.",
  data: { tool: "cvrs/probe", version: 187, era: "SV2", trackCount: 1, tracks: [], command: "run_project_probe", sourceTool: "cvrs/probe", evidence: 1 },
});
assert.equal(calls[0].args.at(-1), project);
assert.equal(calls[0].env.SYNTHV_TOOLBOX_DATA_ROOT, path.join(directory, "data"));
const midi = await run("run_audio_to_project", { vocalPath: audio, instrumentalPath: audio, tolerance: 0.08, outputName: "song.mid", importToSynthv: true });
assert.equal(midi.kind, "audio-to-project");
assert.equal(midi.outputPath, path.join(directory, "song.mid"));
assert.match(midi.summary, /Bridge import was not performed/u);
assert.deepEqual(midi.data.bridgeImport, { status: "not-performed", requested: true });
await assert.rejects(run("run_project_probe", { projectPath: "song.svp" }), /absolute path/u);
await assert.rejects(run("unknown", {}), /No local component implements/u);
const pathPython = process.platform === "win32" ? "python.exe" : "python3.11";
if (spawnSync(pathPython, ["--version"], { encoding: "utf8" }).status === 0) {
  const componentsRoot = fileURLToPath(new URL("../src/PiDesktop.Tauri/components/", import.meta.url));
  const pathRun = createComponentExecutor(componentsRoot, pathPython, undefined, { dataRoot: path.join(directory, "path-data") });
  const pathResult = await pathRun("run_project_probe", { projectPath: project });
  assert.equal(pathResult.kind, "project-probe");
  assert.equal(pathResult.data.trackCount, 0);
}
console.log("Component executor maps local component data and rejects relative input paths.");
