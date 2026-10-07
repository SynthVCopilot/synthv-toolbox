import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { projectDoctor, pronunciationDiagnostics } from "./component-diagnostics.js";

type Data = Record<string, unknown>;
type ExecutionOptions = { dataRoot?: string };
type ComponentExecution = (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<Data>;

export function createComponentExecutor(
  componentsRoot: string,
  python = process.env.SYNTHV_TOOLBOX_PYTHON ?? (process.platform === "win32" ? "python.exe" : process.platform === "darwin" ? "python3.11" : "python3"),
  execute: ComponentExecution = runJson,
  options: ExecutionOptions = {},
) {
  const piAudio = resolve(componentsRoot, "pi-audio", "pi_audio.py");
  const cvrs = resolve(componentsRoot, "cvrs", "cvrs.py");
  const separation = resolve(componentsRoot, "vocal-separation", "separate.py");
  const dataRoot = resolve(options.dataRoot ?? process.env.SYNTHV_TOOLBOX_DATA_ROOT ?? resolve(componentsRoot, ".data"));
  const env = { ...process.env, SYNTHV_TOOLBOX_DATA_ROOT: dataRoot };

  return async (command: string, args: Data): Promise<Data> => {
    if (command === "run_audio_probe") {
      const result = await execute(python, [piAudio, "probe", await input(args.audioPath, "audioPath"), ...(args.advanced === true ? ["--notes"] : [])], env);
      return workflow(command, "audio-probe", result, "duration_sec", "Audio probe completed.");
    }
    if (command === "run_game_to_midi" || command === "run_audio_to_project") {
      const vocal = await input(args.vocalPath, "vocalPath");
      const instrumental = args.instrumentalPath ? await input(args.instrumentalPath, "instrumentalPath") : undefined;
      const outputName = outputNameFor(args.outputName, "outputName", args.outputDirectory, "audio-to-project.mid");
      const result = await execute(python, [piAudio, "pair-diff", vocal, ...(instrumental ? [instrumental] : []), "--midi", outputName, "--tol", String(number(args.tolerance, "tolerance")), ...(args.advanced === true ? ["--advanced"] : []), ...(args.outputDirectory ? ["--output-external"] : [])], env);
      const kind = command === "run_game_to_midi" ? "game-to-midi" : "audio-to-project";
      const wrapped = workflow(command, kind, result, "mono_notes", "MIDI extraction completed.", "midi_out");
      if (command === "run_audio_to_project") {
        wrapped.summary = args.importToSynthv === true
          ? "MIDI generated. SynthV Bridge import was not performed by the local component executor."
          : "MIDI generated; SynthV Bridge import was not requested.";
        (wrapped.data as Data).bridgeImport = { status: "not-performed", requested: args.importToSynthv === true };
      }
      return wrapped;
    }
    if (command === "run_project_probe") {
      const projectPath = await input(args.projectPath, "projectPath");
      const result = await execute(python, [cvrs, "probe", projectPath], env);
      return workflow(command, "project-probe", result, "trackCount", "Project probe completed.");
    }
    if (command === "run_project_doctor") {
      const projectPath = await input(args.projectPath, "projectPath");
      return projectDoctor(projectPath);
    }
    if (command === "add_project_reference") {
      const project = await input(args.projectPath, "projectPath");
      const audio = await input(args.audioPath, "audioPath");
      const result = await execute(python, [cvrs, "add-ref", project, "--audio", audio, "--name", text(args.trackName, "trackName"), "--begin-seconds", String(number(args.beginSeconds, "beginSeconds")), "--out", text(args.outputName, "outputName")], env);
      return workflow(command, "add-project-reference", result, "added_track", "Reference track added to a new project copy.", "out");
    }
    if (command === "export_project_without_parameters") {
      const project = await input(args.projectPath, "projectPath");
      const result = await execute(python, [cvrs, "strip-params", project, "--out", text(args.outputName, "outputName")], env);
      return workflow(command, "export-project-without-parameters", result, "cleared", "Parameter-free project copy exported.", "out");
    }
    if (command === "export_project_lyrics") {
      const project = await input(args.projectPath, "projectPath");
      const result = await execute(python, [cvrs, "export-lrc", project, "--track-index", String(number(args.trackIndex, "trackIndex")), "--line-gap-seconds", String(number(args.lineGapSeconds, "lineGapSeconds")), "--out", text(args.outputName, "outputName"), "--word-out", text(args.wordOutputName, "wordOutputName")], env);
      return workflow(command, "export-project-lyrics", result, "lineCount", "Standard and word-timed LRC files exported.", "lrcOut");
    }
    if (command === "run_pronunciation_diagnostics") {
      const projectPath = args.projectPath ? await input(args.projectPath, "projectPath") : undefined;
      const lyrics = typeof args.lyrics === "string" ? args.lyrics : undefined;
      return pronunciationDiagnostics(projectPath, lyrics);
    }
    if (command === "run_render_review") {
      const audioPath = await input(args.audioPath, "audioPath");
      const result = await execute(python, [piAudio, "probe", audioPath, ...(args.advanced === true || args.requireNotes === true ? ["--notes"] : [])], env);
      const issues: Array<{ code: string; severity: "warning" | "error"; message: string }> = [];
      const peak = finiteDataNumber(result.peak_dbfs);
      const clipped = finiteDataNumber(result.clipped_sample_ratio);
      const silence = finiteDataNumber(result.silent_frame_ratio);
      const duration = finiteDataNumber(result.duration_sec);
      const bpm = finiteDataNumber(result.bpm);
      if (peak !== undefined && peak >= 0) issues.push({ code: "PEAK_AT_OR_ABOVE_0_DBFS", severity: "error", message: "Audio reaches or exceeds digital full scale." });
      if (clipped !== undefined && clipped > 0.001) issues.push({ code: "CLIPPED_SAMPLES", severity: "warning", message: "Audio contains clipped samples." });
      if (silence !== undefined && silence > 0.8) issues.push({ code: "MOSTLY_SILENT", severity: "warning", message: "Most analyzed frames are silent." });
      if (args.expectedDurationSec !== undefined && args.expectedDurationSec !== null && duration !== undefined && Math.abs(duration - number(args.expectedDurationSec, "expectedDurationSec")) > 1) issues.push({ code: "DURATION_MISMATCH", severity: "warning", message: "Measured duration differs from the expected duration by more than one second." });
      if (args.expectedBpm !== undefined && args.expectedBpm !== null && bpm !== undefined && Math.abs(bpm - number(args.expectedBpm, "expectedBpm")) > 3) issues.push({ code: "BPM_MISMATCH", severity: "warning", message: "Estimated tempo differs from the expected tempo by more than 3 BPM." });
      const detectedNotes = result.notes && typeof result.notes === "object" ? finiteDataNumber((result.notes as Data).total) ?? 0 : 0;
      if (args.requireNotes === true && detectedNotes <= 0) issues.push({ code: "NO_NOTES_DETECTED", severity: "error", message: "The note detector found no notes." });
      const report = { kind: "render-quality-check", ok: !issues.some(issue => issue.severity === "error"), summary: `Render review found ${issues.length} issue(s).`, inspectedItems: Object.keys(result).length, issues };
      return { kind: "render-quality-check", summary: report.summary, data: { probe: result, report } };
    }
    if (command === "queue_media_separation") return workflow(command, "media-separation", await execute(python, [separation, await input(args.audioPath, "audioPath")], env), "status", "Media separation completed.");
    throw new Error(`No local component implements ${command}.`);
  };
}

async function runJson(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<Data> {
  return new Promise((done, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      const value = parseJsonOutput(stdout);
      if (typeof value?.error === "string") { reject(new Error(value.error)); return; }
      if (code !== 0) { reject(new Error(stderr || `${file} exited with ${code}`)); return; }
      if (!value) { reject(new Error(`Component returned invalid JSON: ${stdout.slice(0, 500)}`)); return; }
      done(value);
    });
  });
}

function workflow(command: string, kind: string, data: Data, evidenceKey: string, summary: string, outputKey?: string): Data {
  const outputPath = outputKey && typeof data[outputKey] === "string" ? data[outputKey] : undefined;
  return { kind, summary, data: { ...data, command, sourceTool: data.tool, evidence: data[evidenceKey] }, ...(outputPath ? { outputPath } : {}) };
}

async function input(value: unknown, name: string): Promise<string> {
  const path = text(value, name);
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path.`);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${name} must refer to a file.`);
  return resolve(path);
}

function outputNameFor(value: unknown, name: string, directory: unknown, fallback: string): string {
  const output = value === undefined || value === null || value === "" ? fallback : text(value, name);
  if (directory === undefined || directory === null || directory === "") return output;
  const root = text(directory, "outputDirectory");
  if (!isAbsolute(root)) throw new Error("outputDirectory must be an absolute path.");
  if (isAbsolute(output)) throw new Error(`${name} must be a file name when outputDirectory is set.`);
  if (output.includes("/") || output.includes("\\") || output === "." || output === "..") throw new Error(`${name} must be a file name when outputDirectory is set.`);
  return resolve(root, output);
}

function parseJsonOutput(output: string): Data | undefined {
  for (let start = output.indexOf("{"); start !== -1; start = output.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const character = output[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        try {
          const value = JSON.parse(output.slice(start, index + 1)) as Data;
          if (typeof value.tool === "string" || typeof value.error === "string") return value;
        } catch { break; }
      }
    }
  }
  return undefined;
}
function finiteDataNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`); return value; }
function number(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`); return value; }
