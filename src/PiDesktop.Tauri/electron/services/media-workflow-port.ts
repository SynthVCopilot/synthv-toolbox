import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { open, lstat, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { ComponentService } from "./component-service.js";
import type { MediaWorkflowPort, WorkflowProgress } from "./media-task-service.js";

type Data = Record<string, unknown>;
type Executor = (command: string, args: Data, options?: { signal?: AbortSignal }) => Promise<Data>;
type RunResult = { stdout: string; stderr: string };
type Runner = (file: string, args: string[], signal?: AbortSignal) => Promise<RunResult>;
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set([".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".aif", ".aiff"]);
const MEDIA_HOSTS = new Set(["youtube.com", "www.youtube.com", "youtu.be", "bilibili.com", "www.bilibili.com", "b23.tv"]);

export interface SynthVCoverPort {
  preflightCover(input: { processId: number | null; trackIndex: number; projectPath: string | null; requireEmpty: boolean }, signal: AbortSignal): Promise<Data>;
  importScore(input: { midiPath: string; voiceName: string; processId: number | null; trackIndex: number; groupName: string; rightsConfirmed: true; taskId: string; projectPath: string | null }, signal: AbortSignal): Promise<Data>;
  saveProject(input: { processId: number | null; taskId: string; importResult: Data }, signal: AbortSignal): Promise<Data>;
  exportRender(input: { processId: number | null; outputPath: string; iteration: number; taskId: string; importResult: Data }, signal: AbortSignal): Promise<Data>;
  applyTuning(input: { voiceName: string; processId: number | null; trackIndex: number; iteration: number; parameters: Data; importResult: Data; taskId: string }, signal: AbortSignal): Promise<Data>;
}

export interface MediaWorkflowOptions {
  dataRoot: string;
  componentStateRoot: string;
  components: ComponentService;
  execute: Executor;
  synthv: SynthVCoverPort;
  ffmpegPath?: string;
  ffprobePath?: string;
  run?: Runner;
  fetcher?: Fetcher;
}

export function createMediaWorkflowPort(options: MediaWorkflowOptions): MediaWorkflowPort {
  const dataRoot = resolve(options.dataRoot);
  const run = options.run ?? runProcess;
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));

  const runtime = () => resolveFfmpeg(options.componentStateRoot, options.ffmpegPath, options.ffprobePath);

  return {
    preflightCover(input, signal) {
      return options.synthv.preflightCover(input, signal);
    },

    async importMedia(input, signal, progress) {
      const outputDirectory = managedOutput(dataRoot, input.outputDirectory);
      await safeDirectory(outputDirectory);
      progress({ percent: 2, detail: "正在检查媒体来源。" });
      const sourceFile = isAbsolute(input.source)
        ? await adoptLocal(input.source, outputDirectory)
        : await downloadSource(input.source, outputDirectory, options.components, await runtime(), run, fetcher, signal, progress);
      throwIfAborted(signal);
      const audioPath = join(outputDirectory, "source.wav");
      const ffmpeg = await runtime();
      progress({ percent: 78, detail: "正在转换为 48 kHz WAV。" });
      await run(ffmpeg.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", sourceFile, "-vn", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le", audioPath], signal);
      const metadata = { source: input.source, adoptedPath: sourceFile, audioPath, sha256: await sha256(audioPath), byteLength: (await stat(audioPath)).size, importedAtUtc: new Date().toISOString() };
      await writeJson(join(outputDirectory, "import-manifest.json"), metadata);
      progress({ percent: 100, detail: "来源音频已校验并转为 WAV。" });
      return metadata;
    },

    async separateAudio(input, signal, progress) {
      const outputDirectory = managedOutput(dataRoot, input.outputDirectory);
      await safeDirectory(outputDirectory);
      if (input.mode === "vocal") {
        const ffmpeg = await runtime();
        const vocalPath = join(outputDirectory, "vocals.wav");
        const instrumentalPath = join(outputDirectory, "instrumental.wav");
        progress({ percent: 20, detail: "来源已声明为纯人声，正在准备标准人声轨。" });
        await run(ffmpeg.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", input.audioPath, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le", vocalPath], signal);
        progress({ percent: 65, detail: "正在生成与人声严格对齐的静音伴奏基线。" });
        await run(ffmpeg.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", vocalPath, "-af", "volume=0", "-c:a", "pcm_s24le", instrumentalPath], signal);
        progress({ percent: 100, detail: "纯人声与静音基线已准备。" });
        return { vocalPath, instrumentalPath, model: "declared-vocal", sourcePath: input.audioPath };
      }
      progress({ percent: 5, detail: "正在启动本地 Demucs 人声分离。" });
      const result = await options.execute("queue_media_separation", { audioPath: input.audioPath, outputDirectory: join(outputDirectory, "separation"), outputId: input.taskId }, { signal });
      progress({ percent: 100, detail: "人声与伴奏分离完成。" });
      return unwrap(result);
    },

    async audioToMidi(input, signal, progress) {
      const outputPath = managedOutput(dataRoot, input.outputPath);
      await safeDirectory(dirname(outputPath));
      let lyricsPath: string | undefined;
      if (input.lyrics) {
        lyricsPath = join(dirname(outputPath), "lyrics.txt");
        await writeFile(lyricsPath, input.lyrics, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(async reason => {
          if ((reason as NodeJS.ErrnoException).code !== "EEXIST") throw reason;
          await writeFile(lyricsPath!, input.lyrics!, { encoding: "utf8", mode: 0o600 });
        });
      }
      progress({ percent: 5, detail: "正在提取参考与伴奏音高事件。" });
      const result = await options.execute("run_game_to_midi", { vocalPath: input.vocalPath, instrumentalPath: input.instrumentalPath, outputPath, tolerance: input.tolerance, advanced: input.advanced, lyricsPath, transcribe: !lyricsPath }, { signal });
      const value = unwrap(result);
      const phonemeMarkerCount = value.phoneme_markers;
      if (typeof phonemeMarkerCount !== "number" || !Number.isSafeInteger(phonemeMarkerCount) || phonemeMarkerCount <= 0) throw new Error("声音转 MIDI 没有生成可验证的歌词与发音标记，拒绝将默认音节写入 SynthV。");
      progress({ percent: 100, detail: "单声部 MIDI 与歌词标记已生成。" });
      return { ...value, midiPath: stringValue(value, ["midiPath", "midi_out", "outputPath"]) ?? outputPath, pronunciationMarkersVerified: true, phonemeMarkerCount };
    },

    importScore: (input, signal) => options.synthv.importScore(input, signal),
    saveProject: (input, signal) => options.synthv.saveProject(input, signal),
    exportRender: (input, signal) => options.synthv.exportRender(input, signal),

    async compareAudio(input, signal) {
      const ffmpeg = await runtime();
      const [reference, render] = await Promise.all([
        analyzeAudio(input.referencePath, options.execute, ffmpeg, run, signal),
        analyzeAudio(input.renderPath, options.execute, ffmpeg, run, signal),
      ]);
      const comparison = compareFeatures(reference, render);
      return { iteration: input.iteration, reference, render, ...comparison };
    },

    async applyTuning(input, signal) {
      const parameters = tuningFromComparison(input.previousComparison, input.iteration);
      const applied = await options.synthv.applyTuning({ voiceName: input.voiceName, processId: input.processId, trackIndex: input.trackIndex, iteration: input.iteration, parameters, importResult: input.importResult, taskId: input.taskId }, signal);
      return { parameters, applied };
    },
  };
}

async function downloadSource(source: string, outputDirectory: string, components: ComponentService, ffmpeg: { ffmpeg: string; ffprobe: string }, run: Runner, fetcher: Fetcher, signal: AbortSignal, progress: (value: WorkflowProgress) => void): Promise<string> {
  const url = normalizeSourceUrl(source);
  if (MEDIA_HOSTS.has(url.hostname.toLowerCase())) {
    const mediaFetcher = await components.executable("media-fetcher");
    const template = join(outputDirectory, "download.%(ext)s");
    progress({ percent: 8, detail: "正在使用已验证的媒体获取组件下载音频。" });
    await run(mediaFetcher, ["--ignore-config", "--no-playlist", "--no-remote-components", "--restrict-filenames", "--extract-audio", "--audio-format", "wav", "--format", "bestaudio/best", "--max-filesize", "2G", "--ffmpeg-location", dirname(ffmpeg.ffmpeg), "--output", template, url.href], signal);
    const candidates = (await readdir(outputDirectory)).filter(name => name.startsWith("download.") && !name.endsWith(".part"));
    if (candidates.length !== 1) throw new Error("媒体获取组件没有生成唯一音频文件。");
    return join(outputDirectory, candidates[0]);
  }
  progress({ percent: 8, detail: "正在下载直接音频来源。" });
  return downloadHttps(url, join(outputDirectory, "download.source"), fetcher, signal, progress);
}

async function downloadHttps(initial: URL, destination: string, fetcher: Fetcher, signal: AbortSignal, progress: (value: WorkflowProgress) => void): Promise<string> {
  let url = initial;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    await assertPublicHttps(url);
    const response = await fetcher(url.href, { signal, redirect: "manual", headers: { "User-Agent": "Synthesizer-V-Toolbox/0.2" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === 5) throw new Error("媒体来源重定向无效或过多。");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`媒体下载失败（HTTP ${response.status}）。`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) throw new Error("媒体来源超过 2 GiB 限制。");
    const temporary = `${destination}.part`;
    const handle = await open(temporary, "wx", 0o600);
    let total = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        throwIfAborted(signal);
        const item = await reader.read();
        if (item.done) break;
        total += item.value.byteLength;
        if (total > MAX_SOURCE_BYTES) throw new Error("媒体来源超过 2 GiB 限制。");
        await handle.write(item.value);
        progress({ percent: declared > 0 ? Math.min(72, 8 + Math.round(total / declared * 64)) : 32, detail: `已下载 ${total} 字节。` });
      }
      await handle.sync();
    } catch (reason) {
      await handle.close();
      throw reason;
    }
    await handle.close();
    await rename(temporary, destination);
    return destination;
  }
  throw new Error("媒体来源重定向失败。");
}

async function adoptLocal(source: string, outputDirectory: string): Promise<string> {
  const absolute = resolve(source);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_SOURCE_BYTES || !AUDIO_EXTENSIONS.has(extname(absolute).toLowerCase())) throw new Error("本地来源必须是受支持、非符号链接且不超过 2 GiB 的音频文件。");
  const destination = join(outputDirectory, `adopted${extname(absolute).toLowerCase()}`);
  const input = await open(absolute, "r");
  const output = await open(destination, "wx", 0o600).catch(async reason => {
    if ((reason as NodeJS.ErrnoException).code !== "EEXIST") throw reason;
    return open(destination, "w", 0o600);
  });
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const item = await input.read(buffer, 0, buffer.length, position);
      if (!item.bytesRead) break;
      await output.write(buffer.subarray(0, item.bytesRead));
      position += item.bytesRead;
    }
    await output.sync();
  } finally {
    await Promise.all([input.close(), output.close()]);
  }
  return destination;
}

async function analyzeAudio(path: string, execute: Executor, ffmpeg: { ffmpeg: string; ffprobe: string }, run: Runner, signal: AbortSignal): Promise<Data> {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_SOURCE_BYTES) throw new Error("待比较音频文件无效。");
  const [probe, loudness, style] = await Promise.all([
    run(ffmpeg.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "json", absolute], signal).then(value => JSON.parse(value.stdout) as Data),
    run(ffmpeg.ffmpeg, ["-hide_banner", "-nostats", "-i", absolute, "-af", "loudnorm=print_format=json", "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"], signal).then(value => parseLoudness(value.stderr)),
    execute("run_source_style", { audioPath: absolute }, { signal }).then(unwrap),
  ]);
  return { path: absolute, durationSeconds: numeric((probe.format as Data | undefined)?.duration), loudness, style };
}

function compareFeatures(reference: Data, render: Data): Data {
  const referenceStyle = isRecord(reference.style) ? reference.style : {};
  const renderStyle = isRecord(render.style) ? render.style : {};
  const durationDeltaSeconds = numeric(render.durationSeconds) - numeric(reference.durationSeconds);
  const loudnessDeltaLufs = numeric((render.loudness as Data | undefined)?.integratedLufs) - numeric((reference.loudness as Data | undefined)?.integratedLufs);
  const pitchDeltaSemitones = numeric(readMetric(renderStyle, "median_pitch_midi", "medianPitchMidi")) - numeric(readMetric(referenceStyle, "median_pitch_midi", "medianPitchMidi"));
  const vibratoRateDeltaHz = numeric(readMetric(renderStyle, "vibrato_rate_hz", "vibratoRateHz")) - numeric(readMetric(referenceStyle, "vibrato_rate_hz", "vibratoRateHz"));
  const vibratoDepthDeltaCents = numeric(readMetric(renderStyle, "vibrato_depth_cents", "vibratoDepthCents")) - numeric(readMetric(referenceStyle, "vibrato_depth_cents", "vibratoDepthCents"));
  const brightnessDeltaHz = numeric(readMetric(renderStyle, "brightness_hz", "brightnessHz")) - numeric(readMetric(referenceStyle, "brightness_hz", "brightnessHz"));
  const penalties = [Math.abs(durationDeltaSeconds) / 2, Math.abs(loudnessDeltaLufs) / 6, Math.abs(pitchDeltaSemitones) / 4, Math.abs(vibratoRateDeltaHz) / 3, Math.abs(vibratoDepthDeltaCents) / 80, Math.abs(brightnessDeltaHz) / 2500];
  const similarityScore = Math.max(0, Math.min(1, 1 - penalties.reduce((sum, value) => sum + Math.min(1, value), 0) / penalties.length));
  return { similarityScore, metrics: { durationDeltaSeconds, loudnessDeltaLufs, pitchDeltaSemitones, vibratoRateDeltaHz, vibratoDepthDeltaCents, brightnessDeltaHz } };
}

function tuningFromComparison(comparison: Data, iteration: number): Data {
  const metrics = isRecord(comparison.metrics) ? comparison.metrics : {};
  const scale = 1 / Math.max(1, iteration);
  return {
    loudness: clamp(-numeric(metrics.loudnessDeltaLufs) * scale, -12, 12),
    tension: clamp(-numeric(metrics.brightnessDeltaHz) / 5_000 * scale, -1, 1),
    breathiness: 0,
    gender: 0,
    toneShift: clamp(-numeric(metrics.pitchDeltaSemitones) / 12 * scale, -1, 1),
  };
}

async function resolveFfmpeg(componentStateRoot: string, explicitFfmpeg?: string, explicitFfprobe?: string): Promise<{ ffmpeg: string; ffprobe: string }> {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const candidates: Array<{ ffmpeg?: string; ffprobe?: string }> = [];
  if (explicitFfmpeg) candidates.push({ ffmpeg: explicitFfmpeg, ffprobe: explicitFfprobe ?? join(dirname(explicitFfmpeg), `ffprobe${suffix}`) });
  if (process.env.SYNTHV_TOOLBOX_FFMPEG_DIRECTORY) candidates.push({ ffmpeg: join(process.env.SYNTHV_TOOLBOX_FFMPEG_DIRECTORY, `ffmpeg${suffix}`), ffprobe: join(process.env.SYNTHV_TOOLBOX_FFMPEG_DIRECTORY, `ffprobe${suffix}`) });
  try {
    const configured = JSON.parse(await readFile(join(componentStateRoot, "ffmpeg.json"), "utf8")) as { directory?: unknown };
    if (typeof configured.directory === "string" && configured.directory) candidates.push({ ffmpeg: join(configured.directory, `ffmpeg${suffix}`), ffprobe: join(configured.directory, `ffprobe${suffix}`) });
  } catch {}
  if (process.platform === "darwin") {
    for (const directory of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) candidates.push({ ffmpeg: join(directory, "ffmpeg"), ffprobe: join(directory, "ffprobe") });
  }
  for (const candidate of candidates) {
    if (candidate.ffmpeg && candidate.ffprobe && await regular(candidate.ffmpeg) && await regular(candidate.ffprobe)) return { ffmpeg: resolve(candidate.ffmpeg), ffprobe: resolve(candidate.ffprobe) };
  }
  throw new Error("未找到受验证的 FFmpeg/FFprobe。请在组件中心选择其目录。");
}

async function assertPublicHttps(url: URL): Promise<void> {
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("媒体来源必须是无凭据的标准 HTTPS URL。");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw new Error("媒体来源解析到本地、保留或私有网络地址。");
}

function privateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (normalized.startsWith("::ffff:")) return privateAddress(normalized.slice(7));
  }
  return version === 0;
}

function normalizeSourceUrl(value: string): URL {
  const trimmed = value.trim();
  const normalized = /^BV[0-9A-Za-z]{10}$/u.test(trimmed) ? `https://www.bilibili.com/video/${trimmed}/` : trimmed;
  let url: URL;
  try { url = new URL(normalized); } catch { throw new Error("媒体来源不是受支持的本地路径、BV 号或 HTTPS URL。"); }
  return url;
}

async function safeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("媒体输出目录不是安全的普通目录。");
}

function managedOutput(root: string, value: string): string {
  const candidate = resolve(value);
  const offset = relative(root, candidate);
  if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new Error("媒体输出路径不在任务数据根内。");
  return candidate;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

function runProcess(file: string, args: string[], signal?: AbortSignal): Promise<RunResult> {
  return new Promise((done, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, detached: process.platform !== "win32", signal });
    let stdout = ""; let stderr = "";
    child.stdout?.on("data", chunk => { if (stdout.length < 4 * 1024 * 1024) stdout += String(chunk); });
    child.stderr?.on("data", chunk => { if (stderr.length < 4 * 1024 * 1024) stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? done({ stdout, stderr }) : reject(new Error(stderr.slice(-4_000) || `${basename(file)} exited with ${code}`)));
  });
}

function parseLoudness(stderr: string): Data {
  const matches = [...stderr.matchAll(/\{[\s\S]*?"input_i"[\s\S]*?\}/gu)];
  let value: Data = {};
  try { value = JSON.parse(matches.at(-1)?.[0] ?? "{}"); } catch {}
  return { integratedLufs: numeric(value.input_i ?? value.output_i), truePeakDbtp: numeric(value.input_tp ?? value.output_tp), loudnessRange: numeric(value.input_lra ?? value.output_lra) };
}

function unwrap(value: Data): Data { return isRecord(value.data) ? value.data : value; }
function stringValue(value: Data, keys: string[]): string | undefined { for (const key of keys) if (typeof value[key] === "string" && value[key]) return value[key] as string; return undefined; }
function readMetric(value: Data, ...keys: string[]): unknown { for (const key of keys) if (value[key] !== undefined) return value[key]; return undefined; }
function numeric(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Task cancelled."); }
function isRecord(value: unknown): value is Data { return value !== null && typeof value === "object" && !Array.isArray(value); }
async function regular(path: string): Promise<boolean> { try { const value = await lstat(path); return value.isFile() && !value.isSymbolicLink(); } catch { return false; } }
async function sha256(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
