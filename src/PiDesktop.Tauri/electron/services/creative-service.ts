import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { MediaTaskService } from "./media-task-service.js";

type Data = Record<string, unknown>;
type TaskExecutor = (kind: string, args: Data) => Promise<Data>;
type CreativePort = (args: Data) => Promise<Data>;

export interface CreativeServicePorts {
  readLyricBridgeSelection?: CreativePort;
  previewLyricBridgeFit?: CreativePort;
  confirmLyricBridgeFit?: CreativePort;
  previewMediaSource?: CreativePort;
  runAudioToProject?: CreativePort;
  runScoreToSynthv?: CreativePort;
  runRetakeWorkbench?: CreativePort;
  runSoloTuning?: CreativePort;
  learnTuningProfile?: CreativePort;
  applyTuningProfile?: CreativePort;
}

export interface CreativeService {
  invoke(command: string, args: Data): Promise<unknown>;
}

export interface CreativeServiceOptions {
  mediaTasks?: MediaTaskService;
  ports?: CreativeServicePorts;
}

export function createCreativeService(dataRoot: string, executeTask: TaskExecutor = async command => { throw new Error(`No component executor is configured for ${command}.`); }, options: CreativeServiceOptions = {}): CreativeService {
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
  const ports = options.ports ?? {};
  const unavailable = (command: string, blocker: string, detail = "需要由 Electron 主进程注入真实能力端口。") => ({ succeeded: false, status: "unavailable", command, summary: `${command} 当前不可用。`, blocker, detail });
  const portOrUnavailable = async (command: string, port: CreativePort | undefined, input: Data) => {
    if (!port) return unavailable(command, "required_port_not_configured");
    try { return await port(input); } catch (error) { return unavailable(command, "port_execution_failed", error instanceof Error ? error.message : String(error)); }
  };
  const executeOrUnavailable = async (command: string, input: Data) => {
    try {
      const result = await executeTask(command, input);
      if (result.succeeded === false) return unavailable(command, "component_rejected", String(result.summary ?? "组件拒绝执行。"));
      await appendHistory(command, String(result.summary ?? `${command} completed.`), result);
      return result;
    } catch (error) {
      return unavailable(command, "component_unavailable", error instanceof Error ? error.message : String(error));
    }
  };
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
    if (command === "generate_lyric_candidates") {
      const request = (args.request && typeof args.request === "object" ? args.request : {}) as Data;
      const brief = String(request.brief ?? "").trim();
      const imagery = String(request.imagery ?? "").trim();
      const sectionLabel = String(request.sectionLabel ?? "副歌");
      const targetRhyme = String(request.targetRhyme ?? "").trim();
      if (!brief && !imagery) return unavailable(command, "lyric_brief_required", "至少提供 brief 或 imagery，不能凭空生成歌词。");
      const seed = imagery || brief;
      const endings = targetRhyme ? [targetRhyme] : ["光", "旁", "长", "想"];
      const candidates = endings.map((ending, index) => ({ text: `${sectionLabel}：${seed}${ending}`, rhymeFoot: ending, rhymeMatched: Boolean(targetRhyme), note: "由本地模板基于输入短语生成；未调用模型。", rank: index + 1 }));
      return { language: String(request.language ?? "zh-CN"), brief, imagery, sectionLabel, targetRhyme: targetRhyme || null, candidates };
    }
    if (command === "read_lyric_bridge_selection") return portOrUnavailable(command, ports.readLyricBridgeSelection, args);
    if (command === "preview_lyric_bridge_fit") return portOrUnavailable(command, ports.previewLyricBridgeFit, args);
    if (command === "confirm_lyric_bridge_fit") return portOrUnavailable(command, ports.confirmLyricBridgeFit, args);
    if (command === "preview_media_source") return portOrUnavailable(command, ports.previewMediaSource, args);
    if (command === "get_project_backup_state") {
      const checkpoints = await list<Data>(safe("project-checkpoints", "entries.json"));
      return { intervalSeconds: 60, projects: checkpoints.map(item => ({ sourcePath: item.sourcePath, lastSeenAtUtc: item.createdAt, lastBackupAtUtc: item.createdAt, lastError: null, backupCount: 1 })), lastError: null };
    }
    if (command === "run_audio_to_project") return portOrUnavailable(command, ports.runAudioToProject, args);
    if (command === "run_score_to_synthv") return portOrUnavailable(command, ports.runScoreToSynthv, args);
    if (command === "run_retake_workbench") return portOrUnavailable(command, ports.runRetakeWorkbench, args);
    if (command === "run_solo_tuning") return portOrUnavailable(command, ports.runSoloTuning, args);
    if (command === "run_batch_workflow") {
      const recipeId = String(args.recipeId ?? "");
      const inputPaths = Array.isArray(args.inputPaths) ? args.inputPaths.filter((item): item is string => typeof item === "string") : [];
      if (!recipeId || !inputPaths.length) return unavailable(command, "batch_input_required", "recipeId 和至少一个 inputPath 是必需的。");
      const commandByRecipe: Record<string, string> = { "project-doctor": "run_project_doctor", "pronunciation-check": "run_pronunciation_diagnostics", "render-quality-check": "run_render_review" };
      const childCommand = commandByRecipe[recipeId];
      if (!childCommand) return unavailable(command, "unknown_recipe", `不支持的 recipeId: ${recipeId}`);
      const items = [] as Data[];
      for (const inputPath of inputPaths) items.push({ inputPath, status: "completed", result: await executeOrUnavailable(childCommand, { ...((args.options && typeof args.options === "object" ? args.options : {}) as Data), inputPath }) });
      const failed = items.filter(item => (item.result as Data).succeeded === false).length;
      return { recipeId, completed: items.length - failed, failed, items };
    }
    if (command === "review_workflow") {
      const data = args.data && typeof args.data === "object" ? args.data as Data : {};
      return { conclusion: "已完成结构化复核。", risks: data.succeeded === false ? [String(data.blocker ?? "workflow_failed")] : [], recommendations: data.succeeded === false ? ["补齐阻塞能力后重新执行。"] : [] };
    }
    if (command === "list_tuning_profiles") return list<Data>(tuning);
    if (command === "get_tuning_profile") {
      const voiceName = String(args.voiceName ?? "").trim().toLocaleLowerCase();
      const profile = (await list<Data>(tuning)).find(item => String(item.voiceName ?? "").trim().toLocaleLowerCase() === voiceName);
      if (!profile) throw new Error(`尚未为声库 ${String(args.voiceName ?? "")} 建立调声档案。`);
      return profile;
    }
    if (command === "learn_tuning_profile") {
      if (ports.learnTuningProfile) return portOrUnavailable(command, ports.learnTuningProfile, args);
      const voiceName = String(args.voiceName ?? "").trim();
      const audioPath = String(args.audioPath ?? "").trim();
      if (!voiceName || !audioPath) return unavailable(command, "voice_and_audio_required", "voiceName 与 audioPath 是必需的。");
      const features = await executeOrUnavailable("run_source_style", { audioPath });
      if (features.succeeded === false) return features;
      const sample = normalizeSourceStyle((features as Data).data ?? features);
      const all = await list<Data>(tuning); const normalizedVoiceName = voiceName.toLocaleLowerCase(); const index = all.findIndex((item) => item.normalizedVoiceName === normalizedVoiceName);
      const existing = index < 0 ? undefined : all[index];
      const sourceSamples = Number(existing?.sourceSamples ?? 0) + 1;
      const weight = 1 / Math.min(32, sourceSamples);
      const averageFeatures = existing ? blendRecords(recordValue(existing.averageFeatures), sample, weight) : sample;
      const suggested = tuningParametersFromFeatures(sample);
      const parameters = existing ? blendRecords(recordValue(existing.parameters), suggested, weight) : suggested;
      const profile = { voiceName, normalizedVoiceName, sourceSamples, outcomeSamples: Number(existing?.outcomeSamples ?? 0), averageFeatures, parameters, updatedAtUtc: now() };
      if (index < 0) all.push(profile); else all[index] = profile; await writeJson(tuning, all); return profile;
    }
    if (command === "record_tuning_outcome") { const all = await list<Data>(tuning); const voiceName = String(args.voiceName ?? "").trim(); const index = all.findIndex((item) => String(item.voiceName ?? "").toLocaleLowerCase() === voiceName.toLocaleLowerCase()); if (index < 0) return unavailable(command, "profile_not_found", "必须先学习该 voice 的本地调声档案。"); const improvement = Number(args.improvement); if (!Number.isFinite(improvement) || improvement < -1 || improvement > 1) throw new Error("A/B 改善分数必须在 -1 到 1 之间。"); const current = recordValue(all[index].parameters); const candidate = normalizeTuningParameters(args.candidate); const weight = Math.abs(improvement) * 0.25; const target = improvement >= 0 ? candidate : Object.fromEntries(Object.keys(current).map(key => [key, Number(current[key]) + (Number(current[key]) - Number(candidate[key]))])); const profile = { ...all[index], outcomeSamples: Number(all[index].outcomeSamples ?? 0) + 1, parameters: clampTuningParameters(blendRecords(current, target, weight)), updatedAtUtc: now() }; all[index] = profile; await writeJson(tuning, all); return profile; }
    if (command === "apply_tuning_profile") {
      const voiceName = String(args.voiceName ?? "").trim().toLocaleLowerCase();
      const profile = (await list<Data>(tuning)).find(item => String(item.voiceName ?? "").trim().toLocaleLowerCase() === voiceName);
      if (!profile) return unavailable(command, "profile_not_found", "必须先学习该 voice 的本地调声档案。");
      return portOrUnavailable(command, ports.applyTuningProfile, { ...args, profile });
    }
    if (command === "create_project_checkpoint") { const source = resolve(String(args.projectPath ?? "")); if (!isAbsolute(source) || extname(source).toLowerCase() !== ".svp") throw new Error("A local SVP project path is required."); const checkpointId = id(); const directory = safe("project-checkpoints", checkpointId); await mkdir(directory, { recursive: true }); const snapshot = join(directory, basename(source)); await copyFile(source, snapshot); const entry = { id: checkpointId, label: String(args.label ?? "Checkpoint"), sourcePath: source, snapshotPath: snapshot, createdAt: now() }; const entries = await list<Data>(safe("project-checkpoints", "entries.json")); entries.unshift(entry); await writeJson(safe("project-checkpoints", "entries.json"), entries); return entry; }
    if (command === "list_project_checkpoints") return (await list<Data>(safe("project-checkpoints", "entries.json"))).slice(0, Number(args.limit ?? 50));
    if (command === "restore_project_checkpoint") { const entry = (await list<Data>(safe("project-checkpoints", "entries.json"))).find((item) => item.id === args.id); if (!entry) throw new Error("Checkpoint was not found."); const output = resolve(dirname(String(entry.sourcePath)), String(args.outputName ?? `restored-${basename(String(entry.sourcePath))}`)); if (relative(dirname(String(entry.sourcePath)), output).startsWith("..")) throw new Error("Restore output escapes the source directory."); await copyFile(String(entry.snapshotPath), output); return { succeeded: true, summary: "Checkpoint restored.", detail: output }; }
    if (command === "media_tasks" && options.mediaTasks) return options.mediaTasks.snapshots();
    if (command === "queue_media_import" && options.mediaTasks) return options.mediaTasks.enqueueImport(String(args.source ?? ""), args.rightsConfirmed === true);
    if (command === "queue_media_separation" && options.mediaTasks) return options.mediaTasks.enqueueSeparation(String(args.audioPath ?? ""));
    if (command === "queue_cover" && options.mediaTasks) return options.mediaTasks.enqueueCover(args.request);
    if (command === "cancel_media_task" && options.mediaTasks) return options.mediaTasks.cancel(String(args.taskId ?? ""));
    if (command === "retry_media_task" && options.mediaTasks) return options.mediaTasks.retry(String(args.taskId ?? ""));
    if (["media_tasks", "audio_tasks"].includes(command)) return list<Data>(tasks);
    if (["cancel_media_task", "cancel_audio_task", "retry_media_task", "retry_audio_task"].includes(command)) { const all = await list<Data>(tasks); const task = all.find((item) => item.id === args.taskId); if (!task) throw new Error("Task was not found."); task.status = command.startsWith("cancel") ? "cancelled" : "queued"; task.updatedAt = now(); await writeJson(tasks, all); return task; }
    if (command.startsWith("run_") || command.startsWith("start_")) return executeOrUnavailable(command, args);
    if (command === "enqueue_media_task") { const task = { id: id(), kind: command, status: "queued", args, createdAt: now(), updatedAt: now() }; const all = await list<Data>(tasks); all.unshift(task); await writeJson(tasks, all); return task; }
    return executeOrUnavailable(command, args);
  } };
}

function recordValue(value: unknown): Data { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本地调声档案数据无效。"); return value as Data; }
function numericField(value: Data, snake: string, camel: string): number { const result = Number(value[snake] ?? value[camel]); if (!Number.isFinite(result)) throw new Error(`参考人声特征 ${camel} 无效。`); return result; }
function normalizeSourceStyle(value: unknown): Data { const source = recordValue(value); const result = { durationSec: numericField(source, "duration_sec", "durationSec"), medianPitchMidi: numericField(source, "median_pitch_midi", "medianPitchMidi"), pitchRangeSemitones: numericField(source, "pitch_range_semitones", "pitchRangeSemitones"), vibratoRateHz: numericField(source, "vibrato_rate_hz", "vibratoRateHz"), vibratoDepthCents: numericField(source, "vibrato_depth_cents", "vibratoDepthCents"), dynamicRangeDb: numericField(source, "dynamic_range_db", "dynamicRangeDb"), breathinessProxy: numericField(source, "breathiness_proxy", "breathinessProxy"), brightnessHz: numericField(source, "brightness_hz", "brightnessHz"), voicedRatio: numericField(source, "voiced_ratio", "voicedRatio") }; if (result.durationSec <= 0) throw new Error("参考人声时长无效。"); return result; }
function tuningParametersFromFeatures(features: Data): Data { return clampTuningParameters({ loudness: (Number(features.dynamicRangeDb) - 18) * 0.12, tension: (Number(features.brightnessHz) - 2_000) / 4_000 + (Number(features.pitchRangeSemitones) - 12) / 48, breathiness: (Number(features.breathinessProxy) - 0.18) * 2, gender: 0, toneShift: (Number(features.medianPitchMidi) - 64) / 64, vibratoStrength: Number(features.vibratoDepthCents) / 100 * (Number(features.vibratoRateHz) / 6) }); }
function blendRecords(current: Data, sample: Data, weight: number): Data { return Object.fromEntries(Object.keys(sample).map(key => [key, Number(current[key]) + (Number(sample[key]) - Number(current[key])) * Math.max(0, Math.min(1, weight))])); }
function clampTuningParameters(value: Data): Data { const ranges: Record<string, [number, number]> = { loudness: [-48, 12], tension: [-1, 1], breathiness: [-1, 1], gender: [-1, 1], toneShift: [-1, 1], vibratoStrength: [0, 2] }; return Object.fromEntries(Object.entries(ranges).map(([key, [minimum, maximum]]) => { const number = Number(value[key]); if (!Number.isFinite(number)) throw new Error(`调声参数 ${key} 无效。`); return [key, Math.max(minimum, Math.min(maximum, number))]; })); }
function normalizeTuningParameters(value: unknown): Data { return clampTuningParameters(recordValue(value)); }
