import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type Data = Record<string, unknown>;
type MediaTaskKind = "media-import" | "source-separation" | "cover";
type MediaTaskStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
type StageStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface CoverWorkflowRequest {
  source: string;
  lyrics?: string | null;
  voiceName: string;
  processId?: number | null;
  trackIndex: number;
  groupName: string;
  rightsConfirmed: boolean;
  tolerance: number;
  advanced: boolean;
  sourceMode?: "mixed" | "vocal";
  outputDirectory?: string | null;
  refinementIterations?: number;
}

export interface MediaTaskSnapshot {
  id: string;
  kind: MediaTaskKind;
  status: MediaTaskStatus;
  progress: number;
  detail: string;
  result: Data | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  attempt: number;
  currentStage: string | null;
  stages: Array<{ id: string; status: StageStatus; attempt: number; startedAt?: string; completedAt?: string; error?: string }>;
}

type StoredRequest =
  | { kind: "media-import"; source: string; rightsConfirmed: true }
  | { kind: "source-separation"; audioPath: string }
  | { kind: "cover"; request: CoverWorkflowRequest };

interface TaskRecord {
  snapshot: MediaTaskSnapshot;
  request: StoredRequest;
  stageOutputs: Record<string, Data>;
}

interface PersistedTasks {
  schemaVersion: 1;
  tasks: TaskRecord[];
}

export interface WorkflowProgress {
  percent: number;
  detail: string;
}

export interface MediaWorkflowPort {
  importMedia(input: { source: string; rightsConfirmed: true; taskId: string; outputDirectory: string }, signal: AbortSignal, progress: (value: WorkflowProgress) => void): Promise<Data>;
  separateAudio(input: { audioPath: string; taskId: string; outputDirectory: string; mode: "mixed" | "vocal" }, signal: AbortSignal, progress: (value: WorkflowProgress) => void): Promise<Data>;
  audioToMidi(input: { vocalPath: string; instrumentalPath: string; lyrics: string | null; outputPath: string; tolerance: number; advanced: boolean; taskId: string }, signal: AbortSignal, progress: (value: WorkflowProgress) => void): Promise<Data>;
  importScore(input: { midiPath: string; voiceName: string; processId: number | null; trackIndex: number; groupName: string; rightsConfirmed: true; taskId: string }, signal: AbortSignal): Promise<Data>;
  saveProject(input: { processId: number | null; taskId: string; importResult: Data }, signal: AbortSignal): Promise<Data>;
  exportRender(input: { processId: number | null; outputPath: string; iteration: number; taskId: string; importResult: Data }, signal: AbortSignal): Promise<Data>;
  compareAudio(input: { referencePath: string; renderPath: string; iteration: number; taskId: string }, signal: AbortSignal): Promise<Data>;
  applyTuning(input: { voiceName: string; processId: number | null; trackIndex: number; iteration: number; previousComparison: Data; importResult: Data; taskId: string }, signal: AbortSignal): Promise<Data>;
}

export interface MediaTaskServiceOptions {
  emit?: (event: string, payload: Data) => void;
  now?: () => Date;
  id?: () => string;
  allowedOutputRoots?: string[];
}

export class MediaTaskService {
  private readonly storePath: string;
  private readonly tasksRoot: string;
  private readonly controllers = new Map<string, AbortController>();
  private readonly emit: (event: string, payload: Data) => void;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly allowedOutputRoots: string[];
  private tasks: TaskRecord[] = [];
  private workerRunning = false;
  private readonly ready: Promise<void>;

  constructor(private readonly root: string, private readonly workflow: MediaWorkflowPort, options: MediaTaskServiceOptions = {}) {
    this.storePath = join(root, "media-tasks.json");
    this.tasksRoot = join(root, "jobs");
    this.emit = options.emit ?? (() => {});
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.allowedOutputRoots = [this.tasksRoot, ...(options.allowedOutputRoots ?? [])].map(value => resolve(value));
    this.ready = this.load();
  }

  async snapshots(): Promise<MediaTaskSnapshot[]> {
    await this.ready;
    return this.tasks.map(({ snapshot }) => clone(snapshot));
  }

  async enqueueImport(source: string, rightsConfirmed: boolean): Promise<MediaTaskSnapshot> {
    if (!rightsConfirmed) throw new Error("下载前必须确认拥有来源内容或已取得足够授权。");
    const normalized = boundedText(source, "source", 2_048);
    return this.enqueue({ kind: "media-import", source: normalized, rightsConfirmed: true }, ["download"]);
  }

  async enqueueSeparation(audioPath: string): Promise<MediaTaskSnapshot> {
    return this.enqueue({ kind: "source-separation", audioPath: boundedText(audioPath, "audioPath", 4_096) }, ["separation"]);
  }

  async enqueueCover(input: unknown): Promise<MediaTaskSnapshot> {
    const request = coverRequest(input);
    const stages = ["download", "separation", "audio-to-midi", "synthv-import", "synthv-save", "export-0", "compare-0"];
    for (let iteration = 1; iteration <= (request.refinementIterations ?? 0); iteration += 1) {
      stages.push(`tune-${iteration}`, `export-${iteration}`, `compare-${iteration}`);
    }
    return this.enqueue({ kind: "cover", request }, stages);
  }

  async cancel(taskId: string): Promise<MediaTaskSnapshot> {
    await this.ready;
    const task = this.task(taskId);
    if (!active(task.snapshot.status)) throw new Error("该媒体任务已经结束。");
    if (task.snapshot.kind === "cover" && task.snapshot.progress >= 80) throw new Error("Cover 已进入 SynthV 写入或导出阶段，不能安全取消。");
    const controller = this.controllers.get(taskId);
    task.snapshot.status = controller ? "cancelling" : "cancelled";
    task.snapshot.detail = controller ? "正在终止当前阶段。" : "已在开始前取消。";
    task.snapshot.updatedAt = this.timestamp();
    controller?.abort();
    await this.persist();
    this.publish(task);
    return clone(task.snapshot);
  }

  async retry(taskId: string): Promise<MediaTaskSnapshot> {
    await this.ready;
    const task = this.task(taskId);
    if (task.snapshot.status !== "failed" && task.snapshot.status !== "cancelled") throw new Error("只有失败或已取消的媒体任务可以重试。");
    task.snapshot.status = "queued";
    task.snapshot.error = null;
    task.snapshot.detail = "将从最后一个已验证阶段继续。";
    task.snapshot.currentStage = null;
    task.snapshot.attempt += 1;
    task.snapshot.updatedAt = this.timestamp();
    for (const stage of task.snapshot.stages) {
      if (stage.status !== "completed") {
        stage.status = "pending";
        delete stage.startedAt;
        delete stage.completedAt;
        delete stage.error;
      }
    }
    await this.persist();
    this.publish(task);
    this.schedule();
    return clone(task.snapshot);
  }

  private async enqueue(request: StoredRequest, stageIds: string[]): Promise<MediaTaskSnapshot> {
    await this.ready;
    const createdAt = this.timestamp();
    const record: TaskRecord = {
      request,
      stageOutputs: {},
      snapshot: {
        id: this.id(),
        kind: request.kind,
        status: "queued",
        progress: 0,
        detail: "等待前面的媒体任务完成。",
        result: null,
        error: null,
        createdAt,
        updatedAt: createdAt,
        attempt: 1,
        currentStage: null,
        stages: stageIds.map(id => ({ id, status: "pending", attempt: 0 })),
      },
    };
    this.tasks.push(record);
    while (this.tasks.length > 50) {
      const index = this.tasks.findIndex(task => !active(task.snapshot.status));
      if (index < 0) break;
      this.tasks.splice(index, 1);
    }
    await this.persist();
    this.publish(record);
    this.schedule();
    return clone(record.snapshot);
  }

  private schedule(): void {
    if (this.workerRunning) return;
    this.workerRunning = true;
    queueMicrotask(() => void this.drain());
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        const task = this.tasks.find(candidate => candidate.snapshot.status === "queued");
        if (!task) return;
        await this.run(task);
      }
    } finally {
      this.workerRunning = false;
      if (this.tasks.some(task => task.snapshot.status === "queued")) this.schedule();
    }
  }

  private async run(task: TaskRecord): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(task.snapshot.id, controller);
    task.snapshot.status = "running";
    task.snapshot.detail = "媒体任务已开始。";
    task.snapshot.updatedAt = this.timestamp();
    await this.persistAndPublish(task);
    try {
      const result = task.request.kind === "media-import"
        ? await this.runImport(task, task.request, controller.signal)
        : task.request.kind === "source-separation"
          ? await this.runSeparation(task, task.request, controller.signal)
          : await this.runCover(task, task.request.request, controller.signal);
      task.snapshot.status = "completed";
      task.snapshot.progress = 100;
      task.snapshot.detail = "媒体任务已完成。";
      task.snapshot.result = result;
      task.snapshot.error = null;
      task.snapshot.currentStage = null;
    } catch (reason) {
      const cancelled = controller.signal.aborted;
      task.snapshot.status = cancelled ? "cancelled" : "failed";
      task.snapshot.detail = cancelled ? "当前阶段已终止；已验证的阶段产物仍可用于重试。" : "媒体任务失败；可从最后一个已验证阶段重试。";
      task.snapshot.error = cancelled ? null : errorMessage(reason);
      const stage = task.snapshot.stages.find(candidate => candidate.id === task.snapshot.currentStage);
      if (stage && stage.status === "running") {
        stage.status = cancelled ? "cancelled" : "failed";
        stage.error = cancelled ? "cancelled" : errorMessage(reason);
        stage.completedAt = this.timestamp();
      }
      task.snapshot.currentStage = null;
    } finally {
      this.controllers.delete(task.snapshot.id);
      task.snapshot.updatedAt = this.timestamp();
      await this.persistAndPublish(task);
    }
  }

  private async runImport(task: TaskRecord, request: Extract<StoredRequest, { kind: "media-import" }>, signal: AbortSignal): Promise<Data> {
    const outputDirectory = this.outputDirectory(task, null);
    await mkdir(outputDirectory, { recursive: true });
    return this.stage(task, "download", 5, 95, signal, progress => this.workflow.importMedia({ source: request.source, rightsConfirmed: true, taskId: task.snapshot.id, outputDirectory }, signal, progress));
  }

  private async runSeparation(task: TaskRecord, request: Extract<StoredRequest, { kind: "source-separation" }>, signal: AbortSignal): Promise<Data> {
    const outputDirectory = this.outputDirectory(task, null);
    await mkdir(outputDirectory, { recursive: true });
    return this.stage(task, "separation", 5, 95, signal, progress => this.workflow.separateAudio({ audioPath: request.audioPath, taskId: task.snapshot.id, outputDirectory, mode: "mixed" }, signal, progress));
  }

  private async runCover(task: TaskRecord, request: CoverWorkflowRequest, signal: AbortSignal): Promise<Data> {
    const outputDirectory = this.outputDirectory(task, request.outputDirectory ?? null);
    await mkdir(outputDirectory, { recursive: true });
    const imported = await this.stage(task, "download", 3, 18, signal, progress => this.workflow.importMedia({ source: request.source, rightsConfirmed: true, taskId: task.snapshot.id, outputDirectory }, signal, progress));
    const audioPath = requiredPath(imported, ["audioPath", "outputPath"], "下载阶段没有返回音频文件。");
    const separated = await this.stage(task, "separation", 20, 42, signal, progress => this.workflow.separateAudio({ audioPath, taskId: task.snapshot.id, outputDirectory, mode: request.sourceMode ?? "mixed" }, signal, progress));
    const vocalPath = requiredPath(separated, ["vocalPath"], "分离阶段没有返回人声轨。");
    const instrumentalPath = requiredPath(separated, ["instrumentalPath"], "分离阶段没有返回伴奏轨。");
    const midiPath = join(outputDirectory, "cover.mid");
    const midi = await this.stage(task, "audio-to-midi", 44, 66, signal, progress => this.workflow.audioToMidi({ vocalPath, instrumentalPath, lyrics: request.lyrics ?? null, outputPath: midiPath, tolerance: request.tolerance, advanced: request.advanced, taskId: task.snapshot.id }, signal, progress));
    const resolvedMidi = requiredPath(midi, ["midiPath", "midi_out", "outputPath"], "旋律提取阶段没有返回 MIDI。");
    const importedScore = await this.stage(task, "synthv-import", 68, 78, signal, () => this.workflow.importScore({ midiPath: resolvedMidi, voiceName: request.voiceName, processId: request.processId ?? null, trackIndex: request.trackIndex, groupName: request.groupName, rightsConfirmed: true, taskId: task.snapshot.id }, signal));
    const saved = await this.stage(task, "synthv-save", 79, 82, signal, () => this.workflow.saveProject({ processId: request.processId ?? null, taskId: task.snapshot.id, importResult: importedScore }, signal));
    const referencePath = vocalPath;
    const iterations: Data[] = [];
    let previousComparison: Data | undefined;
    const count = request.refinementIterations ?? 0;
    for (let iteration = 0; iteration <= count; iteration += 1) {
      if (iteration > 0) {
        const tuning = await this.stage(task, `tune-${iteration}`, progressFor(iteration, count, 83), progressFor(iteration, count, 87), signal, () => this.workflow.applyTuning({ voiceName: request.voiceName, processId: request.processId ?? null, trackIndex: request.trackIndex, iteration, previousComparison: previousComparison ?? {}, importResult: importedScore, taskId: task.snapshot.id }, signal));
        const applied = isRecord(tuning.applied) ? tuning.applied : tuning;
        if (typeof applied.referenceFingerprint === "string") importedScore.referenceFingerprint = applied.referenceFingerprint;
        if (typeof applied.groupIndex === "number") importedScore.groupIndex = applied.groupIndex;
        iterations.push({ iteration, tuning });
      }
      const renderPath = join(outputDirectory, `cover-iteration-${iteration}.wav`);
      const rendered = await this.stage(task, `export-${iteration}`, progressFor(iteration, count, 87), progressFor(iteration, count, 94), signal, () => this.workflow.exportRender({ processId: request.processId ?? null, outputPath: renderPath, iteration, taskId: task.snapshot.id, importResult: importedScore }, signal));
      const actualRender = requiredPath(rendered, ["renderPath", "audioPath", "outputPath"], "SynthV 导出阶段没有返回音频文件。");
      previousComparison = await this.stage(task, `compare-${iteration}`, progressFor(iteration, count, 94), progressFor(iteration, count, 99), signal, () => this.workflow.compareAudio({ referencePath, renderPath: actualRender, iteration, taskId: task.snapshot.id }, signal));
      const item = iterations.find(candidate => candidate.iteration === iteration);
      if (item) Object.assign(item, { render: rendered, comparison: previousComparison });
      else iterations.push({ iteration, render: rendered, comparison: previousComparison });
    }
    return { source: imported, separation: separated, midi, synthvImport: importedScore, save: saved, iterations, outputDirectory, requestedVoice: request.voiceName };
  }

  private async stage(task: TaskRecord, stageId: string, start: number, end: number, signal: AbortSignal, run: (progress: (value: WorkflowProgress) => void) => Promise<Data>): Promise<Data> {
    const stage = task.snapshot.stages.find(candidate => candidate.id === stageId);
    if (!stage) throw new Error(`任务阶段不存在：${stageId}`);
    if (stage.status === "completed" && task.stageOutputs[stageId]) return task.stageOutputs[stageId];
    throwIfAborted(signal);
    stage.status = "running";
    stage.attempt += 1;
    stage.startedAt = this.timestamp();
    delete stage.completedAt;
    delete stage.error;
    task.snapshot.currentStage = stageId;
    task.snapshot.progress = start;
    task.snapshot.detail = stageDetail(stageId);
    task.snapshot.updatedAt = this.timestamp();
    await this.persistAndPublish(task);
    const update = (value: WorkflowProgress) => {
      const fraction = Math.max(0, Math.min(100, value.percent)) / 100;
      task.snapshot.progress = Math.round(start + (end - start) * fraction);
      task.snapshot.detail = value.detail;
      task.snapshot.updatedAt = this.timestamp();
      void this.persistAndPublish(task);
    };
    const result = await run(update);
    throwIfAborted(signal);
    task.stageOutputs[stageId] = result;
    stage.status = "completed";
    stage.completedAt = this.timestamp();
    task.snapshot.progress = end;
    task.snapshot.updatedAt = this.timestamp();
    await this.persistAndPublish(task);
    return result;
  }

  private outputDirectory(task: TaskRecord, requested: string | null): string {
    if (!requested) return join(this.tasksRoot, task.snapshot.id);
    const absolute = resolve(requested);
    if (!this.allowedOutputRoots.some(root => inside(root, absolute))) throw new Error("输出目录未被本次任务授权。");
    return absolute;
  }

  private async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.storePath, "utf8"));
      if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.tasks)) throw new Error("媒体任务存储格式不受支持。");
      this.tasks = parsed.tasks.filter(isTaskRecord).slice(-50);
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code !== "ENOENT") throw reason;
      this.tasks = [];
    }
    let changed = false;
    for (const task of this.tasks) {
      if (!active(task.snapshot.status)) continue;
      changed = true;
      task.snapshot.status = "failed";
      task.snapshot.detail = "应用在任务完成前退出；可从最后一个已验证阶段继续。";
      task.snapshot.error = "任务被应用退出中断。";
      task.snapshot.currentStage = null;
      task.snapshot.updatedAt = this.timestamp();
      for (const stage of task.snapshot.stages) {
        if (stage.status === "running") {
          stage.status = "failed";
          stage.error = "interrupted";
          stage.completedAt = this.timestamp();
        }
      }
    }
    if (changed) await this.persist();
  }

  private task(id: string): TaskRecord {
    const task = this.tasks.find(candidate => candidate.snapshot.id === id);
    if (!task) throw new Error("没有找到该媒体任务。");
    return task;
  }

  private async persistAndPublish(task: TaskRecord): Promise<void> {
    await this.persist();
    this.publish(task);
  }

  private publish(task: TaskRecord): void {
    this.emit("media-task-updated", clone(task.snapshot) as unknown as Data);
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    await mkdir(this.tasksRoot, { recursive: true });
    const parent = await lstat(dirname(this.storePath));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("媒体任务目录不是安全的普通目录。");
    try {
      if ((await lstat(this.storePath)).isSymbolicLink()) throw new Error("媒体任务文件不能是符号链接。");
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code !== "ENOENT") throw reason;
    }
    const temporary = `${this.storePath}.${this.id()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, tasks: this.tasks } satisfies PersistedTasks, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.storePath);
  }

  private timestamp(): string { return this.now().toISOString(); }
}

function coverRequest(value: unknown): CoverWorkflowRequest {
  if (!isRecord(value)) throw new Error("Cover request must be an object.");
  if (value.rightsConfirmed !== true) throw new Error("Cover 前必须确认拥有来源内容或已取得足够授权。");
  const refinementIterations = value.refinementIterations === undefined ? 0 : boundedInteger(value.refinementIterations, "refinementIterations", 0, 8);
  return {
    source: boundedText(value.source, "source", 2_048),
    lyrics: value.lyrics == null ? null : boundedText(value.lyrics, "lyrics", 256 * 1024),
    voiceName: boundedText(value.voiceName, "voiceName", 200),
    processId: value.processId == null ? null : boundedInteger(value.processId, "processId", 1, Number.MAX_SAFE_INTEGER),
    trackIndex: boundedInteger(value.trackIndex, "trackIndex", 1, 10_000),
    groupName: boundedText(value.groupName, "groupName", 200),
    rightsConfirmed: true,
    tolerance: boundedNumber(value.tolerance, "tolerance", 0.02, 0.25),
    advanced: value.advanced === true,
    sourceMode: value.sourceMode === undefined ? "mixed" : enumValue(value.sourceMode, "sourceMode", ["mixed", "vocal"] as const),
    outputDirectory: value.outputDirectory == null ? null : boundedText(value.outputDirectory, "outputDirectory", 4_096),
    refinementIterations,
  };
}

function stageDetail(stage: string): string {
  if (stage === "download") return "正在获取并校验来源音频。";
  if (stage === "separation") return "正在分离人声与伴奏。";
  if (stage === "audio-to-midi") return "正在把人声旋律转换为 MIDI。";
  if (stage === "synthv-import") return "正在将 MIDI 与歌词写入 SynthV。";
  if (stage === "synthv-save") return "正在保存并验证 SynthV 工程。";
  if (stage.startsWith("export-")) return "正在从 SynthV 导出本轮音频。";
  if (stage.startsWith("compare-")) return "正在比较参考与本轮 Cover。";
  if (stage.startsWith("tune-")) return "正在根据上一轮差异细调 Cover。";
  return `正在执行 ${stage}。`;
}

function progressFor(iteration: number, total: number, within: number): number {
  const span = 17 / Math.max(1, total + 1);
  const base = 82 + span * iteration;
  return Math.min(99, Math.round(base + span * ((within - 82) / 17)));
}

function requiredPath(value: Data, keys: string[], message: string): string {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    const nested = value.data;
    if (isRecord(nested) && typeof nested[key] === "string" && nested[key].length > 0) return nested[key];
  }
  throw new Error(message);
}

function active(status: MediaTaskStatus): boolean { return status === "queued" || status === "running" || status === "cancelling"; }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Task cancelled."); }
function boundedText(value: unknown, name: string, maximum: number): string { if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${name} must be a non-empty string no longer than ${maximum} characters.`); return value.trim(); }
function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`); return value; }
function boundedNumber(value: unknown, name: string, minimum: number, maximum: number): number { if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}.`); return value; }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function enumValue<T extends string>(value: unknown, name: string, values: readonly T[]): T { if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${name} is invalid.`); return value as T; }
function inside(root: string, candidate: string): boolean { const offset = relative(root, candidate); return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)); }
function clone<T>(value: T): T { return structuredClone(value); }
function isRecord(value: unknown): value is Data { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isTaskRecord(value: unknown): value is TaskRecord {
  if (!isRecord(value) || !isRecord(value.snapshot) || !isRecord(value.request) || !isRecord(value.stageOutputs)) return false;
  const snapshot = value.snapshot;
  return typeof snapshot.id === "string" && (snapshot.kind === "media-import" || snapshot.kind === "source-separation" || snapshot.kind === "cover")
    && typeof snapshot.status === "string" && Array.isArray(snapshot.stages) && typeof snapshot.createdAt === "string" && typeof snapshot.updatedAt === "string";
}
