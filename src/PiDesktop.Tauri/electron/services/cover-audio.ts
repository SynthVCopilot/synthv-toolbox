import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface CoverAudioOptions { dataRoot: string; componentsRoot: string; python?: string; }
export interface CoverAudioProgress { phase: "separating" | "transcribing-and-extracting"; percent: number; }
export interface CoverAudioResult {
  vocalPath: string; instrumentalPath: string; model: string; device: string; separationId: string;
}
export interface CoverExtractResult {
  midiPath: string; lyricsPath: string; segmentsPath: string; analysisPath: string;
  notesPath: string; notesSha256: string; rawNotesPath: string;
  analysis: Record<string, unknown>; noteCount: number; rawNoteCount: number;
  durationSeconds: number; language: string; inference: Record<string, unknown>;
  transformations: Record<string, unknown>; timingBasis: "seconds";
}
interface RunOptions { signal?: AbortSignal; onProgress?: (progress: CoverAudioProgress) => void; }
interface SeparationJson { separationId: string; vocalPath: string; instrumentalPath: string; model: string; device: string; }
interface ExtractionJson {
  midiPath: string; lyricsPath: string; segmentsPath: string; analysisPath: string;
  notesPath: string; notesSha256: string; rawNotesPath: string; noteCount: number;
  rawNoteCount: number; durationSeconds: number; language: string;
  inference: Record<string, unknown>; transformations: Record<string, unknown>; timingBasis: "seconds";
}

export function createCoverAudio(options: CoverAudioOptions) {
  if (!isAbsolute(options.dataRoot)) throw new Error("dataRoot must be an absolute path.");
  if (!isAbsolute(options.componentsRoot)) throw new Error("componentsRoot must be an absolute path.");
  const dataRoot = resolve(options.dataRoot);
  const componentsRoot = resolve(options.componentsRoot);
  const python = options.python ?? process.env.SYNTHV_TOOLBOX_PYTHON ?? (process.platform === "win32" ? "python.exe" : process.platform === "darwin" ? "python3.11" : "python3");
  const separationScript = join(componentsRoot, "vocal-separation", "separate.py");
  const audioScript = join(componentsRoot, "pi-audio", "pi_audio.py");
  const runtimeEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    SYNTHV_TOOLBOX_DATA_ROOT: dataRoot,
    TORCH_HOME: join(dataRoot, "models", "torch"),
    HF_HOME: join(dataRoot, "models", "huggingface"),
    HF_HUB_CACHE: join(dataRoot, "models", "huggingface", "hub"),
  });

  const separate = async (audioPath: string, runOptions: RunOptions = {}): Promise<CoverAudioResult> => {
    await validateInput(audioPath);
    const separationId = randomUUID();
    runOptions.onProgress?.({ phase: "separating", percent: 0 });
    try {
      const result = await runJson<SeparationJson>(
        python, [separationScript, audioPath, "--output-id", separationId], runtimeEnv(), runOptions.signal,
        () => cleanupRun(dataRoot, "separations", separationId),
      );
      await Promise.all([validateOwnedFile(dataRoot, result.vocalPath), validateOwnedFile(dataRoot, result.instrumentalPath)]);
      if (!result.model || !result.device || result.separationId !== separationId) throw new Error("Separation result metadata is incomplete.");
      runOptions.onProgress?.({ phase: "separating", percent: 100 });
      return { separationId, vocalPath: result.vocalPath, instrumentalPath: result.instrumentalPath, model: result.model, device: result.device };
    } catch (error) {
      await cleanupRun(dataRoot, "separations", separationId);
      throw error;
    }
  };

  const transcribeAndExtract = async (vocalPath: string, runOptions: RunOptions & { lyrics?: string } = {}): Promise<CoverExtractResult> => {
    await validateInput(vocalPath);
    const runId = randomUUID();
    const lyricsFile = runOptions.lyrics === undefined ? undefined : join(dataRoot, "tmp", "cover-lyrics-" + runId + ".txt");
    runOptions.onProgress?.({ phase: "transcribing-and-extracting", percent: 0 });
    try {
      const args = [audioScript, "transcribe-extract", vocalPath, "--run-id", runId];
      if (lyricsFile) {
        await mkdir(dirname(lyricsFile), { recursive: true });
        await writeFile(lyricsFile, runOptions.lyrics!, { flag: "wx", mode: 0o600 });
        args.push("--lyrics-file", lyricsFile);
      }
      const result = await runJson<ExtractionJson>(
        python, args, runtimeEnv(), runOptions.signal, () => cleanupRun(dataRoot, "cover-audio", runId),
      );
      const outputs = [result.midiPath, result.lyricsPath, result.segmentsPath, result.analysisPath, result.notesPath, result.rawNotesPath];
      await Promise.all(outputs.map(path => validateOwnedFile(dataRoot, path)));
      const bytes = await readFile(result.notesPath);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== result.notesSha256) throw new Error("The extracted notes checksum did not match the generated JSON.");
      if (!Number.isInteger(result.noteCount) || result.noteCount < 0 || !Number.isInteger(result.rawNoteCount) || result.rawNoteCount < result.noteCount) {
        throw new Error("The extracted note counts are invalid.");
      }
      const analysis = JSON.parse(await readFile(result.analysisPath, "utf8")) as Record<string, unknown>;
      runOptions.onProgress?.({ phase: "transcribing-and-extracting", percent: 100 });
      return { ...result, notesSha256: sha256, analysis };
    } catch (error) {
      await cleanupRun(dataRoot, "cover-audio", runId);
      throw error;
    } finally {
      if (lyricsFile) await rm(lyricsFile, { force: true });
    }
  };
  return { separate, transcribeAndExtract };
}

async function validateInput(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("Audio input paths must be absolute.");
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Audio input must be a regular non-symlink file.");
  if (![".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus"].includes(extname(path).toLowerCase())) {
    throw new Error("Audio input format is not supported.");
  }
}

async function validateOwnedFile(root: string, path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("Component returned a non-absolute output path.");
  const [rootReal, fileReal, info] = await Promise.all([realpath(root), realpath(path), stat(path)]);
  const rel = relative(rootReal, fileReal);
  if (!rel || rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel)) throw new Error("Component output escaped dataRoot.");
  if (!info.isFile() || info.size === 0) throw new Error("Component output is missing or empty.");
}

async function cleanupRun(root: string, category: "separations" | "cover-audio", id: string): Promise<void> {
  const output = category === "separations" ? join(root, "output", "separations", id) : join(root, "output", "cover-audio", id);
  await rm(output, { recursive: true, force: true });
  if (category === "cover-audio") await rm(join(root, "output", "cover-audio", "." + id + ".tmp"), { recursive: true, force: true });
}

async function runJson<T>(file: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal | undefined, cleanup: () => Promise<void>): Promise<T> {
  if (signal?.aborted) throw abortError();
  await mkdir(env.SYNTHV_TOOLBOX_DATA_ROOT!, { recursive: true });
  return new Promise<T>((resolveResult, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let failure: Error | undefined;
    const terminate = () => {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.unref();
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch {}
        const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 1500);
        timer.unref();
      }
    };
    const abort = () => { terminate(); };
    const rejectAfterCleanup = (error: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      void cleanup().finally(() => reject(error));
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8").on("data", chunk => {
      if (failure) return;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 2 * 1024 * 1024) {
        failure = new Error("Python component exceeded the 2 MiB JSON output limit.");
        terminate();
        return;
      }
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-16_000); });
    child.once("error", error => rejectAfterCleanup(error));
    child.once("close", code => {
      if (settled) return;
      if (failure) return rejectAfterCleanup(failure);
      if (signal?.aborted) return rejectAfterCleanup(abortError());
      if (code !== 0) {
        let detail = stderr.trim() || "Python component exited with " + code + ".";
        try { const parsed = JSON.parse(stdout) as { error?: string }; if (parsed.error) detail = parsed.error; } catch {}
        return rejectAfterCleanup(new Error(detail));
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      try {
        const parsed = JSON.parse(stdout) as T & { error?: string };
        if (parsed.error) throw new Error(parsed.error);
        resolveResult(parsed);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Component returned invalid JSON."));
      }
    });
    if (signal?.aborted) abort();
  });
}

function abortError(): Error { const error = new Error("Audio processing was cancelled."); error.name = "AbortError"; return error; }
