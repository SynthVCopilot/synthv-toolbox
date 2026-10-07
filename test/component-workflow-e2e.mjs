import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const executorUrl = process.env.COMPONENT_EXECUTOR_MODULE ?? new URL("../src/PiDesktop.Tauri/dist/electron/services/component-executor.js", import.meta.url).href;
const { createComponentExecutor } = await import(executorUrl);

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "component-workflow-e2e-")));
const dataRoot = path.resolve(root, "app-data", "components");
const source = path.join(root, "source.svp");
const audio = path.join(root, "reference.wav");
const fixture = {
  version: 187,
  time: { tempo: [{ position: 0, bpm: 120 }] },
  tracks: [{
    name: "Lead",
    mainGroup: { uuid: "lead-group", notes: [{ onset: 0, duration: 705600000, lyrics: "你" }, { onset: 705600000, duration: 705600000, lyrics: "好" }], parameters: { pitchDelta: { mode: "linear", points: [[0, 10]] } }, pitchControls: [] },
    mainRef: { groupID: "lead-group", blickOffset: 0 },
    groups: [],
    mixer: { mute: false },
  }],
};
const originalBytes = Buffer.from(JSON.stringify(fixture, null, 2));
await writeFile(source, originalBytes);
const samples = Buffer.alloc(22050 * 2);
for (let index = 0; index < 22050; index += 1) samples.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / 22050) * 12000), index * 2);
const wav = Buffer.alloc(44 + samples.length);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + samples.length, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(samples.length, 40); samples.copy(wav, 44);
await writeFile(audio, wav);
const originalInferenceDevice = process.env.SYNTHV_TOOLBOX_INFERENCE_DEVICE;
process.env.SYNTHV_TOOLBOX_INFERENCE_DEVICE = "cpu";
const run = createComponentExecutor(
  fileURLToPath(new URL("../src/PiDesktop.Tauri/components/", import.meta.url)),
  process.env.SYNTHV_TOOLBOX_PYTHON ?? "python3.11",
  undefined,
  { dataRoot },
);
if (originalInferenceDevice === undefined) delete process.env.SYNTHV_TOOLBOX_INFERENCE_DEVICE;
else process.env.SYNTHV_TOOLBOX_INFERENCE_DEVICE = originalInferenceDevice;

const probe = await run("run_project_probe", { projectPath: source });
assert.equal(probe.kind, "project-probe");
assert.equal(probe.data.version, 187);
assert.equal(probe.data.trackCount, 1);
const doctor = await run("run_project_doctor", { projectPath: source });
assert.equal(doctor.kind, "project-doctor");
assert.equal(doctor.data.ok, true);
const invalidProject = path.join(root, "invalid-project.svp");
await writeFile(invalidProject, JSON.stringify({ version: 187, tracks: [{ name: "Broken", mainGroup: { notes: [{ onset: -1, duration: 0, lyrics: "" }] } }] }));
const invalidDoctor = await run("run_project_doctor", { projectPath: invalidProject });
assert.equal(invalidDoctor.data.ok, false);
assert.deepEqual(invalidDoctor.data.issues.map(issue => issue.code), ["NOTE_TIMING_INVALID", "LYRIC_EMPTY"]);
const pronunciation = await run("run_pronunciation_diagnostics", { projectPath: source });
assert.equal(pronunciation.kind, "pronunciation-check");
assert.equal(pronunciation.data.inspectedItems, 2);

const copy = await run("export_project_without_parameters", { projectPath: source, outputName: "clean.svp" });
assert.equal(copy.kind, "export-project-without-parameters");
assert.equal(copy.outputPath, path.join(dataRoot, "output", "clean.svp"));
assert.equal(JSON.parse(await readFile(copy.outputPath, "utf8")).tracks[0].mainGroup.parameters.pitchDelta.points.length, 0);

const lyrics = await run("export_project_lyrics", {
  projectPath: source,
  trackIndex: 1,
  lineGapSeconds: 0.8,
  outputName: "song.lrc",
  wordOutputName: "song.word.lrc",
});
assert.equal(lyrics.kind, "export-project-lyrics");
assert.equal(lyrics.data.lineCount, 1);
assert.equal(await readFile(lyrics.outputPath, "utf8"), "[00:00.00]你好\n");
assert.equal(await readFile(lyrics.data.wordLrcOut, "utf8"), "[00:00.00]<00:00.00>你<00:00.50>好\n");

const reference = await run("add_project_reference", {
  projectPath: source,
  audioPath: audio,
  trackName: "Reference",
  beginSeconds: 0,
  outputName: "with-reference.svp",
});
assert.equal(reference.kind, "add-project-reference");
assert.equal(JSON.parse(await readFile(reference.outputPath, "utf8")).tracks.length, 2);
assert.deepEqual(await readFile(source), originalBytes);
await assert.rejects(run("export_project_without_parameters", { projectPath: source, outputName: "clean.svp" }), /already exists|已存在/u);

const attemptAudio = async (command, args, dependencies) => {
  try { return await run(command, args); }
  catch (error) {
    const missing = dependencies.find(dependency => String(error).includes(`No module named '${dependency}'`));
    if (missing) {
      console.log(`Audio workflow ${command} not executed: local Python dependency '${missing}' is missing.`);
      return null;
    }
    throw error;
  }
};
const audioDependencies = ["numpy", "librosa", "basic_pitch", "onnxruntime", "pretty_midi", "mido", "scipy"];
const probeAudio = await attemptAudio("run_audio_probe", { audioPath: audio, advanced: false }, audioDependencies);
if (probeAudio) assert.equal(probeAudio.kind, "audio-probe");
const midiArgs = { vocalPath: audio, instrumentalPath: audio, tolerance: 0.08, advanced: false, outputName: "pair.mid" };
const gameMidi = await attemptAudio("run_game_to_midi", midiArgs, audioDependencies);
if (gameMidi) {
  assert.equal(gameMidi.kind, "game-to-midi");
  assert.equal(gameMidi.data.inference.deviceMode, "cpu");
  assert.equal(gameMidi.data.inference.hardwareEnabled, false);
  assert.deepEqual(gameMidi.data.inference.actualProviders, ["CPUExecutionProvider"]);
}
const projectMidi = await attemptAudio("run_audio_to_project", { ...midiArgs, outputName: "project.mid", outputDirectory: path.join(root, "midi-output"), importToSynthv: false }, audioDependencies);
if (projectMidi) {
  assert.equal(projectMidi.kind, "audio-to-project");
  assert.equal(projectMidi.data.inference.deviceMode, "cpu");
  assert.equal(projectMidi.data.inference.hardwareEnabled, false);
  assert.deepEqual(projectMidi.data.inference.actualProviders, ["CPUExecutionProvider"]);
  assert.deepEqual(projectMidi.data.bridgeImport, { status: "not-performed", requested: false });
}
const renderReview = await attemptAudio("run_render_review", { audioPath: audio, expectedDurationSec: 1, expectedBpm: 120, requireNotes: false }, audioDependencies);
if (renderReview) assert.equal(renderReview.kind, "render-quality-check");
console.log("Real CVRS workflows probe, export a clean copy and LRC files, add a reference track, and preserve the source bytes.");
