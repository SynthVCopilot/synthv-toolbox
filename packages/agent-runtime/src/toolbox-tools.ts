import { Type } from "@earendil-works/pi-ai";
import type { JsonValue } from "@synthv-toolbox/runtime-protocol";

export interface ToolboxToolTransport {
  request(method: string, params: JsonValue): Promise<JsonValue>;
}

type Data = Record<string, unknown>;

export function createToolboxTools(host?: ToolboxToolTransport): unknown[] {
  if (!host) return [];
  const invoke = async (command: string, args: Data): Promise<Data> => {
    const result = await host.request("host.toolbox.invoke", { command, args } as JsonValue);
    return result as Data;
  };
  const result = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: value });
  return [
    {
      name: "start_cover_job",
      label: "Start Cover Job",
      description: "Start the durable local Cover workflow: acquire a rights-cleared source, prepare vocals, convert voice to MIDI, import into the selected running Synthesizer V Studio 2 project, save, export WAV, compare it with the reference, and optionally refine it for several iterations. Use sourceMode=vocal for an a-cappella source and mixed for a full mix. The source must be user-owned or openly licensed, and the target project must already be saved once.",
      promptSnippet: "Start and supervise a recoverable end-to-end SynthV Cover job.",
      promptGuidelines: ["Never claim a Cover completed until the returned job reaches completed and contains export plus comparison artifacts.", "If a job fails, inspect the exact failed stage, repair the stated prerequisite, then retry the same job so verified checkpoints are reused."],
      parameters: Type.Object({
        source: Type.String({ minLength: 1, maxLength: 2048 }),
        lyrics: Type.Optional(Type.String({ maxLength: 262144 })),
        voiceName: Type.String({ minLength: 1, maxLength: 200 }),
        processId: Type.Optional(Type.Integer({ minimum: 1 })),
        trackIndex: Type.Integer({ minimum: 1, maximum: 10000, default: 1 }),
        groupName: Type.String({ minLength: 1, maxLength: 200, default: "Toolbox Cover" }),
        rightsConfirmed: Type.Literal(true),
        tolerance: Type.Number({ minimum: 0.02, maximum: 0.25, default: 0.08 }),
        advanced: Type.Boolean({ default: true }),
        sourceMode: Type.Union([Type.Literal("mixed"), Type.Literal("vocal")], { default: "mixed" }),
        refinementIterations: Type.Integer({ minimum: 0, maximum: 8, default: 2 }),
      }, { additionalProperties: false }),
      execute: async (_toolCallId: string, params: Data) => result(await invoke("queue_cover", { request: params })),
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
      description: "Retry a failed or cancelled Cover job from its last verified stage without repeating completed downloads or conversions.",
      parameters: Type.Object({ taskId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      execute: async (_toolCallId: string, params: Data) => result(await invoke("retry_media_task", params)),
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
        voices: await invoke("sv2_voice_catalog", {}),
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
