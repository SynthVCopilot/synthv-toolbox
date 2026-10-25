import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createLyricService, LYRIC_COMMANDS } from "./lyric-service.js";
import { createCreativeBridge, CREATIVE_BRIDGE_COMMANDS } from "./creative-bridge.js";
import { generateLyricCandidates, reviewWorkflow, type Completion, type CreativeAiDeps } from "./creative-ai.js";
import { COVER_COMMANDS } from "./cover-service.js";
import type { EmbeddedBridge } from "./synthv-bridge.js";

type Data = Record<string, any>;
type TaskExecutor = (kind: string, args: Data, signal?: AbortSignal) => Promise<Data>;
export interface CreativeService { invoke(command: string, args: Data, signal?: AbortSignal): Promise<unknown>; dispose?(): void; }

export function createCreativeService(dataRoot: string, executeTask: TaskExecutor = async command => { throw new Error(`No component executor is configured for ${command}.`); }, bridge?: EmbeddedBridge, cover?: { invoke(command: string, args: Data): Promise<unknown> }, options: { backupsEnabled?: () => boolean; backupIntervalMs?: number; complete?: Completion } = {}): CreativeService {
  const root = resolve(dataRoot), lyrics = createLyricService(root), connected = bridge ? createCreativeBridge(bridge) : undefined;
  const aiDeps: CreativeAiDeps = {
    complete: (system, input, signal) => options.complete ? options.complete(system, input, signal) : Promise.reject(new Error("The AI model is unavailable.")),
    rhymeFamilies: async target => { try { return ((await lyrics.invoke("lookup_chinese_rhyme", { query: target, matchMode: "family" })) as { rhymeKeys: string[] }).rhymeKeys; } catch { return []; } },
  };
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>) => { const next = queue.then(fn, fn); queue = next.catch(() => undefined); return next; };
  const now = () => new Date().toISOString();
  const managed = async (...parts: string[]) => {
    const path = resolve(root, ...parts), suffix = relative(root, path);
    if (!suffix || isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) throw new Error("Path escapes the creative data root.");
    for (let current = path; current !== dirname(root); current = dirname(current)) {
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error("Creative data paths must not contain symbolic links."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (current === root) break;
    }
    return path;
  };
  const readList = async (path: string): Promise<Data[]> => {
    try { const value = JSON.parse(await readFile(path, "utf8")); if (!Array.isArray(value)) throw new Error("Creative storage is invalid."); return value; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  const writeJson = async (path: string, value: unknown) => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  };
  const recipes = [
    ["project-doctor", "Project diagnostics", "project"], ["pronunciation-check", "Lyric structure diagnostics", "project"],
    ["project-probe", "Project inspection", "project"], ["project-no-params", "Project copy without parameters", "project"], ["render-review", "Rendered audio review", "audio"],
  ].map(([id, title, inputKind]) => ({ id, title, description: title, kind: id, inputKind, supportsBatch: true, requiresBridge: false, requiresAi: false, defaultParameters: {} }));
  const record = (kind: string, parameters: Data, result: Data) => serialize(async () => {
    const path = await managed("creative-history", "entries.json"), entries = await readList(path);
    entries.unshift({ id: randomUUID(), kind: result.kind ?? kind, title: result.summary ?? kind, summary: result.summary ?? kind, createdAtUtc: now(), outputPath: result.outputPath, parameters, result: result.data ?? result });
    await writeJson(path, entries.slice(0, 200));
  });
  const checkpoint = (projectPath: string, label = "Saved project snapshot") => serialize(async () => {
    if (!isAbsolute(projectPath) || extname(projectPath).toLowerCase() !== ".svp") throw new Error("An absolute local SVP path is required.");
    const file = await lstat(projectPath);
    if (!file.isFile() || file.size > 64 * 1024 * 1024) throw new Error("The SVP must be a regular file no larger than 64 MiB.");
    const bytes = await readFile(projectPath), sourceSha256 = sha(bytes);
    const path = await managed("project-checkpoints", "entries.json"), entries = await readList(path);
    const existing = entries.find(item => item.sourcePath === projectPath && item.sourceSha256 === sourceSha256);
    if (existing) return existing;
    const id = randomUUID(), snapshotPath = await managed("project-checkpoints", id, basename(projectPath));
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, bytes, { flag: "wx", mode: 0o600 });
    const entry = { id, label, sourcePath: projectPath, snapshotPath, sourceSha256, sourceSize: bytes.length, createdAtUtc: now() };
    entries.unshift(entry); await writeJson(path, entries); return entry;
  });
  const tracked = new Map<string, Data>();
  const track = async (path: string) => {
    const state = tracked.get(path) ?? { sourcePath: path, lastSeenAtUtc: now(), lastBackupAtUtc: null, lastError: null, backupCount: 0 };
    tracked.set(path, state); state.lastSeenAtUtc = now();
    try { const saved = await checkpoint(path); state.lastBackupAtUtc = saved.createdAtUtc; state.lastError = null; state.backupCount = (await readList(await managed("project-checkpoints", "entries.json"))).filter(item => item.sourcePath === path).length; }
    catch (error) { state.lastError = String(error); throw error; }
  };
  let backingUp = false;
  const timer = setInterval(() => {
    // .svp backups belong to the SynthV integration: while it is off, tracked projects are neither read nor copied.
    if (backingUp || options.backupsEnabled?.() === false) return;
    backingUp = true;
    void Promise.all([...tracked.keys()].map(path => track(path).catch(() => undefined))).finally(() => { backingUp = false; });
  }, options.backupIntervalMs ?? 60_000);
  timer.unref();
  const execute = async (command: string, args: Data, signal?: AbortSignal): Promise<Data> => {
    if (typeof args.projectPath === "string" && args.projectPath) await track(args.projectPath);
    let result: Data;
    if (CREATIVE_BRIDGE_COMMANDS.includes(command)) {
      if (!connected) throw new Error("SynthV Bridge is unavailable.");
      result = await connected.invoke(command, args);
    } else {
      result = await executeTask(command, args, signal);
      if (command === "run_audio_to_project" && args.importToSynthv === true) {
        if (!connected || typeof result.outputPath !== "string") throw new Error("Audio output is unavailable for SynthV import.");
        const imported = await connected.invoke("run_score_to_synthv", { ...args, scorePath: result.outputPath });
        result = { ...result, summary: imported.summary, data: { ...result.data, synthv: imported.data } };
      }
    }
    if (!result || result.succeeded === false || typeof result.summary !== "string" || !result.data || typeof result.data !== "object") throw new Error(String(result?.summary ?? "The component did not return a valid workflow result."));
    // A stopped run's work is not history, even when the process finished before it could be ended.
    signal?.throwIfAborted();
    await record(command, args, result); return result;
  };
  return { dispose() { clearInterval(timer); }, async invoke(command, args, signal) {
    if (cover && COVER_COMMANDS.includes(command)) return cover.invoke(command, args);
    if ((LYRIC_COMMANDS as readonly string[]).includes(command)) {
      const result = await lyrics.invoke(command, args);
      if (command === "build_lyric_template" || command === "export_lyric_project_text") await record(command, args, result as Data);
      return result;
    }
    if (command.includes("lyric_bridge")) {
      if (!connected) throw new Error("SynthV Bridge is unavailable.");
      return connected.invoke(command, args);
    }
    if (command === "list_workflow_recipes") return recipes;
    if (command === "list_creative_history") return (await readList(await managed("creative-history", "entries.json"))).slice(0, limit(args.limit));
    if (command === "get_project_backup_state") return { intervalSeconds: 60, projects: [...tracked.values()], lastError: null };
    if (command === "create_project_checkpoint") return checkpoint(String(args.projectPath ?? ""), String(args.label ?? "Saved project snapshot"));
    if (command === "list_project_checkpoints") return (await readList(await managed("project-checkpoints", "entries.json"))).slice(0, limit(args.limit));
    if (command === "restore_project_checkpoint") {
      const entry = (await readList(await managed("project-checkpoints", "entries.json"))).find(item => item.id === args.id);
      if (!entry) throw new Error("Checkpoint was not found.");
      const name = String(args.outputName ?? `restored-${randomUUID()}.svp`);
      if (basename(name) !== name || name.includes("\\") || extname(name).toLowerCase() !== ".svp") throw new Error("A new SVP filename is required.");
      const source = await managed("project-checkpoints", String(entry.id), basename(String(entry.snapshotPath)));
      if (sha(await readFile(source)) !== entry.sourceSha256) throw new Error("Checkpoint integrity check failed.");
      const output = join(dirname(String(entry.sourcePath)), name);
      await copyFile(source, output, constants.COPYFILE_EXCL);
      return { succeeded: true, summary: "Checkpoint restored to a new file.", detail: output };
    }
    if (command === "export_workflow_report") {
      if (!["markdown", "json"].includes(args.format)) throw new Error("Choose Markdown or JSON.");
      const path = await managed("reports", `${randomUUID()}.${args.format === "json" ? "json" : "md"}`);
      await mkdir(dirname(path), { recursive: true });
      const contents = args.format === "json" ? JSON.stringify(args, null, 2) : `# ${args.kind ?? "Workflow report"}\n\n${args.summary ?? ""}\n\n\`\`\`json\n${JSON.stringify(args.data ?? {}, null, 2)}\n\`\`\`\n`;
      await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
      return { succeeded: true, summary: "Report exported.", detail: path };
    }
    if (command === "run_batch_workflow") {
      const recipe = recipes.find(item => item.id === args.recipeId);
      if (!recipe || !Array.isArray(args.inputPaths) || !args.inputPaths.length || args.inputPaths.length > 100) throw new Error("Choose a supported recipe and 1–100 local files.");
      const operations: Data = { "project-doctor": "run_project_doctor", "pronunciation-check": "run_pronunciation_diagnostics", "project-probe": "run_project_probe", "project-no-params": "export_project_without_parameters", "render-review": "run_render_review" };
      const items = [];
      for (const inputPath of args.inputPaths) {
        try { const result = await execute(operations[recipe.id], { ...args.options, ...(recipe.inputKind === "audio" ? { audioPath: inputPath } : { projectPath: inputPath }), outputName: `${basename(inputPath, extname(inputPath))}-${randomUUID()}.svp` }); items.push({ inputPath, status: "completed", result }); }
        catch (error) { items.push({ inputPath, status: "failed", error: String(error) }); }
      }
      return { recipeId: recipe.id, completed: items.filter(item => item.status === "completed").length, failed: items.filter(item => item.status === "failed").length, items };
    }
    if (command === "generate_lyric_candidates") return generateLyricCandidates(args.request, aiDeps, signal);
    if (command === "review_workflow") return reviewWorkflow(args.kind, args.data, aiDeps, signal);
    if (["media_tasks", "audio_tasks", "list_tuning_profiles"].includes(command)) return [];
    if (["preview_media_source", "queue_media_import", "queue_media_separation", "queue_cover", "cancel_media_task", "retry_media_task", "learn_tuning_profile", "record_tuning_outcome", "apply_tuning_profile", "run_solo_tuning"].includes(command)) throw new Error("This workflow is not available in this build. Use the local audio, score, lyric and project tools.");
    return execute(command, args, signal);
  } };
}
function sha(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
function limit(value: unknown) { const result = value === undefined ? 50 : Number(value); if (!Number.isInteger(result) || result < 1 || result > 200) throw new Error("limit must be between 1 and 200."); return result; }
