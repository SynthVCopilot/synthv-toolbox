import { BRAND } from "../brand.js";
import type { McpTool } from "./http-mcp-server.js";

export type McpTextContent = { type: "text"; text: string };
export type McpContentBlock = McpTextContent | (Record<string, unknown> & { type: "image" | "audio" | "resource_link" | "resource" });
export type ToolboxMcpToolName = "toolbox_internal" | "toolbox_advanced";

/**
 * Operations HostCapabilities dispatches per MCP permission tier, mapped to the params each one reads.
 * test/electron-http-mcp-server.mjs checks this against host-capabilities.ts and the creative services.
 */
export const TOOLBOX_OPERATIONS: Readonly<Record<ToolboxMcpToolName, Readonly<Record<string, Readonly<Record<string, string>>>>>> = {
  toolbox_internal: {
    synthv: { "profile-state": "", "session-size": "slotId", scan: "", processes: "" },
    creative: Object.fromEntries([
      "list_workflow_recipes", "list_creative_history", "get_project_backup_state", "create_project_checkpoint", "list_project_checkpoints", "restore_project_checkpoint", "export_workflow_report", "run_batch_workflow",
      "create_lyric_project", "save_lyric_project", "load_lyric_project", "list_lyric_projects", "restore_lyric_project_version", "export_lyric_project_text", "build_lyric_template", "lookup_chinese_rhyme",
      "read_lyric_bridge_selection", "preview_lyric_bridge_fit", "confirm_lyric_bridge_fit", "run_score_to_synthv", "run_retake_workbench",
      "run_audio_probe", "run_audio_to_project", "run_game_to_midi", "run_project_probe", "run_project_doctor", "add_project_reference", "export_project_without_parameters", "export_project_lyrics", "run_pronunciation_diagnostics", "run_render_review",
      "media_tasks", "preview_media_source", "queue_media_import", "queue_media_separation", "queue_cover", "cancel_media_task", "retry_media_task",
    ].map((operation) => [operation, ""])),
  },
  toolbox_advanced: {
    network: { fetch: "url, method?, headers?, body?" },
    filesystem: { read: "path", write: "path, content", mkdir: "path", delete: "path" },
    sandbox: { add: "name, root", delete: "name" },
    authorization: { remove: "provider, credentialId", enable: "provider, credentialId, enabled, weight", "add-api-key": "provider, label, apiKey" },
    synthv: { "activate-profile": "slotId", "web-account-query": "slotId" },
  },
};

const toolText: Record<ToolboxMcpToolName, { title: string; summary: string }> = {
  toolbox_internal: {
    title: `${BRAND.productName} operations`,
    summary: `Run a standard ${BRAND.productName} operation: SynthV profile status and the creative audio, score, lyric and project workflows the app's own pages offer (creative params are the workflow's own arguments, such as projectPath, audioPath or outputName).`,
  },
  toolbox_advanced: {
    title: `${BRAND.productName} advanced operations`,
    summary: `Run an advanced ${BRAND.productName} operation that can reach the network, any local file, sandboxes, model credentials or SynthV accounts. Prefer toolbox_internal when it can do the job.`,
  },
};

/** MCP definitions for the privileged tools the runtime host currently enables, in the order given. */
export function toolboxMcpTools(names: string[]): McpTool[] {
  return names.filter((name): name is ToolboxMcpToolName => Object.hasOwn(TOOLBOX_OPERATIONS, name)).map((name) => {
    const capabilities = TOOLBOX_OPERATIONS[name];
    const operations = Object.entries(capabilities).map(([capability, entries]) => `- ${capability}: ${Object.entries(entries).map(([operation, params]) => params ? `${operation} {${params}}` : operation).join(", ")}`);
    return {
      name,
      title: toolText[name].title,
      description: `${toolText[name].summary}\nCall with {capability, operation, params}; params is always an object ({} when the operation takes none).\nOperations by capability, with the params each reads in braces:\n${operations.join("\n")}`,
      inputSchema: {
        type: "object",
        properties: {
          capability: { type: "string", enum: Object.keys(capabilities), description: "Capability group, for example synthv." },
          operation: { type: "string", description: "Operation within the capability, as listed in the tool description." },
          params: { type: "object", description: "Operation parameters; use {} when there are none." },
        },
        required: ["capability", "operation", "params"],
        additionalProperties: false,
      },
      annotations: name === "toolbox_internal"
        ? { title: toolText[name].title, readOnlyHint: false, destructiveHint: false, openWorldHint: false }
        : { title: toolText[name].title, readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      permission: name === "toolbox_internal" ? "internal" : "advanced",
    };
  });
}

/** Flat on purpose: the Anthropic API rejects tool input schemas with a top-level oneOf, anyOf or allOf, so per-action rules live in the description and agent-task-service. */
export function toolboxAgentMcpTool(): McpTool {
  return {
    name: "toolbox_agent",
    title: `${BRAND.productName} agent tasks`,
    description: [
      `Delegate work to the ${BRAND.productName} agent, which uses the app's own model settings to run its audio, score and lyric workflows and, when the SynthV integration is connected, to read and edit the open SynthV project. Runs are asynchronous.`,
      "- start {input}: begin a task in a new conversation; returns taskId and conversationId with status \"running\".",
      "- status {taskId or conversationId}: poll every few seconds until status is no longer \"running\" or \"cancelling\".",
      "- continue {conversationId, input, taskId?}: answer a task whose status is \"needs_input\" (its missing field says what is needed), or follow up on a finished one.",
      "- cancel {taskId or conversationId}: stop a running task.",
      "- list {}: recent tasks, newest first.",
      "Send only the fields the chosen action uses.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "continue", "status", "cancel", "list"], description: "What to do; see the tool description for the fields each action needs." },
        input: { type: "string", description: "Instruction for start or continue, at most 32,000 characters." },
        conversationId: { type: "string", description: "Conversation returned by start; required by continue." },
        taskId: { type: "string", description: "Task returned by start; identifies the task for status, cancel or continue." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { title: `${BRAND.productName} agent tasks`, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  };
}

/** Converts a host capability result to an MCP tool result: JSON text for older clients plus an object-shaped structuredContent. */
export function hostResultToToolResult(result: unknown): { content: McpTextContent[]; structuredContent: Record<string, unknown> } {
  const json = JSON.stringify(result === undefined ? null : result);
  const value: unknown = JSON.parse(json);
  return { content: [{ type: "text", text: typeof value === "string" ? value : json }], structuredContent: toStructuredContent(value) };
}

/** MCP requires structuredContent to be a JSON object. */
export function toStructuredContent(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { items: value };
}

/** Passes through only arrays that are entirely valid MCP content blocks; anything else becomes one JSON text block. */
export function toToolContent(content: unknown): McpContentBlock[] {
  if (Array.isArray(content) && content.length > 0 && content.every(isContentBlock)) return content as McpContentBlock[];
  return [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content) ?? String(content) }];
}

function isContentBlock(value: unknown): boolean {
  if (!isRecord(value) || (value.annotations !== undefined && !isRecord(value.annotations)) || (value._meta !== undefined && !isRecord(value._meta))) return false;
  switch (value.type) {
    case "text": return typeof value.text === "string";
    case "image": case "audio": return typeof value.data === "string" && typeof value.mimeType === "string";
    case "resource_link": return typeof value.uri === "string" && typeof value.name === "string";
    case "resource": return isRecord(value.resource) && typeof value.resource.uri === "string" && (typeof value.resource.text === "string" || typeof value.resource.blob === "string");
    default: return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
