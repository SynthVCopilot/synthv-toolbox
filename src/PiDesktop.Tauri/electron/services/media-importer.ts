import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

type MediaSourcePreview = {
  sourceUrl: string;
  canonicalUrl: string;
  platform: string;
  mediaId: string;
  title: string;
  uploader: string;
  durationSeconds?: number | null;
  thumbnailUrl?: string | null;
};
type MediaImportResult = {
  importId: string;
  source: MediaSourcePreview;
  audioPath: string;
  metadataPath: string;
  manifestPath: string;
  sha256: string;
  importedAtUtc: string;
};
type Progress = (progress: number, detail: string) => void;
type SourceOptions = { signal?: AbortSignal };
type ImportOptions = SourceOptions & { rightsConfirmed: boolean; onProgress?: Progress };
type ProcessResult = { stdout: string; stderr: string; code: number };
type ProcessOptions = { signal?: AbortSignal; stdoutLimit?: number; onStderr?: (chunk: string) => void; cwd?: string };
type SourceIdentity = { platform: "bilibili" | "youtube"; mediaId: string; canonicalUrl: string };
type Metadata = Record<string, unknown>;

export interface MediaImporterOptions {
  dataRoot: string;
  python?: string;
  ffmpegPath?: string;
}

export interface MediaImporter {
  preview(source: string, options?: SourceOptions): Promise<MediaSourcePreview>;
  importSource(source: string, options: ImportOptions): Promise<MediaImportResult>;
}

const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_PROCESS_LOG_BYTES = 256 * 1024;

export function createMediaImporter(options: MediaImporterOptions): MediaImporter {
  const dataRoot = resolve(options.dataRoot);
  const python = options.python ?? process.env.SYNTHV_TOOLBOX_PYTHON ?? (process.platform === "win32" ? "python.exe" : process.platform === "darwin" ? "python3.11" : "python3");
  const ffmpeg = options.ffmpegPath ?? "ffmpeg";
  const ffprobe = options.ffmpegPath && hasPathSeparator(options.ffmpegPath)
    ? join(dirname(resolve(options.ffmpegPath)), process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
    : "ffprobe";

  const inspectSource = async (source: string, request: SourceOptions = {}): Promise<{ source: MediaSourcePreview; metadata: Metadata }> => {
    throwIfAborted(request.signal);
    const identity = parseSource(source);
    const result = await runYtDlp(python, ["--ignore-config", "--no-playlist", "--no-warnings", "--skip-download", "--dump-single-json", identity.canonicalUrl], {
      signal: request.signal,
      stdoutLimit: MAX_METADATA_BYTES,
    });
    assertSuccess(result, "yt-dlp", python);
    let metadata: Metadata;
    try {
      metadata = JSON.parse(result.stdout.trim()) as Metadata;
    } catch {
      throw new Error("yt-dlp returned invalid single-video metadata.");
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || metadata._type === "playlist" || Array.isArray(metadata.entries)) {
      throw new Error("Only a single video source can be imported.");
    }
    if (metadata.is_live === true || metadata.live_status === "is_live") throw new Error("Live streams cannot be imported as complete videos.");
    const metadataId = text(metadata.id, "video id");
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(metadataId)) throw new Error("The video platform returned an invalid media id.");
    if (metadataId !== identity.mediaId) throw new Error("The media id returned by the platform did not match the requested video.");
    const title = text(metadata.title, "video title");
    const uploader = firstText(metadata.uploader, metadata.channel, metadata.creator);
    if (!uploader) throw new Error("The video platform did not provide an uploader name.");
    const canonicalUrl = canonicalSource(identity, metadataId, metadata.webpage_url);
    const durationSeconds = typeof metadata.duration === "number" && Number.isFinite(metadata.duration) && metadata.duration > 0
      ? metadata.duration
      : null;
    const thumbnailUrl = safeHttpsUrl(metadata.thumbnail);
    return {
      source: {
        sourceUrl: source.trim(),
        canonicalUrl,
        platform: identity.platform,
        mediaId: metadataId,
        title,
        uploader,
        durationSeconds,
        thumbnailUrl,
      },
      metadata,
    };
  };
  const preview = async (source: string, request: SourceOptions = {}): Promise<MediaSourcePreview> => (await inspectSource(source, request)).source;

  const importSource = async (source: string, request: ImportOptions): Promise<MediaImportResult> => {
    if (request.rightsConfirmed !== true) throw new Error("Confirm that you have the rights to import this media before downloading it.");
    throwIfAborted(request.signal);
    const rightsConfirmedAtUtc = new Date().toISOString();
    reportProgress(request.onProgress, 2, "Reading source metadata");
    const { source: mediaSource, metadata } = await inspectSource(source, { signal: request.signal });
    throwIfAborted(request.signal);
    const importId = randomUUID();
    const importedAtUtc = new Date().toISOString();
    const outputRoot = await ensureMediaRoot(dataRoot);
    const staging = join(outputRoot, `.staging-${importId}`);
    const finalDirectory = join(outputRoot, importId);
    let ownsStaging = false;

    try {
      await mkdir(staging, { mode: 0o700 });
      ownsStaging = true;
      reportProgress(request.onProgress, 8, "Downloading the complete source audio");
      let progressBuffer = "";
      const outputTemplate = join(staging, "source.%(ext)s");
      const download = await runYtDlp(python, [
        "--no-cache-dir", "--ignore-config", "--no-playlist", "--no-warnings", "--newline", "--no-write-info-json",
        "--no-write-thumbnail", "--no-write-subs", "--no-write-auto-subs", "--format", "bestaudio/best", "--output", outputTemplate,
        mediaSource.canonicalUrl,
      ], {
        signal: request.signal,
        stdoutLimit: MAX_PROCESS_LOG_BYTES,
        cwd: staging,
        onStderr: (chunk) => {
          progressBuffer += chunk;
          const lines = progressBuffer.split(/\r?\n/u);
          progressBuffer = lines.pop() ?? "";
          for (const line of lines) {
            const match = line.match(/(?:\[download\]\s*)?(\d{1,3}(?:\.\d+)?)%/u);
            if (match) reportProgress(request.onProgress, 8 + Math.min(80, Number(match[1]) * 0.8), "Downloading the complete source audio");
          }
        },
      });
      assertSuccess(download, "yt-dlp", python);
      throwIfAborted(request.signal);

      const sourcePath = await findDownloadedSource(staging);
      const sourceInfo = await lstat(sourcePath);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size <= 0) throw new Error("yt-dlp did not produce a complete source media file.");
      const audioPath = join(staging, "audio.wav");
      await assertDestinationAbsent(audioPath);
      reportProgress(request.onProgress, 90, "Converting the complete audio to WAV");
      const converted = await runTool(ffmpeg, "ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-i", sourcePath,
        "-map", "0:a:0", "-vn", "-c:a", "pcm_s24le", audioPath,
      ], { signal: request.signal, stdoutLimit: MAX_PROCESS_LOG_BYTES, cwd: staging });
      assertSuccess(converted, "ffmpeg", ffmpeg);
      throwIfAborted(request.signal);

      const audioInfo = await lstat(audioPath);
      if (!audioInfo.isFile() || audioInfo.isSymbolicLink() || audioInfo.size < 44) throw new Error("ffmpeg did not produce a complete WAV file.");
      const header = await readWavHeader(audioPath);
      if (header.subarray(0, 4).toString("ascii") !== "RIFF" || header.subarray(8, 12).toString("ascii") !== "WAVE") {
        throw new Error("ffmpeg output is not a valid WAV file.");
      }
      const measured = await inspectWav(ffprobe, audioPath, request.signal);
      if (mediaSource.durationSeconds && measured.durationSeconds + Math.max(3, mediaSource.durationSeconds * 0.02) < mediaSource.durationSeconds) {
        throw new Error("The downloaded WAV is shorter than the source duration; the import was not published.");
      }
      await rm(sourcePath);
      const sha256 = await hashFile(audioPath);
      const metadataPath = join(staging, "metadata.json");
      const manifestPath = join(staging, "manifest.json");
      const manifest = {
        schemaVersion: 1,
        importId,
        source: mediaSource,
        sourceMetadata: metadata,
        sourceMetadataFile: "metadata.json",
        rightsConfirmed: true,
        rightsConfirmedAtUtc,
        importedAtUtc,
        durationSeconds: measured.durationSeconds,
        sha256,
      };
      await writeExclusiveJson(metadataPath, metadata);
      await writeExclusiveJson(manifestPath, manifest);
      throwIfAborted(request.signal);
      await rename(staging, finalDirectory);
      ownsStaging = false;
      reportProgress(request.onProgress, 100, "Import complete");
      return {
        importId,
        source: mediaSource,
        audioPath: join(finalDirectory, "audio.wav"),
        metadataPath: join(finalDirectory, "metadata.json"),
        manifestPath: join(finalDirectory, "manifest.json"),
        sha256,
        importedAtUtc,
      };
    } finally {
      if (ownsStaging) await rm(staging, { recursive: true, force: true });
    }
  };

  return { preview, importSource };
}

function parseSource(value: string): SourceIdentity {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) throw new Error("A valid single-video HTTPS URL is required.");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("A valid single-video HTTPS URL is required.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port) throw new Error("Only public HTTPS video URLs are supported.");
  const host = url.hostname.toLowerCase();
  if (["bilibili.com", "www.bilibili.com", "m.bilibili.com"].includes(host)) {
    const match = url.pathname.match(/^\/video\/(BV[A-Za-z0-9]+)\/?$/u);
    if (!match) throw new Error("Use a single Bilibili BV video URL.");
    const pages = url.searchParams.getAll("p");
    const page = pages[0];
    if (pages.length > 1 || (page !== undefined && (!/^\d{1,4}$/u.test(page) || Number(page) < 1))) throw new Error("Use a valid single Bilibili video page.");
    const suffix = page && /^\d{1,4}$/u.test(page) ? `?p=${page}` : "";
    return { platform: "bilibili", mediaId: match[1], canonicalUrl: `https://www.bilibili.com/video/${match[1]}/${suffix}` };
  }
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
    const match = url.pathname.match(/^\/(?:watch|shorts\/([A-Za-z0-9_-]{1,64})|embed\/([A-Za-z0-9_-]{1,64})|live\/([A-Za-z0-9_-]{1,64}))\/?$/u);
    const mediaId = match?.[1] ?? match?.[2] ?? match?.[3] ?? (["/watch", "/watch/"].includes(url.pathname) ? url.searchParams.get("v") : null);
    if (!mediaId || !/^[A-Za-z0-9_-]{1,64}$/u.test(mediaId)) throw new Error("Use a single YouTube video URL.");
    return { platform: "youtube", mediaId, canonicalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(mediaId)}` };
  }
  if (host === "youtu.be") {
    const match = url.pathname.match(/^\/([A-Za-z0-9_-]{1,64})\/?$/u);
    const mediaId = match?.[1];
    if (!mediaId) throw new Error("Use a single YouTube video URL.");
    return { platform: "youtube", mediaId, canonicalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(mediaId)}` };
  }
  throw new Error("Supported sources are single Bilibili BV and YouTube videos over HTTPS.");
}

function canonicalSource(identity: SourceIdentity, mediaId: string, metadataUrl: unknown): string {
  if (typeof metadataUrl === "string") {
    let returned: URL;
    try {
      returned = new URL(metadataUrl);
    } catch {
      throw new Error("The video platform returned an invalid canonical URL.");
    }
    const allowedHosts = identity.platform === "bilibili"
      ? ["bilibili.com", "www.bilibili.com", "m.bilibili.com"]
      : ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"];
    if (returned.protocol !== "https:" || !allowedHosts.includes(returned.hostname.toLowerCase())) {
      throw new Error("The video platform returned an unexpected canonical URL.");
    }
  }
  if (identity.platform === "bilibili") {
    if (!/^BV[A-Za-z0-9]+$/iu.test(mediaId)) throw new Error("The Bilibili extractor returned a non-BV media id.");
    const page = new URL(identity.canonicalUrl).searchParams.get("p");
    return `https://www.bilibili.com/video/${mediaId}/${page ? `?p=${page}` : ""}`;
  }
  return `https://www.youtube.com/watch?v=${encodeURIComponent(mediaId)}`;
}

async function ensureMediaRoot(dataRoot: string): Promise<string> {
  await mkdir(dataRoot, { recursive: true });
  const canonicalRoot = await realpath(dataRoot);
  const mediaRoot = join(canonicalRoot, "media");
  await mkdir(mediaRoot, { recursive: true });
  const info = await lstat(mediaRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The managed media output directory must not be a symbolic link.");
  const canonicalMediaRoot = await realpath(mediaRoot);
  assertWithin(canonicalRoot, canonicalMediaRoot);
  return canonicalMediaRoot;
}

async function findDownloadedSource(directory: string): Promise<string> {
  const names = await readdir(directory);
  const candidates = names.filter((name) => name.startsWith("source.") && !name.endsWith(".part") && !name.endsWith(".ytdl"));
  if (candidates.length !== 1 || names.length !== 1) throw new Error("yt-dlp must produce exactly one complete media file without sidecars.");
  const path = join(directory, candidates[0]);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("yt-dlp returned an unsafe media output path.");
  assertWithin(await realpath(directory), await realpath(path));
  return path;
}

async function inspectWav(ffprobe: string, path: string, signal?: AbortSignal): Promise<{ durationSeconds: number }> {
  const result = await runTool(ffprobe, "ffprobe", [
    "-v", "error", "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,sample_rate,channels", "-of", "json", path,
  ], { signal, stdoutLimit: 64 * 1024 });
  assertSuccess(result, "ffprobe", ffprobe);
  let info: Metadata;
  try {
    info = JSON.parse(result.stdout) as Metadata;
  } catch {
    throw new Error("ffprobe returned invalid WAV metadata.");
  }
  const format = info.format as Metadata | undefined;
  const streams = Array.isArray(info.streams) ? info.streams as Metadata[] : [];
  if (typeof format?.format_name !== "string" || !format.format_name.split(",").includes("wav") || !streams.some((stream) => stream.codec_type === "audio")) {
    throw new Error("The imported output does not contain WAV audio.");
  }
  const durationSeconds = Number(format.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("The imported WAV has no measurable duration.");
  return { durationSeconds };
}

async function writeExclusiveJson(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readWavHeader(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  const header = Buffer.alloc(12);
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length) throw new Error("The WAV header is incomplete.");
  } finally {
    await handle.close();
  }
  return header;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function runYtDlp(python: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  try {
    return await runProcess(python, ["-m", "yt_dlp", "--no-cache-dir", ...args], options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`The configured Python executable was not found: ${python}.`);
    throw error;
  }
}

async function runTool(file: string, name: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  try {
    return await runProcess(file, args, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${name} is unavailable at ${file}. Install or configure it before importing media.`);
    throw error;
  }
}

function runProcess(file: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  throwIfAborted(options.signal);
  return new Promise((resolveResult, rejectResult) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd: options.cwd ?? process.cwd(), detached: process.platform !== "win32", windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      rejectResult(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let cancelled = false;
    let treeTermination: Promise<void> | undefined;
    const stdoutLimit = options.stdoutLimit ?? MAX_PROCESS_LOG_BYTES;
    const capture = (current: string, chunk: Buffer, currentBytes: number, limit: number) => {
      const textChunk = chunk.toString("utf8");
      const remaining = Math.max(0, limit - currentBytes);
      return { value: current + textChunk.slice(0, remaining), bytes: currentBytes + chunk.byteLength, overflowed: chunk.byteLength > remaining };
    };
    const terminate = () => {
      if (!child.pid || treeTermination) return treeTermination;
      treeTermination = terminateTree(child);
      return treeTermination;
    };
    const abortHandler = () => { cancelled = true; void terminate(); };
    options.signal?.addEventListener("abort", abortHandler, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      const captured = capture(stdout, chunk, stdoutBytes, stdoutLimit);
      stdout = captured.value;
      stdoutBytes = captured.bytes;
      if (captured.overflowed && !overflow) {
        overflow = true;
        void terminate();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const captured = capture(stderr, chunk, stderrBytes, MAX_PROCESS_LOG_BYTES);
      stderr = captured.value;
      stderrBytes = captured.bytes;
      try { options.onStderr?.(chunk.toString("utf8")); } catch { }
      if (captured.overflowed && !overflow) {
        overflow = true;
        void terminate();
      }
    });
    child.once("error", (error) => {
      options.signal?.removeEventListener("abort", abortHandler);
      rejectResult(error);
    });
    child.once("close", async (code) => {
      options.signal?.removeEventListener("abort", abortHandler);
      if (treeTermination) await treeTermination;
      if (options.signal?.aborted || cancelled) rejectResult(abortError());
      else if (overflow) rejectResult(new Error("The media tool exceeded the output limit."));
      else resolveResult({ stdout, stderr, code: code ?? -1 });
    });
    if (options.signal?.aborted) void terminate();
  });
}

async function terminateTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((done) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
      killer.once("error", () => done());
      killer.once("close", () => done());
      setTimeout(() => done(), 3_000).unref();
    });
    return;
  }
  let hasProcessGroup = true;
  try { process.kill(-child.pid, "SIGTERM"); } catch {
    hasProcessGroup = false;
    try { child.kill("SIGTERM"); } catch { }
  }
  await new Promise((done) => setTimeout(done, 300));
  if (hasProcessGroup) try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { } }
  else try { child.kill("SIGKILL"); } catch { }
}

function assertSuccess(result: ProcessResult, tool: string, executable: string): void {
  if (result.code === 0) return;
  if (tool === "yt-dlp" && /No module named ['"]?yt_dlp|No module named yt_dlp/iu.test(result.stderr)) {
    throw new Error(`yt-dlp is not installed for Python at ${executable}. Install it in the configured Python environment with "${executable} -m pip install yt-dlp".`);
  }
  if ((result.stderr + result.stdout).includes("ENOENT") || /spawn .* ENOENT/u.test(result.stderr)) {
    throw new Error(`${tool} is unavailable at ${executable}. Install or configure the required media tool.`);
  }
  const detail = (result.stderr || result.stdout).trim().slice(-2_000);
  throw new Error(`${tool} failed${detail ? `: ${detail}` : ` with exit code ${result.code}`}`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("Media import was cancelled.");
  error.name = "AbortError";
  return error;
}

function reportProgress(callback: Progress | undefined, progress: number, detail: string): void {
  try { callback?.(Math.max(0, Math.min(100, progress)), detail); } catch { }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`The video platform did not provide ${label}.`);
  return value.trim();
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function assertWithin(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("The media output path escapes the managed directory.");
  }
}

async function assertDestinationAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error("The managed audio output already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\") || isAbsolute(value);
}
