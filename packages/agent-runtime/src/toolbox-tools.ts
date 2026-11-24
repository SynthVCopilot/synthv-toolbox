import { Type } from "@earendil-works/pi-ai";
import type { JsonValue } from "@synthv-toolbox/runtime-protocol";

export interface ToolboxToolTransport {
  request(method: string, params: JsonValue): Promise<JsonValue>;
}

type Data = Record<string, unknown>;
const COVER_POLL_INTERVAL_MS = 1_000;
const COVER_POLL_LIMIT = 1_800;
const MAX_TOOL_RESULT_CHARS = 256_000;
const MAX_TOOL_STRING_CHARS = 2_000;
const MAX_TOOL_ARRAY_ITEMS = 64;
const MAX_TOOL_OBJECT_FIELDS = 64;

export function createToolboxTools(host?: ToolboxToolTransport): unknown[] {
  if (!host) return [];
  const invoke = async (command: string, args: Data): Promise<Data> => {
    const result = await host.request("host.toolbox.invoke", { command, args } as JsonValue);
    return result as Data;
  };
  const result = (value: unknown) => {
    const compacted = compactToolResult(value);
    const serialized = JSON.stringify(compacted);
    const details = serialized.length <= MAX_TOOL_RESULT_CHARS
      ? compacted
      : { truncated: true, preview: serialized.slice(0, MAX_TOOL_RESULT_CHARS) };
    return { content: [{ type: "text", text: JSON.stringify(details) }], details };
  };
  return [
    {
      name: "start_cover_job",
      label: "Start Cover Job",
      description: "Run and supervise the durable local Cover workflow through its terminal state: acquire a rights-cleared source, open a saved Synthesizer V Studio 2 project whose target main group is empty and already has the intended voice, prepare vocals, convert voice to MIDI, physically write notes, wait for computed pronunciation, save, export WAV, compare it with the reference, and refine it. Use sourceMode=vocal for an a-cappella source and mixed for a full mix.",
      promptSnippet: "Run and supervise a recoverable end-to-end SynthV Cover job, including verified note and pronunciation readback.",
      promptGuidelines: ["Never claim a Cover completed until this tool returns a completed job with verified note write, computed pronunciation, persisted SVP notes, export and comparison evidence.", "If a job fails, inspect the exact failed stage, repair the stated prerequisite, then retry the same job so verified checkpoints are reused."],
      parameters: Type.Object({
        source: Type.String({ minLength: 1, maxLength: 2048 }),
        lyrics: Type.Optional(Type.String({ maxLength: 262144 })),
        voiceName: Type.String({ minLength: 1, maxLength: 200 }),
        processId: Type.Optional(Type.Integer({ minimum: 1 })),
        projectPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        trackIndex: Type.Integer({ minimum: 1, maximum: 10000, default: 1 }),
        groupName: Type.String({ minLength: 1, maxLength: 200, default: "Toolbox Cover" }),
        rightsConfirmed: Type.Literal(true),
        tolerance: Type.Number({ minimum: 0.02, maximum: 0.25, default: 0.08 }),
        advanced: Type.Boolean({ default: true }),
        sourceMode: Type.Union([Type.Literal("mixed"), Type.Literal("vocal")], { default: "mixed" }),
        refinementIterations: Type.Integer({ minimum: 0, maximum: 8, default: 2 }),
      }, { additionalProperties: false }),
      execute: async (_toolCallId: string, params: Data, signal?: AbortSignal) => result(await startCoverAndWait(invoke, params, signal)),
    },
    {
      name: "list_cover_jobs",
      label: "List Cover Jobs",
      description: "List durable media and Cover jobs with their current stage, progress, attempts, artifacts, and errors.",
      promptSnippet: "Inspect Cover job progress and evidence.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => result(await invoke("media_tasks", {})),
    },
    {
      name: "retry_cover_job",
      label: "Retry Cover Job",
      description: "Retry a failed or cancelled Cover job from its last verified stage and supervise it through its terminal state without repeating completed downloads or conversions.",
      parameters: Type.Object({ taskId: Type.String({ minLength: 1 }), refinementIterations: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })) }, { additionalProperties: false }),
      execute: async (_toolCallId: string, params: Data, signal?: AbortSignal) => {
        const taskId = requiredString(params.taskId, "Cover task id");
        await invoke("retry_media_task", { taskId });
        return result(await waitForCover(invoke, taskId, Number(params.refinementIterations ?? 0), signal));
      },
    },
    {
      name: "cancel_cover_job",
      label: "Cancel Cover Job",
      description: "Cancel a queued or safely cancellable running Cover job. SynthV write/export stages reject cancellation to avoid partial project mutation.",
      parameters: Type.Object({ taskId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      execute: async (_toolCallId: string, params: Data) => result(await invoke("cancel_media_task", params)),
    },
    {
      name: "inspect_synthv_environment",
      label: "Inspect SynthV Environment",
      description: "Read the running SynthV processes, Bridge status, local voice catalog, FFmpeg status, component catalog and component tasks before starting a Cover.",
      promptSnippet: "Preflight the real local SynthV and audio environment.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => result({
        processes: await invoke("list_synthv_processes", {}),
        bridge: await invoke("bridge_session_status", {}),
        voices: compactVoiceCatalog(await invoke("sv2_voice_catalog", {})),
        ffmpeg: await invoke("ffmpeg_status", {}),
        components: await invoke("component_downloads", {}),
      }),
    },
    {
      name: "install_cover_component",
      label: "Install Cover Component",
      description: "Queue installation of one pinned Toolbox-managed Cover prerequisite. Allowed ids are pi-audio, vocal-separation, media-fetcher, cvrs, and ffmpeg. The service verifies source and hashes and never accepts arbitrary download URLs.",
      parameters: Type.Object({ id: Type.Union([Type.Literal("pi-audio"), Type.Literal("vocal-separation"), Type.Literal("media-fetcher"), Type.Literal("cvrs"), Type.Literal("ffmpeg")]) }, { additionalProperties: false }),
      execute: async (_toolCallId: string, params: Data) => result(await invoke("queue_component_install", params)),
    },
  ];
}

async function startCoverAndWait(invoke: (command: string, args: Data) => Promise<Data>, params: Data, signal?: AbortSignal): Promise<Data> {
  const queued = await invoke("queue_cover", { request: params });
  const taskId = requiredString(queued.id, "Cover task id");
  return waitForCover(invoke, taskId, Number(params.refinementIterations ?? 0), signal);
}

async function waitForCover(invoke: (command: string, args: Data) => Promise<Data>, taskId: string, refinementIterations: number, signal?: AbortSignal): Promise<Data> {
  for (let attempt = 0; attempt < COVER_POLL_LIMIT; attempt += 1) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Cover supervision was cancelled.");
    const snapshots = await invoke("media_tasks", {});
    if (!Array.isArray(snapshots)) throw new Error("Toolbox returned an invalid Cover task list.");
    const task = snapshots.find(value => isRecord(value) && value.id === taskId);
    if (!isRecord(task)) throw new Error("The queued Cover task disappeared from durable storage.");
    if (task.status === "completed") return verifiedCoverEvidence(task, refinementIterations);
    if (task.status === "failed" || task.status === "cancelled") throw new Error(`Cover task ${task.status}: ${typeof task.error === "string" ? task.error : "no error detail"}`);
    await delay(COVER_POLL_INTERVAL_MS, signal);
  }
  throw new Error("Cover task did not reach a terminal state within 30 minutes.");
}

function verifiedCoverEvidence(task: Data, refinementIterations: number): Data {
  if (!isRecord(task.result) || !isRecord(task.result.synthvImport) || !isRecord(task.result.save) || !Array.isArray(task.result.iterations)) {
    throw new Error("Completed Cover task is missing structured result evidence.");
  }
  const imported = task.result.synthvImport;
  const saved = task.result.save;
  if (imported.writeVerified !== true || imported.pronunciationVerified !== true || !isRecord(imported.writeVerification)
    || saved.saveVerified !== true || saved.notesPersisted !== true) {
    throw new Error("Completed Cover task lacks verified note, pronunciation, or persisted SVP evidence.");
  }
  const iterations = task.result.iterations;
  if (iterations.length < refinementIterations + 1 || iterations.some(value => !isRecord(value) || !isRecord(value.render) || !isRecord(value.comparison))) {
    throw new Error("Completed Cover task lacks all requested render and comparison iterations.");
  }
  return {
    id: task.id,
    status: task.status,
    progress: task.progress,
    stages: task.stages,
    midi: task.result.midi,
    synthvImport: imported,
    save: saved,
    iterations,
    outputDirectory: task.result.outputDirectory,
  };
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    const abort = () => done(signal?.reason instanceof Error ? signal.reason : new Error("Cover supervision was cancelled."));
    function done(error?: Error): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    }
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}

function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value) throw new Error(`${name} is invalid.`); return value; }
function isRecord(value: unknown): value is Data { return value !== null && typeof value === "object" && !Array.isArray(value); }

function compactVoiceCatalog(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.slice(0, MAX_TOOL_ARRAY_ITEMS).map(item => isRecord(item)
    ? { id: item.id ?? null, name: item.name ?? null, vendor: item.vendor ?? null }
    : item);
}

function compactToolResult(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:")) return "[binary data omitted]";
    return value.length <= MAX_TOOL_STRING_CHARS ? value : `${value.slice(0, MAX_TOOL_STRING_CHARS)}…[truncated]`;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 6) return "[nested data omitted]";
  if (Array.isArray(value)) {
    const compacted = value.slice(0, MAX_TOOL_ARRAY_ITEMS).map(item => compactToolResult(item, depth + 1));
    return value.length > MAX_TOOL_ARRAY_ITEMS ? [...compacted, `[${value.length - MAX_TOOL_ARRAY_ITEMS} additional items omitted]`] : compacted;
  }
  if (!isRecord(value)) return String(value);
  const entries = Object.entries(value).slice(0, MAX_TOOL_OBJECT_FIELDS);
  const compacted = Object.fromEntries(entries.map(([key, item]) => [key, compactToolResult(item, depth + 1)]));
  if (Object.keys(value).length > MAX_TOOL_OBJECT_FIELDS) compacted.additionalFieldsOmitted = Object.keys(value).length - MAX_TOOL_OBJECT_FIELDS;
  const serialized = JSON.stringify(compacted);
  return serialized.length <= MAX_TOOL_RESULT_CHARS ? compacted : { truncated: true, preview: serialized.slice(0, MAX_TOOL_RESULT_CHARS) };
}
