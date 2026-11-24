import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Args = Record<string, unknown>;
type Result = { stdout: string; stderr: string };
type AudioRequest = { inputPath: string; sampleRate?: number; channels?: number; sampleFormat?: "s16" | "s24" | "f32"; startSeconds?: number; durationSeconds?: number };
type NormalizeRequest = { inputPath: string; integratedLufs?: number; truePeakDbtp?: number; loudnessRange?: number };
type Plan = { planId: string; token: string; expiresAt: string; requestDigest: string; operation: string; inputPath: string; outputPath: string; parameters: string[]; warnings: string[] };
type Job = { id: string; operation: string; status: string; progressPercent?: number; outputPath?: string; artifactId?: string; loudnessReport?: unknown; error?: string; startedAt: string; completedAt?: string };
type Artifact = { path: string; operation: string };

export interface CommandRegistry { register(command: string, handler: (args: Args) => Promise<unknown>): void; }
export interface ComponentAudioOptions { ffmpegPath?: string; dataRoot: string; run?: (file: string, args: string[]) => Promise<Result>; reveal?: (path: string) => Promise<void>; saveFile?: (defaultName: string) => Promise<string | undefined>; openExternal?: (url: string) => Promise<void>; }

const runProcess = (file: string, args: string[]) => new Promise<Result>((done, reject) => {
  const child = spawn(file, args, { windowsHide: true, shell: false }); let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  child.once("error", reject); child.once("close", code => code === 0 ? done({ stdout, stderr }) : reject(new Error(stderr || `${file} exited with ${code}`)));
});

export function registerComponentAudioCommands(registry: CommandRegistry, options: ComponentAudioOptions): void {
  const root = resolve(options.dataRoot); const outputRoot = join(root, "audio-output"); const configPath = join(root, "ffmpeg.json"); const run = options.run ?? runProcess;
  const plans = new Map<string, { plan: Plan; digest: string; expires: number }>(); const jobs = new Map<string, Job>(); const artifacts = new Map<string, Artifact>();
  const readConfig = async (): Promise<{ directory: string | null }> => { try { const value = JSON.parse(await readFile(configPath, "utf8")); return { directory: typeof value.directory === "string" && value.directory ? value.directory : null }; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { directory: null }; throw error; } };
  const binaries = async () => { const config = await readConfig(); const suffix = process.platform === "win32" ? ".exe" : ""; return config.directory ? { ffmpeg: join(config.directory, `ffmpeg${suffix}`), ffprobe: join(config.directory, `ffprobe${suffix}`), source: "configured" } : { ffmpeg: options.ffmpegPath ?? "ffmpeg", ffprobe: options.ffmpegPath ? join(dirname(options.ffmpegPath), `ffprobe${suffix}`) : "ffprobe", source: options.ffmpegPath ? "configured" : "system" }; };
  const makePlan = async (operation: "prepare" | "normalize", request: AudioRequest | NormalizeRequest): Promise<Plan> => {
    const inputPath = resolve(text(request.inputPath, "inputPath")); if (!(await stat(inputPath)).isFile()) throw new Error("The audio input must be a file."); await mkdir(outputRoot, { recursive: true });
    const planId = randomUUID(); const token = randomUUID(); const digest = sha(request); const outputPath = join(outputRoot, `${operation}-${planId}.wav`);
    const parameters = operation === "prepare" ? prepareArgs(request as AudioRequest, inputPath, outputPath) : normalizeArgs(request as NormalizeRequest, inputPath, outputPath);
    const plan = { planId, token, expiresAt: new Date(Date.now() + 600_000).toISOString(), requestDigest: digest, operation, inputPath, outputPath, parameters, warnings: ["A managed WAV file will be created; the source is not modified."] };
    plans.set(token, { plan, digest, expires: Date.now() + 600_000 }); return plan;
  };
  const startJob = async (operation: "prepare" | "normalize", request: AudioRequest | NormalizeRequest, token: string): Promise<Job> => {
    const stored = plans.get(token); if (!stored || stored.expires < Date.now() || stored.plan.operation !== operation || stored.digest !== sha(request)) throw new Error("The audio write plan is invalid or expired."); plans.delete(token);
    const id = randomUUID(); const job: Job = { id, operation, status: "queued", progressPercent: 0, outputPath: stored.plan.outputPath, startedAt: new Date().toISOString() }; jobs.set(id, job);
    void (async () => { job.status = "running"; try { const runtime = await binaries(); const result = await run(runtime.ffmpeg, stored.plan.parameters); if (job.status === "cancelling") { job.status = "cancelled"; await rm(stored.plan.outputPath, { force: true }); } else { const artifactId = randomUUID(); artifacts.set(artifactId, { path: stored.plan.outputPath, operation }); job.status = "completed"; job.progressPercent = 100; job.artifactId = artifactId; if (operation === "normalize") job.loudnessReport = parseLoudness(result.stderr, stored.plan.outputPath); } } catch (error) { job.status = job.status === "cancelling" ? "cancelled" : "failed"; job.error = error instanceof Error ? error.message : String(error); } job.completedAt = new Date().toISOString(); })();
    return { ...job };
  };

  registry.register("ffmpeg_status", async () => { const runtime = await binaries(); try { await Promise.all([accessPath(runtime.ffmpeg), accessPath(runtime.ffprobe)]); const result = await run(runtime.ffmpeg, ["-version"]); return { available: true, source: runtime.source, ffmpegPath: runtime.ffmpeg, ffprobePath: runtime.ffprobe, version: result.stdout.split(/\r?\n/)[0] ?? "", detail: "FFmpeg and FFprobe are ready." }; } catch (error) { return { available: false, source: runtime.source, ffmpegPath: runtime.ffmpeg, ffprobePath: runtime.ffprobe, detail: error instanceof Error ? error.message : String(error) }; } });
  registry.register("get_ffmpeg_configuration", readConfig);
  registry.register("set_ffmpeg_directory", async args => { const directory = args.directory === null ? null : resolve(text(args.directory, "directory")); if (directory) { const suffix = process.platform === "win32" ? ".exe" : ""; await Promise.all([access(join(directory, `ffmpeg${suffix}`)), access(join(directory, `ffprobe${suffix}`))]); } await writeComponentState(configPath, { directory }); return { succeeded: true, summary: "FFmpeg configuration saved.", detail: directory ?? "System PATH" }; });
  registry.register("open_ffmpeg_download_page", async () => { if (!options.openExternal) throw new Error("External URL handling is unavailable."); await options.openExternal("https://ffmpeg.org/download.html"); return { succeeded: true, summary: "Opened the FFmpeg download page.", detail: "" }; });
  registry.register("probe_media", async args => { const path = resolve(text(args.path, "path")); await access(path); const runtime = await binaries(); const result = await run(runtime.ffprobe, ["-v", "error", "-show_entries", "format=format_name,duration,bit_rate:stream=codec_name,codec_type,sample_rate,channels,channel_layout,bits_per_sample", "-of", "json", path]); const raw = JSON.parse(result.stdout); const stream = raw.streams?.find((item: Args) => item.codec_type === "audio") ?? raw.streams?.[0] ?? {}; const format = raw.format ?? {}; return { path, container: format.format_name, codec: stream.codec_name, durationSeconds: number(format.duration), sampleRate: number(stream.sample_rate), channels: number(stream.channels), channelLayout: stream.channel_layout, bitDepth: number(stream.bits_per_sample), bitRate: number(format.bit_rate) }; });
  registry.register("plan_audio_prepare", async args => makePlan("prepare", object(args.request, "request") as AudioRequest));
  registry.register("start_audio_prepare", async args => startJob("prepare", object(args.request, "request") as AudioRequest, text(args.token, "token")));
  registry.register("analyze_loudness", async args => { const path = resolve(text(args.path, "path")); await access(path); const runtime = await binaries(); const result = await run(runtime.ffmpeg, ["-hide_banner", "-nostats", "-i", path, "-af", "loudnorm=print_format=json", "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"]); return parseLoudness(result.stderr, path); });
  registry.register("plan_loudness_normalize", async args => makePlan("normalize", object(args.request, "request") as NormalizeRequest));
  registry.register("start_loudness_normalize", async args => startJob("normalize", object(args.request, "request") as NormalizeRequest, text(args.token, "token")));
  registry.register("audio_job_snapshot", async args => { const job = jobs.get(text(args.id, "id")); if (!job) throw new Error("Audio job was not found."); return { ...job }; });
  registry.register("cancel_audio_job", async args => { const job = jobs.get(text(args.id, "id")); if (!job) throw new Error("Audio job was not found."); if (["queued", "running"].includes(job.status)) job.status = "cancelling"; return { ...job }; });
  registry.register("audio_artifact_info", async args => artifactInfo(artifacts, text(args.artifactId, "artifactId")));
  registry.register("reveal_audio_artifact", async args => { const artifact = getArtifact(artifacts, text(args.artifactId, "artifactId")); if (!options.reveal) throw new Error("File reveal is unavailable."); await options.reveal(artifact.path); return null; });
  registry.register("save_audio_artifact", async args => { const artifact = getArtifact(artifacts, text(args.artifactId, "artifactId")); const destination = await options.saveFile?.(basename(artifact.path)); if (!destination) return { saved: false }; await copyFile(artifact.path, destination); return { saved: true, fileName: basename(destination) }; });
  registry.register("audio_capture_capability", async () => ({ available: false, platform: process.platform, reason: "System audio capture requires a platform capture component." })); registry.register("list_synthv_capture_targets", async () => []);
  for (const command of ["capture_synthv_clip", "compare_synthv_clips"]) registry.register(command, async () => { throw new Error(`${command} requires the platform audio capture component.`); });
  const tasks: Args[] = []; registry.register("component_downloads", async () => tasks); registry.register("queue_component_install", async args => { const id = text(args.id, "id"); const bundled = ["pi-audio", "cvrs", "vocal-separation"].includes(id); tasks.unshift({ id: randomUUID(), componentId: id, status: bundled ? "completed" : "failed", downloadedBytes: 0, totalBytes: null, error: bundled ? null : "No managed installer is available.", createdAt: new Date().toISOString() }); return tasks; });
  for (const [command, status] of [["cancel_component_install", "cancelled"], ["retry_component_install", "queued"]]) registry.register(command, async args => updateTask(tasks, text(args.taskId, "taskId"), status));
  registry.register("open_downloaded_component", async () => { throw new Error("There is no downloaded installer to open."); }); registry.register("remove_local_component", async () => { throw new Error("Bundled components cannot be removed separately."); });
}

function prepareArgs(request: AudioRequest, input: string, output: string): string[] { const args = ["-y"]; if (valid(request.startSeconds, 0)) args.push("-ss", String(request.startSeconds)); args.push("-i", input); if (valid(request.durationSeconds, Number.EPSILON)) args.push("-t", String(request.durationSeconds)); if (request.sampleRate !== undefined) args.push("-ar", String(integer(request.sampleRate, 8_000, 384_000, "sampleRate"))); if (request.channels !== undefined) args.push("-ac", String(integer(request.channels, 1, 8, "channels"))); args.push("-c:a", { s16: "pcm_s16le", s24: "pcm_s24le", f32: "pcm_f32le" }[request.sampleFormat ?? "s24"], output); return args; }
function normalizeArgs(request: NormalizeRequest, input: string, output: string): string[] { const i = finite(request.integratedLufs ?? -16, -70, -5, "integratedLufs"); const tp = finite(request.truePeakDbtp ?? -1.5, -9, 0, "truePeakDbtp"); const lra = finite(request.loudnessRange ?? 11, 1, 50, "loudnessRange"); return ["-y", "-i", input, "-af", `loudnorm=I=${i}:TP=${tp}:LRA=${lra}:print_format=json`, "-c:a", "pcm_s24le", output]; }
function parseLoudness(stderr: string, path: string) { const matches = [...stderr.matchAll(/\{[\s\S]*?"input_i"[\s\S]*?\}/g)]; let raw: Args = {}; try { raw = JSON.parse(matches.at(-1)?.[0] ?? "{}"); } catch {} return { path, integratedLufs: number(raw.input_i ?? raw.output_i), truePeakDbtp: number(raw.input_tp ?? raw.output_tp), loudnessRange: number(raw.input_lra ?? raw.output_lra), threshold: number(raw.input_thresh ?? raw.output_thresh), raw }; }
async function artifactInfo(artifacts: Map<string, Artifact>, id: string) { const artifact = getArtifact(artifacts, id); const info = await stat(artifact.path); return { artifactId: id, operation: artifact.operation, fileName: basename(artifact.path), byteLength: info.size, mimeType: extname(artifact.path).toLowerCase() === ".wav" ? "audio/wav" : undefined, mediaUrl: pathToFileURL(artifact.path).href }; }
function getArtifact(artifacts: Map<string, Artifact>, id: string) { const artifact = artifacts.get(id); if (!artifact) throw new Error("Audio artifact was not found."); return artifact; }
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`); return value; }
function object(value: unknown, name: string): Args { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`); return value as Args; }
function number(value: unknown): number | undefined { const result = Number(value); return Number.isFinite(result) ? result : undefined; }
function finite(value: number, min: number, max: number, name: string): number { if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} is outside the supported range.`); return value; }
function integer(value: number, min: number, max: number, name: string): number { if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`); return finite(value, min, max, name); }
function valid(value: unknown, min: number): value is number { return typeof value === "number" && Number.isFinite(value) && value >= min; }
function sha(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
async function accessPath(file: string): Promise<void> { if (file.includes("/") || file.includes("\\")) await access(file); }
function updateTask(tasks: Args[], id: string, status: string): Args[] { const task = tasks.find(item => item.id === id); if (!task) throw new Error("Component task was not found."); task.status = status; return tasks; }
export async function writeComponentState(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(value), "utf8"); await rename(temporary, path); }
