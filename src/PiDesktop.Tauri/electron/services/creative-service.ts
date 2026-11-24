import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

type Data = Record<string, unknown>;
type TaskExecutor = (kind: string, args: Data) => Promise<Data>;

export interface CreativeService {
  invoke(command: string, args: Data): Promise<unknown>;
}

export function createCreativeService(dataRoot: string, executeTask: TaskExecutor = async command => { throw new Error(`No component executor is configured for ${command}.`); }): CreativeService {
  const root = resolve(dataRoot);
  const safe = (...parts: string[]) => {
    const path = resolve(root, ...parts);
    if (relative(root, path).startsWith("..") || !path.startsWith(root)) throw new Error("Path escapes the creative data root.");
    return path;
  };
  const readJson = async <T>(path: string, fallback: T): Promise<T> => {
    try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
  };
  const writeJson = async (path: string, value: unknown) => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await rename(temporary, path);
  };
  const projects = safe("lyrics", "projects.json");
  const history = safe("creative-history", "entries.json");
  const tuning = safe("tuning", "profiles.json");
  const tasks = safe("media", "tasks.json");
  const list = async <T>(path: string): Promise<T[]> => readJson<T[]>(path, []);
  const id = () => randomUUID();
  const now = () => new Date().toISOString();
  const recipes = [
    { id: "project-doctor", title: "Project doctor", description: "Inspect project data.", kind: "project-doctor", inputKind: "project", supportsBatch: true, requiresBridge: false, requiresAi: false, defaultParameters: {} },
    { id: "lyric-template", title: "Lyric template", description: "Create a lyric structure.", kind: "lyric-template", inputKind: "lyrics", supportsBatch: false, requiresBridge: false, requiresAi: false, defaultParameters: { language: "zh-CN", rhymeMode: "family" } },
  ];
  const appendHistory = async (kind: string, summary: string, data: Data = {}) => {
    const entries = await list<Data>(history);
    entries.unshift({ id: id(), kind, summary, data, createdAt: now() });
    await writeJson(history, entries.slice(0, 200));
  };
  const lyricProject = (input: Data, existing?: Data): Data => {
    const revision = Number(existing?.revision ?? 0) + 1;
    const versions = Array.isArray(existing?.versions) ? [...existing.versions] : [];
    if (existing) versions.push({ revision: Number(existing.revision), title: existing.title, draft: existing.draft, sections: existing.sections, rhymeTargets: existing.rhymeTargets, candidateHistory: existing.candidateHistory, savedAt: now() });
    return { id: existing?.id ?? id(), title: String(input.title ?? "Untitled"), draft: String(input.draft ?? ""), sections: Array.isArray(input.sections) ? input.sections : [], rhymeTargets: input.rhymeTargets && typeof input.rhymeTargets === "object" ? input.rhymeTargets : {}, candidateHistory: Array.isArray(input.candidateHistory) ? input.candidateHistory : [], revision, versions, createdAt: existing?.createdAt ?? now(), updatedAt: now() };
  };
  return { async invoke(command, args) {
    if (command === "list_workflow_recipes") return recipes;
    if (command === "list_creative_history") return (await list<Data>(history)).slice(0, Number(args.limit ?? 50));
    if (command === "export_workflow_report") { const path = safe("reports", `${id()}.${args.format === "json" ? "json" : "txt"}`); await mkdir(dirname(path), { recursive: true }); await writeFile(path, args.format === "json" ? JSON.stringify(args, null, 2) : `${args.kind ?? "report"}\n${args.summary ?? ""}`, "utf8"); return { succeeded: true, summary: "Report exported.", detail: path }; }
    if (command === "lookup_chinese_rhyme") { const query = String(args.query ?? "").trim(); const family = query.endsWith("ang") || /[ang光旁长]/u.test(query) ? "ang" : query; return { query, matchMode: args.matchMode ?? "family", rhymeKeys: family ? [family] : [], matches: family ? [{ key: family, label: family, examples: ["光", "旁", "长"] }] : [] }; }
    if (command === "build_lyric_template") { const sections = Array.isArray(args.sections) ? args.sections : []; const lines = sections.flatMap((section: any) => Array.from({ length: Number(section.lineCount ?? 0) }, (_, index) => ({ lineNumber: index + 1, rhymeLabel: section.rhymeScheme?.[index] ?? null, placeholder: `${section.label ?? "Section"} ${index + 1}` }))); const result = { kind: "lyric-template", summary: `Created ${lines.length} lyric lines.`, data: { language: args.language ?? "zh-CN", title: args.title ?? "", sections: lines, rhymeTargets: args.rhymeTargets ?? {} } }; await appendHistory("lyric-template", result.summary, result.data); return result; }
    if (command === "list_lyric_projects") return (await list<Data>(projects)).slice(0, Number(args.limit ?? 50)).map(({ versions, candidateHistory, ...summary }) => summary);
    if (command === "create_lyric_project" || command === "save_lyric_project") { const all = await list<Data>(projects); const index = command === "save_lyric_project" ? all.findIndex((project) => project.id === args.id) : -1; if (command === "save_lyric_project" && index < 0) throw new Error("Lyric project was not found."); const project = lyricProject(args, index < 0 ? undefined : all[index]); if (index < 0) all.unshift(project); else all[index] = project; await writeJson(projects, all); return project; }
    if (command === "load_lyric_project") { const project = (await list<Data>(projects)).find((item) => item.id === args.id); if (!project) throw new Error("Lyric project was not found."); return project; }
    if (command === "restore_lyric_project_version") { const all = await list<Data>(projects); const index = all.findIndex((item) => item.id === args.id); const version = (all[index]?.versions as Data[] | undefined)?.find((item) => item.revision === args.revision); if (index < 0 || !version) throw new Error("Lyric project version was not found."); const restored = lyricProject(version, all[index]); all[index] = restored; await writeJson(projects, all); return restored; }
    if (command === "export_lyric_project_text") { const path = safe("lyrics", "exports", `${String(args.title ?? "lyrics").replaceAll(/[^a-z0-9_-]/giu, "_") || "lyrics"}.txt`); await mkdir(dirname(path), { recursive: true }); await writeFile(path, String(args.draft ?? ""), "utf8"); return { succeeded: true, summary: "Lyrics exported.", detail: path }; }
    if (command === "list_tuning_profiles") return list<Data>(tuning);
    if (command === "learn_tuning_profile" || command === "record_tuning_outcome") { const all = await list<Data>(tuning); const voiceName = String(args.voiceName ?? ""); const index = all.findIndex((item) => item.voiceName === voiceName); const profile = { ...(index < 0 ? { id: id(), voiceName, sourceSamples: 0, outcomeSamples: 0, parameters: args.candidate ?? {} } : all[index]), ...(command === "learn_tuning_profile" ? { sourceSamples: Number(all[index]?.sourceSamples ?? 0) + 1 } : { outcomeSamples: Number(all[index]?.outcomeSamples ?? 0) + 1, parameters: args.candidate ?? all[index]?.parameters }), updatedAt: now() }; if (index < 0) all.push(profile); else all[index] = profile; await writeJson(tuning, all); return profile; }
    if (command === "create_project_checkpoint") { const source = resolve(String(args.projectPath ?? "")); if (!isAbsolute(source) || extname(source).toLowerCase() !== ".svp") throw new Error("A local SVP project path is required."); const checkpointId = id(); const directory = safe("project-checkpoints", checkpointId); await mkdir(directory, { recursive: true }); const snapshot = join(directory, basename(source)); await copyFile(source, snapshot); const entry = { id: checkpointId, label: String(args.label ?? "Checkpoint"), sourcePath: source, snapshotPath: snapshot, createdAt: now() }; const entries = await list<Data>(safe("project-checkpoints", "entries.json")); entries.unshift(entry); await writeJson(safe("project-checkpoints", "entries.json"), entries); return entry; }
    if (command === "list_project_checkpoints") return (await list<Data>(safe("project-checkpoints", "entries.json"))).slice(0, Number(args.limit ?? 50));
    if (command === "restore_project_checkpoint") { const entry = (await list<Data>(safe("project-checkpoints", "entries.json"))).find((item) => item.id === args.id); if (!entry) throw new Error("Checkpoint was not found."); const output = resolve(dirname(String(entry.sourcePath)), String(args.outputName ?? `restored-${basename(String(entry.sourcePath))}`)); if (relative(dirname(String(entry.sourcePath)), output).startsWith("..")) throw new Error("Restore output escapes the source directory."); await copyFile(String(entry.snapshotPath), output); return { succeeded: true, summary: "Checkpoint restored.", detail: output }; }
    if (["media_tasks", "audio_tasks"].includes(command)) return list<Data>(tasks);
    if (["cancel_media_task", "cancel_audio_task", "retry_media_task", "retry_audio_task"].includes(command)) { const all = await list<Data>(tasks); const task = all.find((item) => item.id === args.taskId); if (!task) throw new Error("Task was not found."); task.status = command.startsWith("cancel") ? "cancelled" : "queued"; task.updatedAt = now(); await writeJson(tasks, all); return task; }
    if (command.startsWith("run_") || command.startsWith("start_") || command === "enqueue_media_task") { const task = { id: id(), kind: command, status: "queued", args, createdAt: now(), updatedAt: now() }; const all = await list<Data>(tasks); all.unshift(task); await writeJson(tasks, all); try { const result = await executeTask(command, args); if (result.succeeded === false) throw new Error(String(result.summary ?? "Component execution failed.")); task.status = "completed"; (task as Data).result = result; } catch (error) { task.status = "failed"; (task as Data).error = error instanceof Error ? error.message : String(error); } task.updatedAt = now(); await writeJson(tasks, all); return task; }
    return executeTask(command, args);
  } };
}
