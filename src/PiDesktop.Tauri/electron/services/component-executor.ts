import { spawn } from "node:child_process";
import { resolve } from "node:path";

type Data = Record<string, unknown>;

export function createComponentExecutor(componentsRoot: string, python = process.env.SYNTHV_TOOLBOX_PYTHON ?? (process.platform === "win32" ? "python.exe" : "python3"), execute: (file: string, args: string[]) => Promise<Data> = runJson) {
  const piAudio = resolve(componentsRoot, "pi-audio", "pi_audio.py");
  const cvrs = resolve(componentsRoot, "cvrs", "cvrs.py");
  const separation = resolve(componentsRoot, "vocal-separation", "separate.py");
  return async (command: string, args: Data): Promise<Data> => {
    if (command === "run_audio_probe") return wrap(command, await execute(python, [piAudio, "probe", text(args.audioPath, "audioPath"), ...(args.advanced === true ? ["--notes"] : [])]));
    if (command === "run_game_to_midi") return wrap(command, await execute(python, [piAudio, "pair-diff", text(args.vocalPath, "vocalPath"), text(args.instrumentalPath, "instrumentalPath"), "--midi", text(args.outputName, "outputName"), "--tol", String(number(args.tolerance, "tolerance")), ...(args.advanced === true ? ["--advanced"] : [])]));
    if (command === "run_project_probe" || command === "run_project_doctor") return wrap(command, await execute(python, [cvrs, "probe", text(args.projectPath ?? args.inputPath, "projectPath")]));
    if (command === "add_project_reference") return wrap(command, await execute(python, [cvrs, "add-ref", text(args.projectPath, "projectPath"), "--audio", text(args.audioPath, "audioPath"), "--name", text(args.trackName, "trackName"), "--begin-seconds", String(number(args.beginSeconds, "beginSeconds")), "--out", text(args.outputName, "outputName")]));
    if (command === "export_project_without_parameters") return wrap(command, await execute(python, [cvrs, "strip-params", text(args.projectPath, "projectPath"), "--out", text(args.outputName, "outputName")]));
    if (command === "export_project_lyrics") return wrap(command, await execute(python, [cvrs, "export-lrc", text(args.projectPath, "projectPath"), "--track-index", String(number(args.trackIndex, "trackIndex")), "--line-gap-seconds", String(number(args.lineGapSeconds, "lineGapSeconds")), "--out", text(args.outputName, "outputName"), "--word-out", text(args.wordOutputName, "wordOutputName")]));
    if (command === "queue_media_separation") return wrap(command, await execute(python, [separation, text(args.audioPath, "audioPath")]));
    throw new Error(`No local component implements ${command}.`);
  };
}

function runJson(file: string, args: string[]): Promise<Data> { return new Promise((done, reject) => { const child = spawn(file, args, { shell: false, windowsHide: true }); let stdout = ""; let stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject); child.once("close", code => { if (code !== 0) { reject(new Error(stderr || parseError(stdout) || `${file} exited with ${code}`)); return; } try { done(JSON.parse(stdout) as Data); } catch { reject(new Error(`Component returned invalid JSON: ${stdout.slice(0, 500)}`)); } }); }); }
function wrap(kind: string, data: Data): Data { return { kind, summary: `${kind} completed.`, data, outputPath: typeof data.outputPath === "string" ? data.outputPath : undefined, succeeded: true }; }
function parseError(value: string): string | undefined { try { const parsed = JSON.parse(value); return typeof parsed.error === "string" ? parsed.error : undefined; } catch { return undefined; } }
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`); return value; }
function number(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`); return value; }
