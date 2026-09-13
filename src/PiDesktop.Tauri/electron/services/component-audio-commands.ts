import { access, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";

type Args = Record<string, unknown>;
export interface CommandRegistry { register(command: string, handler: (args: Args) => Promise<unknown>): void; }
export interface ComponentAudioOptions { ffmpegPath?: string; dataRoot: string; run?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>; }

const runProcess = (file: string, args: string[]) => new Promise<{ stdout: string; stderr: string }>((resolveRun, reject) => {
  const child = spawn(file, args, { windowsHide: true, shell: false }); let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject); child.once("close", (code) => code === 0 ? resolveRun({ stdout, stderr }) : reject(new Error(stderr || `${file} exited with ${code}`)));
});

export function registerComponentAudioCommands(registry: CommandRegistry, options: ComponentAudioOptions): void {
  const ffmpeg = options.ffmpegPath ?? "ffmpeg"; const run = options.run ?? runProcess; let config: { directory: string | null } = { directory: null };
  const unavailable = async (name: string) => { throw new Error(`${name} requires a configured component executor.`); };
  registry.register("ffmpeg_status", async () => { try { const result = await run(ffmpeg, ["-version"]); return { available: true, path: ffmpeg, version: result.stdout.split("\n")[0] ?? "" }; } catch (error) { return { available: false, path: null, version: null, error: error instanceof Error ? error.message : String(error) }; } });
  registry.register("get_ffmpeg_configuration", async () => config);
  registry.register("set_ffmpeg_directory", async (args) => { const directory = args.directory === null ? null : String(args.directory ?? ""); config = { directory }; return { succeeded: true, summary: "FFmpeg configuration saved.", detail: directory }; });
  registry.register("probe_media", async (args) => { const path = resolve(String(args.path ?? "")); await access(path); const result = await run(ffmpeg, ["-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,sample_rate,channels", "-of", "json", path]); return { path, raw: JSON.parse(result.stdout) }; });
  registry.register("audio_capture_capability", async () => ({ available: process.platform === "win32" || process.platform === "darwin", platform: process.platform, reason: process.platform === "win32" || process.platform === "darwin" ? null : "Audio capture is unsupported on this platform." }));
  registry.register("audio_capture_targets", async () => []);
  for (const command of ["start_audio_prepare", "start_loudness_normalize", "cancel_audio_job", "audio_job_snapshot", "audio_artifact_info", "save_audio_artifact", "reveal_audio_artifact", "capture_audio", "compare_audio", "component_downloads", "install_component", "cancel_component_download", "retry_component_download", "open_component_download", "remove_component"]) registry.register(command, async () => unavailable(command));
}

export async function writeComponentState(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.tmp`; await writeFile(temporary, JSON.stringify(value), "utf8"); await rename(temporary, path); }
