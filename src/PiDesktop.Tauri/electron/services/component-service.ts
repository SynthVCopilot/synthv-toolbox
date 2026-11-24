import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, copyFile, cp, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export type ComponentId = "ffmpeg" | "pi-audio" | "cvrs" | "media-fetcher" | "vocal-separation";
export type ComponentTaskStatus = "queued" | "downloading" | "installing" | "completed" | "failed" | "cancelled" | "interrupted";
export type ComponentTask = { id: string; componentId: ComponentId; displayName: string; status: ComponentTaskStatus; progress: number; detail: string; downloadedBytes: number; totalBytes: number | null; createdAt: string; updatedAt: string; error?: string };
type Data = Record<string, unknown>;
type Process = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
type Fetcher = (url: string) => Promise<Response>;

const MAX_DOWNLOAD = 256 * 1024 * 1024;
const MANAGED_BY = "Synthesizer V Toolbox";
const MEDIA_FETCHER = process.platform === "win32"
  ? { asset: "yt-dlp.exe", url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe", sha256: "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a" }
  : process.platform === "darwin"
    ? { asset: "yt-dlp_macos", url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_macos", sha256: "0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202" }
    : undefined;
const DETAILS: Record<ComponentId, { displayName: string; description: string; audience: string; script?: string; requirements?: boolean }> = {
  ffmpeg: { displayName: "FFmpeg", description: "Audio and video conversion runtime.", audience: "AI and manual workflows" },
  "pi-audio": { displayName: "pi-audio", description: "Audio feature and score analysis component.", audience: "AI and manual workflows", script: "pi_audio.py", requirements: true },
  cvrs: { displayName: "CVRS", description: "SynthV project inspection and export component.", audience: "AI and manual workflows", script: "cvrs.py" },
  "media-fetcher": { displayName: "Media fetcher", description: "Pinned yt-dlp media importer.", audience: "AI and manual workflows" },
  "vocal-separation": { displayName: "Vocal separation", description: "Local vocal and accompaniment separation component.", audience: "AI and manual workflows", script: "separate.py", requirements: true },
};

export class ComponentService {
  private readonly root: string;
  private readonly componentRoot: string;
  private readonly taskPath: string;
  private tasks: ComponentTask[] = [];
  private running = false;
  private readonly cancelled = new Set<string>();
  constructor(private readonly dataRoot: string, private readonly bundledRoot: string, private readonly run: Process = runProcess, private readonly fetcher: Fetcher = fetch) {
    this.root = resolve(dataRoot); this.componentRoot = join(this.root, "components"); this.taskPath = join(this.root, "tasks", "component-downloads.json");
  }

  async load(): Promise<void> {
    try { const saved = JSON.parse(await readFile(this.taskPath, "utf8")); this.tasks = Array.isArray(saved.items) ? saved.items.filter(validTask) : []; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Unable to restore component tasks: ${message(error)}`); }
    let changed = false;
    for (const task of this.tasks) if (["queued", "downloading", "installing"].includes(task.status)) { task.status = "interrupted"; task.detail = "The application exited before this task finished; retry is safe."; task.updatedAt = now(); changed = true; }
    if (changed) await this.persist();
  }

  async catalog(): Promise<Data[]> { return Promise.all((Object.keys(DETAILS) as ComponentId[]).map(async id => this.status(id))); }
  async listTasks(): Promise<ComponentTask[]> { return this.tasks.map(task => ({ ...task })); }
  interpreter(id: ComponentId): string | undefined { const detail = DETAILS[id]; if (!detail.script) return undefined; return join(this.componentRoot, id, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python3"); }
  script(id: ComponentId): string | undefined { const detail = DETAILS[id]; return detail.script ? join(this.componentRoot, id, detail.script) : undefined; }

  async queue(id: ComponentId): Promise<ComponentTask[]> {
    requireId(id); const active = this.tasks.find(task => task.componentId === id && ["queued", "downloading", "installing"].includes(task.status)); if (active) return this.listTasks();
    const task: ComponentTask = { id: randomUUID(), componentId: id, displayName: DETAILS[id].displayName, status: "queued", progress: 0, detail: "Waiting for component worker.", downloadedBytes: 0, totalBytes: null, createdAt: now(), updatedAt: now() };
    this.tasks = [task, ...this.tasks].slice(0, 24); await this.persist(); void this.work(); return this.listTasks();
  }
  async cancel(id: string): Promise<ComponentTask[]> { const task = this.task(id); if (["queued", "downloading", "installing"].includes(task.status)) { this.cancelled.add(id); task.status = "cancelled"; task.detail = "Cancelled by user."; task.updatedAt = now(); await this.persist(); } return this.listTasks(); }
  async retry(id: string): Promise<ComponentTask[]> { const task = this.task(id); if (!["failed", "cancelled", "interrupted"].includes(task.status)) throw new Error("Only a failed, cancelled, or interrupted component task can be retried."); return this.queue(task.componentId); }
  async reveal(id: string): Promise<string> { const task = this.task(id); if (task.status !== "completed") throw new Error("No downloaded component is ready to reveal."); return this.componentPath(task.componentId); }
  async remove(id: ComponentId): Promise<Data> { requireId(id); const target = this.componentPath(id); await rejectLink(target); try { await rm(target, { recursive: true, force: false }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Unable to remove managed component: ${message(error)}`); } return { succeeded: true, summary: `${DETAILS[id].displayName} removed.`, detail: "Only the Toolbox-managed component directory was removed." }; }

  private async work(): Promise<void> { if (this.running) return; this.running = true; try { for (;;) { const task = this.tasks.find(item => item.status === "queued"); if (!task) return; await this.install(task); } } finally { this.running = false; } }
  private async install(task: ComponentTask): Promise<void> { try { await this.installOne(task); if (task.status !== "cancelled") this.update(task, "completed", 100, "Component installed and verified."); } catch (error) { if (task.status !== "cancelled") { task.error = message(error); this.update(task, "failed", task.progress, task.error); } } await this.persist(); }
  private async installOne(task: ComponentTask): Promise<void> {
    this.assertNotCancelled(task); const id = task.componentId;
    if (id === "ffmpeg") throw new Error("Automatic FFmpeg installation requires a pinned platform archive and is not available on this build. Configure a verified ffmpeg/ffprobe pair instead.");
    if (id === "media-fetcher") return this.installMediaFetcher(task);
    return this.installPython(id, task);
  }
  private async installPython(id: ComponentId, task: ComponentTask): Promise<void> {
    const detail = DETAILS[id]; const source = resolve(this.bundledRoot, id); const script = detail.script!;
    await Promise.all([requireRegular(join(source, script)), detail.requirements ? requireRegular(join(source, "requirements.txt")) : Promise.resolve()]);
    this.update(task, "installing", 15, "Checking a supported Python interpreter (3.9–3.11)."); const python = await this.findPython(); this.assertNotCancelled(task);
    const stage = join(this.componentRoot, `.${id}.stage-${randomUUID()}`); await mkdir(stage, { recursive: true });
    try {
      this.update(task, "installing", 35, "Copying bundled component payload."); await cp(source, stage, { recursive: true, filter: path => !path.includes("__pycache__") && !path.endsWith(".pyc") });
      this.assertNotCancelled(task); this.update(task, "installing", 55, "Creating a private virtual environment."); await this.run(python, ["-m", "venv", join(stage, "venv")]);
      const venv = join(stage, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python3"); await requireRegular(venv);
      if (detail.requirements) { this.update(task, "installing", 72, "Installing pinned component requirements."); await this.run(venv, ["-m", "pip", "install", "--disable-pip-version-check", "--requirement", join(stage, "requirements.txt")]); }
      this.update(task, "installing", 90, "Verifying component imports."); await this.run(venv, ["-c", "import sys; assert (3, 9) <= sys.version_info[:2] <= (3, 11)"]);
      await this.replace(id, stage); this.assertNotCancelled(task);
    } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
  }
  private async installMediaFetcher(task: ComponentTask): Promise<void> {
    if (!MEDIA_FETCHER) throw new Error("The pinned yt-dlp component supports macOS and Windows only.");
    const manifest = MEDIA_FETCHER; const cache = join(this.root, "downloads", "media-fetcher", "2026.08.19", manifest.asset); await mkdir(dirname(cache), { recursive: true });
    this.update(task, "downloading", 12, "Downloading pinned yt-dlp release."); const bytes = await this.download(manifest.url, cache, manifest.sha256, task); this.assertNotCancelled(task);
    const stage = join(this.componentRoot, `.media-fetcher.stage-${randomUUID()}`); await mkdir(stage, { recursive: true });
    try { const entrypoint = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"; await copyFile(cache, join(stage, entrypoint)); if (process.platform !== "win32") await chmod(join(stage, entrypoint), 0o755); await writeFile(join(stage, "manifest.json"), JSON.stringify({ schemaVersion: 1, managedBy: MANAGED_BY, id: "media-fetcher", version: "2026.08.19", asset: manifest.asset, source: manifest.url, sha256: manifest.sha256, entrypoint, downloadedBytes: bytes }, null, 2)); this.update(task, "installing", 88, "Installing verified media fetcher."); await this.replace("media-fetcher", stage); } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
  }
  private async download(url: string, target: string, expected: string, task: ComponentTask): Promise<number> {
    const parsed = new URL(url); if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") throw new Error("Component manifest URL is not an approved HTTPS GitHub release URL.");
    try { if ((await sha256(target)) === expected) return (await stat(target)).size; } catch {}
    const response = await this.fetcher(url); if (!response.ok || !response.body) throw new Error(`Pinned component download failed (${response.status}).`); const declared = Number(response.headers.get("content-length")); if (Number.isFinite(declared) && declared > MAX_DOWNLOAD) throw new Error("Pinned component exceeds the download size limit."); task.totalBytes = Number.isFinite(declared) ? declared : null; const temporary = `${target}.${randomUUID()}.part`; let total = 0; const chunks: Uint8Array[] = []; try { const reader = response.body.getReader(); for (;;) { this.assertNotCancelled(task); const item = await reader.read(); if (item.done) break; total += item.value.byteLength; if (total > MAX_DOWNLOAD) throw new Error("Pinned component exceeds the download size limit."); chunks.push(item.value); task.downloadedBytes = total; task.progress = Math.min(70, Math.max(12, task.totalBytes ? Math.round((total / task.totalBytes) * 70) : 30)); task.updatedAt = now(); await this.persist(); } await writeFile(temporary, Buffer.concat(chunks)); if ((await sha256(temporary)) !== expected) throw new Error("Downloaded component SHA-256 does not match its pinned manifest."); await rename(temporary, target); return total; } catch (error) { await rm(temporary, { force: true }); throw error; }
  }
  private async findPython(): Promise<string> { const candidates = [process.env.SYNTHV_TOOLBOX_PYTHON, process.platform === "win32" ? "py" : undefined, "/opt/homebrew/bin/python3.11", "/usr/local/bin/python3.11", "python3.11", "python3.10", "python3.9"].filter((item): item is string => Boolean(item)); for (const candidate of candidates) try { const args = candidate === "py" ? ["-3.11", "-c", "import sys; print(sys.executable); print(f'{sys.version_info[0]}.{sys.version_info[1]}')"] : ["-c", "import sys; print(sys.executable); print(f'{sys.version_info[0]}.{sys.version_info[1]}')"]; const out = await this.run(candidate, args); const [executable, version] = out.stdout.trim().split(/\r?\n/); if (/^3\.(9|10|11)$/.test(version ?? "") && executable) return await realpath(executable); } catch {} throw new Error("Python 3.9, 3.10, or 3.11 is required to install this component. Set SYNTHV_TOOLBOX_PYTHON to its absolute executable path."); }
  private async replace(id: ComponentId, stage: string): Promise<void> { await mkdir(this.componentRoot, { recursive: true }); const target = this.componentPath(id); await rejectLink(target); const backup = join(this.componentRoot, `.${id}.backup-${randomUUID()}`); let moved = false; try { try { await rename(target, backup); moved = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } await rename(stage, target); if (moved) await rm(backup, { recursive: true, force: true }); } catch (error) { if (moved) { try { await rename(backup, target); } catch {} } throw new Error(`Unable to commit managed component: ${message(error)}`); } }
  private async status(id: ComponentId): Promise<Data> { const detail = DETAILS[id]; const path = this.componentPath(id); const ready = id === "ffmpeg" ? false : id === "media-fetcher" ? await validMediaFetcher(path) : await validPython(path, detail.script!); const current = this.tasks.find(task => task.componentId === id); return { id, displayName: detail.displayName, description: detail.description, audience: detail.audience, installed: ready, downloaded: id === "media-fetcher" && await exists(join(this.root, "downloads", "media-fetcher", "2026.08.19", MEDIA_FETCHER?.asset ?? "none")), installable: id !== "ffmpeg" || process.platform === "win32", removable: ready, status: ready ? "Ready (Toolbox managed)." : current?.detail ?? (id === "ffmpeg" ? "Configure a verified ffmpeg/ffprobe pair." : "Install from the component center."), interpreter: this.interpreter(id), script: this.script(id) }; }
  private componentPath(id: ComponentId): string { return join(this.componentRoot, id); }
  private task(id: string): ComponentTask { const task = this.tasks.find(item => item.id === id); if (!task) throw new Error("Component task was not found."); return task; }
  private update(task: ComponentTask, status: ComponentTaskStatus, progress: number, detail: string): void { task.status = status; task.progress = progress; task.detail = detail; task.updatedAt = now(); }
  private assertNotCancelled(task: ComponentTask): void { if (this.cancelled.has(task.id) || task.status === "cancelled") throw new Error("Component installation cancelled."); }
  private async persist(): Promise<void> { await mkdir(dirname(this.taskPath), { recursive: true }); const temporary = `${this.taskPath}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify({ schemaVersion: 1, items: this.tasks }), { encoding: "utf8", mode: 0o600 }); await rename(temporary, this.taskPath); }
}

async function validPython(root: string, script: string): Promise<boolean> { try { await Promise.all([requireRegular(join(root, script)), requireRegular(join(root, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python3"))]); return true; } catch { return false; } }
async function validMediaFetcher(root: string): Promise<boolean> { try { const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")); return manifest.managedBy === MANAGED_BY && manifest.id === "media-fetcher" && await isRegular(join(root, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp")); } catch { return false; } }
async function requireRegular(path: string): Promise<void> { if (!await isRegular(path)) throw new Error(`Required managed file is missing or unsafe: ${path}`); }
async function isRegular(path: string): Promise<boolean> { try { return (await lstat(path)).isFile(); } catch { return false; } }
async function rejectLink(path: string): Promise<void> { try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`Refusing to operate through symbolic link: ${path}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function sha256(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
function validTask(value: unknown): value is ComponentTask { return Boolean(value && typeof value === "object" && typeof (value as ComponentTask).id === "string" && typeof (value as ComponentTask).componentId === "string" && typeof (value as ComponentTask).status === "string"); }
function requireId(id: string): asserts id is ComponentId { if (!(id in DETAILS)) throw new Error("Unknown component; installation is refused."); }
function now(): string { return new Date().toISOString(); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function runProcess(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> { return new Promise((done, reject) => { const child = spawn(file, args, { shell: false, windowsHide: true }); let stdout = ""; let stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject); child.once("close", code => code === 0 ? done({ stdout, stderr }) : reject(new Error(stderr || `${basename(file)} exited with ${code}`))); }); }
