import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { ComponentId, ComponentService } from "./component-service.js";

type Data = Record<string, unknown>;

export type ComponentExecutionOptions = { signal?: AbortSignal };
export type ComponentExecutor = (command: string, args: Data, options?: ComponentExecutionOptions) => Promise<Data>;

export function createComponentExecutor(componentsRoot: string, python?: string, execute: (file: string, args: string[], options?: ComponentExecutionOptions) => Promise<Data> = runJson, components?: ComponentService): ComponentExecutor {
  const script = (id: ComponentId, fallback: string) => components?.script(id) ?? resolve(componentsRoot, id, fallback);
  const interpreter = (id: ComponentId) => components?.interpreter(id) ?? python;
  const invoke = async (id: ComponentId, args: string[], options?: ComponentExecutionOptions) => {
    const file = interpreter(id);
    if (!file) throw new Error(`${id} is not installed. Install it from the component center; Toolbox never relies on Finder PATH to run a component.`);
    return execute(file, args, options);
  };
  const piAudio = script("pi-audio", "pi_audio.py");
  const cvrs = script("cvrs", "cvrs.py");
  const separation = script("vocal-separation", "separate.py");
  return async (command: string, args: Data, options?: ComponentExecutionOptions): Promise<Data> => {
    if (command === "run_audio_probe") return wrap(command, await invoke("pi-audio", [piAudio, "probe", text(args.audioPath, "audioPath"), ...(args.advanced === true ? ["--notes"] : [])], options));
    if (command === "run_source_style") return wrap(command, await invoke("pi-audio", [piAudio, "source-style", text(args.audioPath, "audioPath")], options));
    if (command === "run_game_to_midi") {
      const output = text(args.outputPath ?? args.outputName, "outputPath");
      const commandArgs = [piAudio, "pair-diff", text(args.vocalPath, "vocalPath"), text(args.instrumentalPath, "instrumentalPath"), "--midi", output, "--tol", String(number(args.tolerance, "tolerance"))];
      if (isAbsolute(output)) commandArgs.push("--output-external");
      if (typeof args.lyricsPath === "string" && args.lyricsPath) commandArgs.push("--lyrics-file", args.lyricsPath);
      if (args.advanced === true) commandArgs.push("--advanced");
      return wrap(command, await invoke("pi-audio", commandArgs, options));
    }
    if (command === "run_project_probe" || command === "run_project_doctor") return wrap(command, await invoke("cvrs", [cvrs, "probe", text(args.projectPath ?? args.inputPath, "projectPath")], options));
    if (command === "add_project_reference") return wrap(command, await invoke("cvrs", [cvrs, "add-ref", text(args.projectPath, "projectPath"), "--audio", text(args.audioPath, "audioPath"), "--name", text(args.trackName, "trackName"), "--begin-seconds", String(number(args.beginSeconds, "beginSeconds")), "--out", text(args.outputName, "outputName")], options));
    if (command === "export_project_without_parameters") return wrap(command, await invoke("cvrs", [cvrs, "strip-params", text(args.projectPath, "projectPath"), "--out", text(args.outputName, "outputName")], options));
    if (command === "export_project_lyrics") return wrap(command, await invoke("cvrs", [cvrs, "export-lrc", text(args.projectPath, "projectPath"), "--track-index", String(number(args.trackIndex, "trackIndex")), "--line-gap-seconds", String(number(args.lineGapSeconds, "lineGapSeconds")), "--out", text(args.outputName, "outputName"), "--word-out", text(args.wordOutputName, "wordOutputName")], options));
    if (command === "queue_media_separation") {
      const commandArgs = [separation, text(args.audioPath, "audioPath")];
      if (typeof args.outputId === "string" && args.outputId) commandArgs.push("--output-id", args.outputId);
      if (typeof args.outputDirectory === "string" && args.outputDirectory) commandArgs.push("--output-directory", args.outputDirectory);
      return wrap(command, await invoke("vocal-separation", commandArgs, options));
    }
    throw new Error(`No local component implements ${command}.`);
  };
}

function runJson(file: string, args: string[], options?: ComponentExecutionOptions): Promise<Data> { return new Promise((done, reject) => { const child = spawn(file, args, { shell: false, windowsHide: true, signal: options?.signal }); let stdout = ""; let stderr = ""; child.stdout.on("data", chunk => { if (stdout.length < 4 * 1024 * 1024) stdout += chunk; }); child.stderr.on("data", chunk => { if (stderr.length < 4 * 1024 * 1024) stderr += chunk; }); child.once("error", reject); child.once("close", code => { if (code !== 0) { reject(new Error(stderr || parseError(stdout) || `${file} exited with ${code}`)); return; } try { done(JSON.parse(stdout) as Data); } catch { reject(new Error(`Component returned invalid JSON: ${stdout.slice(0, 500)}`)); } }); }); }
function wrap(kind: string, data: Data): Data { const outputPath = [data.outputPath, data.midi_out, data.vocalPath, data.lrcOut].find(value => typeof value === "string"); return { kind, summary: `${kind} completed.`, data, ...(typeof outputPath === "string" ? { outputPath } : {}), succeeded: true }; }
function parseError(value: string): string | undefined { try { const parsed = JSON.parse(value); return typeof parsed.error === "string" ? parsed.error : undefined; } catch { return undefined; } }
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`); return value; }
function number(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`); return value; }
