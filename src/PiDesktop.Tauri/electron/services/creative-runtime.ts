import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

type ProcessOutput = "stdout" | "stderr";
type Progress = (progress: number, detail: string) => void;
type EnsureOptions = { signal?: AbortSignal; onProgress?: Progress };
type ProcessResult = { stdout: string; stderr: string; code: number };
export type CreativeRuntimeProcessOptions = {
  signal?: AbortSignal;
  cwd?: string;
  timeoutMs?: number;
  onOutput?: (stream: ProcessOutput, chunk: string) => void;
};
export type CreativeRuntimeProcessRunner = (file: string, args: string[], options: CreativeRuntimeProcessOptions) => Promise<ProcessResult>;

export interface CreativeRuntimeOptions {
  dataRoot: string;
  componentsRoot: string;
  pythonCommand?: string;
}

export interface CreativeRuntimeStatus {
  ready: boolean;
  pythonPath?: string;
  missing: string[];
  detail: string;
}

export interface CreativeRuntime {
  status(): Promise<CreativeRuntimeStatus>;
  ensure(options?: EnsureOptions): Promise<string>;
}

type Requirements = { hash: string; files: string[]; missing: string[] };
type PythonInfo = { executable: string; version: string; prefix: string; basePrefix: string };
type ImportCheck = { missing: Record<string, string> };
type RuntimeManifest = {
  schemaVersion: 1;
  managed: true;
  requirementsHash: string;
  runtimeDirectory: string;
  pythonRelativePath: string;
  pythonVersion: string;
  modules: string[];
  installedAtUtc: string;
};

const YT_DLP = "yt-dlp==2026.8.19";
const MLX_WHISPER = "mlx-whisper==0.4.3";
const PI_AUDIO_REQUIREMENTS = join("pi-audio", "requirements.txt");
const SEPARATION_REQUIREMENTS = join("vocal-separation", "requirements.txt");
const PROBE_PYTHON = "import json,sys; print(json.dumps({'executable':sys.executable,'version':'.'.join(map(str,sys.version_info[:3])),'major':sys.version_info[0],'minor':sys.version_info[1],'prefix':sys.prefix,'basePrefix':sys.base_prefix}))";
const CHECK_MODULES = "import importlib,json,sys\nmissing={}\nfor name in sys.argv[1:]:\n try: importlib.import_module(name)\n except Exception as error: missing[name]=f'{type(error).__name__}: {error}'\nprint(json.dumps({'missing':missing}))\nsys.exit(2 if missing else 0)";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 128 * 1024;

export function createCreativeRuntime(options: CreativeRuntimeOptions, runner: CreativeRuntimeProcessRunner = runProcess): CreativeRuntime {
  const dataRoot = resolve(options.dataRoot);
  const componentsRoot = resolve(options.componentsRoot);
  const explicitPython = options.pythonCommand?.trim() || process.env.SYNTHV_TOOLBOX_PYTHON?.trim() || undefined;
  let ensureQueue: Promise<unknown> = Promise.resolve();

  const loadRequirements = async (): Promise<Requirements> => {
    const missing: string[] = [];
    const files: string[] = [];
    let canonicalComponents: string;
    try {
      canonicalComponents = await realpath(componentsRoot);
    } catch {
      return { hash: "", files: [], missing: ["components directory"] };
    }
    const hash = createHash("sha256").update("creative-runtime-v1\0").update(`${process.platform}\0${process.arch}\0`);
    for (const name of [PI_AUDIO_REQUIREMENTS, SEPARATION_REQUIREMENTS]) {
      const path = join(canonicalComponents, name);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Requirements file must be a regular file.");
        const canonicalPath = await realpath(path);
        assertWithin(canonicalComponents, canonicalPath);
        const contents = await readFile(canonicalPath);
        hash.update(name).update("\0").update(contents).update("\0");
        files.push(canonicalPath);
      } catch {
        missing.push(name);
      }
    }
    for (const packageSpec of [YT_DLP, ...(isMlxPlatform() ? [MLX_WHISPER] : [])]) hash.update(packageSpec).update("\0");
    return { hash: missing.length ? "" : hash.digest("hex"), files, missing };
  };

  const status = async (): Promise<CreativeRuntimeStatus> => statusInternal();

  const statusInternal = async (signal?: AbortSignal): Promise<CreativeRuntimeStatus> => {
    const requirements = await loadRequirements();
    if (requirements.missing.length) return notReady(requirements.missing, "Creative component requirements are missing or unsafe.");
    if (explicitPython) return inspectExternalPython(explicitPython, signal);
    const directories = await existingRuntimeDirectories(dataRoot);
    if (directories.error) return notReady(["managed Python runtime"], directories.error);
    if (!directories.runtimeRoot || !directories.versionsRoot) {
      const base = await findBasePython(runner, signal);
      return base
        ? notReady(["managed Python runtime"], "The managed creative runtime has not been prepared.")
        : notReady(["Python 3.11"], "Python 3.11 is required to prepare the local creative runtime.");
    }
    const activePath = join(directories.runtimeRoot, "active.json");
    let manifest: RuntimeManifest;
    try {
      const info = await lstat(activePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) return notReady(["managed runtime manifest"], "The active runtime manifest is unsafe or too large.");
      manifest = JSON.parse(await readFile(activePath, "utf8")) as RuntimeManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return notReady(["managed runtime manifest"], errorMessage(error));
      const base = await findBasePython(runner, signal);
      return base
        ? notReady(["managed Python runtime"], "The managed creative runtime has not been prepared.")
        : notReady(["Python 3.11"], "Python 3.11 is required to prepare the local creative runtime.");
    }
    if (manifest?.schemaVersion !== 1 || manifest.managed !== true || typeof manifest.runtimeDirectory !== "string" || typeof manifest.pythonRelativePath !== "string") {
      return notReady(["managed runtime manifest"], "The active runtime manifest is invalid.");
    }
    if (manifest.requirementsHash !== requirements.hash) return notReady(["runtime requirements changed"], "Creative runtime requirements changed and need to be installed.");
    if (!/^[a-f0-9]{64}-[a-f0-9-]{36}$/u.test(manifest.runtimeDirectory)) return notReady(["managed runtime path"], "The active runtime path is invalid.");
    const versionDirectory = join(directories.versionsRoot, manifest.runtimeDirectory);
    try {
      const versionInfo = await lstat(versionDirectory);
      if (!versionInfo.isDirectory() || versionInfo.isSymbolicLink()) return notReady(["managed runtime path"], "The active runtime directory is unsafe.");
      assertWithin(directories.versionsRoot, await realpath(versionDirectory));
      const localManifestPath = join(versionDirectory, "runtime.json");
      const localManifestInfo = await lstat(localManifestPath);
      if (!localManifestInfo.isFile() || localManifestInfo.isSymbolicLink() || localManifestInfo.size > MAX_MANIFEST_BYTES) return notReady(["runtime manifest"], "The prepared runtime manifest is unsafe.");
      const localManifest = JSON.parse(await readFile(localManifestPath, "utf8")) as RuntimeManifest;
      if (localManifest.requirementsHash !== requirements.hash || localManifest.runtimeDirectory !== manifest.runtimeDirectory) return notReady(["runtime manifest"], "The prepared runtime manifest does not match the active runtime.");
    } catch (error) {
      return notReady(["managed runtime files"], errorMessage(error));
    }
    const pythonPath = resolve(versionDirectory, manifest.pythonRelativePath);
    if (!isInside(versionDirectory, pythonPath)) return notReady(["managed Python path"], "The active Python path escapes its runtime directory.");
    const info = await probePython(runner, pythonPath, signal);
    if (!info || info.majorMinor !== "3.11") return notReady(["Python 3.11"], "The managed Python interpreter is missing or is not Python 3.11.");
    const canonicalVersion = await realpath(versionDirectory);
    if (resolve(info.prefix) !== resolve(versionDirectory) && resolve(await realpath(info.prefix)) !== canonicalVersion) {
      return notReady(["isolated Python environment"], "The managed interpreter is not running inside its published virtual environment.");
    }
    const imports = await checkImports(runner, pythonPath, runtimeModules(), signal);
    if (!imports || Object.keys(imports.missing).length) {
      const missing = imports ? Object.keys(imports.missing) : runtimeModules();
      const detail = imports ? Object.entries(imports.missing).map(([name, reason]) => `${name}: ${reason}`).join("; ") : "Python module import verification did not return a result.";
      return notReady(missing, `Creative runtime modules failed to import: ${detail}`, pythonPath);
    }
    return { ready: true, pythonPath, missing: [], detail: "The managed creative runtime is ready." };
  };

  const ensureInternal = async (request: EnsureOptions): Promise<string> => {
    throwIfAborted(request.signal);
    const requirements = await loadRequirements();
    if (requirements.missing.length) throw new Error(`Creative component requirements are missing or unsafe: ${requirements.missing.join(", ")}.`);
    if (explicitPython) {
      const external = await inspectExternalPython(explicitPython, request.signal);
      if (!external.ready || !external.pythonPath) throw new Error(external.detail);
      return external.pythonPath;
    }
    const current = await statusInternal(request.signal);
    if (current.ready && current.pythonPath) return current.pythonPath;
    throwIfAborted(request.signal);
    const base = await findBasePython(runner, request.signal);
    if (!base) throw new Error("Python 3.11 was not found. Install Python 3.11, then start the creative runtime again.");
    const directories = await ensureRuntimeDirectories(dataRoot);
    const id = randomUUID();
    const versionName = `${requirements.hash}-${id}`;
    const staging = join(directories.versionsRoot, versionName);
    let ownsStaging = false;

    try {
      // Virtual environments embed their path, so publish the manifest pointer without moving the staged directory.
      await mkdir(staging, { mode: 0o700 });
      ownsStaging = true;
      progress(request.onProgress, 4, "Creating an isolated Python 3.11 environment");
      const venvProgress = { current: 4, end: 12 };
      const result = await runner(base.pythonPath, ["-m", "venv", staging], {
        signal: request.signal,
        timeoutMs: 120_000,
        cwd: staging,
        onOutput: (stream, chunk) => pipProgress(request.onProgress, stream, chunk, venvProgress),
      });
      assertCommand(result, "Python virtual environment creation");
      const pythonRelativePath = venvPythonRelativePath();
      const stagedPython = join(staging, pythonRelativePath);
      await assertFileExists(stagedPython, "The Python 3.11 virtual environment was not created correctly.");

      progress(request.onProgress, 14, "Installing creative component dependencies from PyPI");
      const installProgress = { current: 14, end: 86 };
      const installArgs = [
        "-m", "pip", "--isolated", "install", "--index-url", "https://pypi.org/simple", "--disable-pip-version-check", "--no-input", "--no-cache-dir",
        "--progress-bar", "off", "-r", requirements.files[0], "-r", requirements.files[1], YT_DLP,
        ...(isMlxPlatform() ? [MLX_WHISPER] : []),
      ];
      const install = await runner(stagedPython, installArgs, {
        signal: request.signal,
        timeoutMs: 45 * 60_000,
        cwd: staging,
        onOutput: (stream, chunk) => pipProgress(request.onProgress, stream, chunk, installProgress),
      });
      assertCommand(install, "Creative runtime dependency installation");
      throwIfAborted(request.signal);

      progress(request.onProgress, 90, "Verifying installed Python modules");
      const pythonInfo = await probePython(runner, stagedPython, request.signal);
      if (!pythonInfo || pythonInfo.majorMinor !== "3.11") throw new Error("The prepared environment is not running Python 3.11.");
      const imports = await checkImports(runner, stagedPython, runtimeModules(), request.signal);
      if (!imports || Object.keys(imports.missing).length) {
        const missing = imports ? Object.entries(imports.missing).map(([name, detail]) => `${name} (${detail})`) : runtimeModules();
        throw new Error(`Creative runtime verification failed: ${missing.join(", ")}.`);
      }
      throwIfAborted(request.signal);

      const installedAtUtc = new Date().toISOString();
      const manifest: RuntimeManifest = {
        schemaVersion: 1,
        managed: true,
        requirementsHash: requirements.hash,
        runtimeDirectory: versionName,
        pythonRelativePath,
        pythonVersion: pythonInfo.version,
        modules: runtimeModules(),
        installedAtUtc,
      };
      await writeJsonExclusive(join(staging, "runtime.json"), manifest);
      await assertNoSymlink(directories.versionsRoot, "Runtime versions directory");
      throwIfAborted(request.signal);
      progress(request.onProgress, 97, "Publishing the verified Python runtime");
      const activeManifest = join(directories.runtimeRoot, "active.json");
      await writeJsonAtomic(activeManifest, manifest);
      ownsStaging = false;
      progress(request.onProgress, 100, "Creative runtime is ready");
      return join(staging, pythonRelativePath);
    } finally {
      if (ownsStaging) await rm(staging, { recursive: true, force: true });
    }
  };

  const ensure = (request: EnsureOptions = {}): Promise<string> => {
    const task = ensureQueue.then(() => ensureInternal(request), () => ensureInternal(request));
    ensureQueue = task.then(() => undefined, () => undefined);
    return task;
  };

  return { status, ensure };

  async function inspectExternalPython(pythonCommand: string, signal?: AbortSignal): Promise<CreativeRuntimeStatus> {
    const info = await probePython(runner, pythonCommand, signal);
    if (!info) return notReady(["configured Python executable"], `The configured Python executable could not run: ${pythonCommand}.`, pythonCommand);
    if (info.majorMinor !== "3.11") return notReady(["Python 3.11"], `The configured Python is ${info.version}; Python 3.11 is required.`, info.executable);
    const imports = await checkImports(runner, info.executable, runtimeModules(), signal);
    if (!imports || Object.keys(imports.missing).length) {
      const missing = imports ? Object.keys(imports.missing) : runtimeModules();
      const detail = imports ? Object.entries(imports.missing).map(([name, reason]) => `${name}: ${reason}`).join("; ") : "Python module import verification did not return a result.";
      return notReady(missing, `The configured Python environment failed module checks: ${detail}`, info.executable);
    }
    return { ready: true, pythonPath: info.executable, missing: [], detail: "The configured Python 3.11 environment is ready." };
  }
}

async function probePython(runner: CreativeRuntimeProcessRunner, pythonPath: string, signal?: AbortSignal): Promise<(PythonInfo & { majorMinor: string }) | undefined> {
  let result: ProcessResult;
  try {
    result = await runner(pythonPath, ["-c", PROBE_PYTHON], { signal, timeoutMs: 15_000 });
  } catch (error) {
    if (isAbort(error)) throw error;
    return undefined;
  }
  if (result.code !== 0) return undefined;
  try {
    const info = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    if (typeof info.executable !== "string" || typeof info.version !== "string" || typeof info.prefix !== "string" || typeof info.basePrefix !== "string" || info.major !== 3 || info.minor !== 11) return undefined;
    return { executable: info.executable, version: info.version, prefix: info.prefix, basePrefix: info.basePrefix, majorMinor: "3.11" };
  } catch {
    return undefined;
  }
}

async function checkImports(runner: CreativeRuntimeProcessRunner, pythonPath: string, modules: string[], signal?: AbortSignal): Promise<ImportCheck | undefined> {
  let result: ProcessResult;
  try {
    result = await runner(pythonPath, ["-c", CHECK_MODULES, ...modules], { signal, timeoutMs: 180_000 });
  } catch (error) {
    if (isAbort(error)) throw error;
    return undefined;
  }
  try {
    const report = JSON.parse(result.stdout.trim()) as ImportCheck;
    return report && report.missing && typeof report.missing === "object" ? report : undefined;
  } catch {
    return undefined;
  }
}

async function findBasePython(runner: CreativeRuntimeProcessRunner, signal?: AbortSignal): Promise<{ pythonPath: string; version: string } | undefined> {
  const candidates = basePythonCandidates();
  for (const pythonPath of candidates) {
    throwIfAborted(signal);
    const info = await probePython(runner, pythonPath, signal);
    if (info) return { pythonPath, version: info.version };
  }
  return undefined;
}

function basePythonCandidates(): string[] {
  if (process.platform === "darwin") return ["/opt/homebrew/bin/python3.11", "/usr/local/bin/python3.11", "python3.11"];
  if (process.platform === "win32") return ["python.exe"];
  return ["python3.11"];
}

function runtimeModules(): string[] {
  return [
    "yt_dlp",
    "demucs",
    "torch",
    "basic_pitch",
    "mido",
    "librosa",
    "cmudict",
    "pypinyin",
    ...(isMlxPlatform() ? ["mlx_whisper"] : ["faster_whisper"]),
  ];
}

function isMlxPlatform(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

async function ensureRuntimeDirectories(dataRoot: string): Promise<{ runtimeRoot: string; versionsRoot: string }> {
  await mkdir(dataRoot, { recursive: true });
  const canonicalRoot = await realpath(dataRoot);
  const runtimeRoot = join(canonicalRoot, "python-runtime");
  await ensureDirectory(runtimeRoot, canonicalRoot, "Managed Python runtime directory");
  const versionsRoot = join(runtimeRoot, "versions");
  await ensureDirectory(versionsRoot, runtimeRoot, "Managed runtime versions directory");
  return { runtimeRoot, versionsRoot };
}

async function existingRuntimeDirectories(dataRoot: string): Promise<{ runtimeRoot?: string; versionsRoot?: string; error?: string }> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(dataRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { error: errorMessage(error) };
  }
  const runtimeRoot = join(canonicalRoot, "python-runtime");
  try {
    const info = await lstat(runtimeRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) return { error: "The managed Python runtime directory must not be a symbolic link." };
    assertWithin(canonicalRoot, await realpath(runtimeRoot));
    const versionsRoot = join(runtimeRoot, "versions");
    try {
      const versionsInfo = await lstat(versionsRoot);
      if (!versionsInfo.isDirectory() || versionsInfo.isSymbolicLink()) return { error: "The runtime versions directory must not be a symbolic link." };
      assertWithin(runtimeRoot, await realpath(versionsRoot));
      return { runtimeRoot, versionsRoot };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { runtimeRoot };
      return { error: errorMessage(error) };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { error: errorMessage(error) };
  }
}

async function ensureDirectory(path: string, root: string, label: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory, not a symbolic link.`);
  assertWithin(root, await realpath(path));
}

async function assertFileExists(path: string, message: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(message);
  } catch {
    throw new Error(message);
  }
}

async function assertNoSymlink(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
}

async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("The active runtime manifest must not be a symbolic link.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeJsonExclusive(temporary, value);
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function runProcess(file: string, args: string[], options: CreativeRuntimeProcessOptions): Promise<ProcessResult> {
  throwIfAborted(options.signal);
  return new Promise((resolveResult, rejectResult) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd: options.cwd ?? process.cwd(), env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, detached: process.platform !== "win32", windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      rejectResult(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let aborted = false;
    let timedOut = false;
    let termination: Promise<void> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const append = (current: string, chunk: Buffer) => (current + chunk.toString("utf8")).slice(-MAX_LOG_BYTES);
    const terminate = () => {
      if (termination) return termination;
      termination = terminateTree(child);
      return termination;
    };
    const onAbort = () => { aborted = true; void terminate(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs && options.timeoutMs > 0) timeout = setTimeout(() => { timedOut = true; void terminate(); }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
      try { options.onOutput?.("stdout", chunk.toString("utf8")); } catch { }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
      try { options.onOutput?.("stderr", chunk.toString("utf8")); } catch { }
    });
    child.once("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (timeout) clearTimeout(timeout);
      rejectResult(error);
    });
    child.once("close", async (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (timeout) clearTimeout(timeout);
      if (termination) await termination;
      if (aborted || options.signal?.aborted) rejectResult(abortError());
      else if (timedOut) rejectResult(new Error(`${file} exceeded its ${options.timeoutMs} ms time limit.`));
      else resolveResult({ stdout, stderr, code: code ?? -1 });
    });
    if (options.signal?.aborted) onAbort();
  });
}

async function terminateTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((done) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; done(); } };
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
      killer.once("error", () => { try { child.kill("SIGKILL"); } catch { } finish(); });
      killer.once("close", finish);
      setTimeout(finish, 5_000).unref();
    });
    return;
  }
  let group = true;
  try { process.kill(-child.pid, "SIGTERM"); } catch { group = false; try { child.kill("SIGTERM"); } catch { } }
  await new Promise((done) => setTimeout(done, 300));
  if (group) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { } }
  } else try { child.kill("SIGKILL"); } catch { }
}

function venvPythonRelativePath(): string {
  return process.platform === "win32" ? join("Scripts", "python.exe") : join("bin", "python");
}

function assertCommand(result: ProcessResult, operation: string): void {
  if (result.code === 0) return;
  const detail = (result.stderr || result.stdout).trim().slice(-2_000);
  throw new Error(`${operation} failed${detail ? `: ${detail}` : ` with exit code ${result.code}`}`);
}

function pipProgress(callback: Progress | undefined, stream: ProcessOutput, chunk: string, range: { current: number; end: number }): void {
  if (!callback || stream !== "stderr") return;
  const messages = chunk.split(/\r?\n/u).filter((line) => line.trim());
  for (const message of messages) {
    if (/collecting|downloading|installing|preparing metadata|building wheel/iu.test(message)) {
      range.current = Math.min(range.end - 1, range.current + 0.6);
      progress(callback, range.current, message.trim().slice(0, 160));
    }
  }
}

function progress(callback: Progress | undefined, value: number, detail: string): void {
  try { callback?.(Math.min(100, Math.max(0, value)), detail); } catch { }
}

function notReady(missing: string[], detail: string, pythonPath?: string): CreativeRuntimeStatus {
  return { ready: false, ...(pythonPath ? { pythonPath } : {}), missing: [...new Set(missing)], detail };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertWithin(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error("The runtime path escapes its managed directory.");
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortError();
}

function abortError(): Error {
  const error = new Error("Creative runtime preparation was cancelled.");
  error.name = "AbortError";
  return error;
}
