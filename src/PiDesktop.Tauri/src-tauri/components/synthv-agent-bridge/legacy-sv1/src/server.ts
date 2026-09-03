import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { loadLegacyConfig } from "./config.js";
import { LegacyIpcClient, LegacyIpcError } from "./ipc.js";

const index = z.number().int().min(0);
const blick = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const pitchOffset = z.number().int().min(-127).max(127);
const text = z.string().min(1).max(512);
const toolInputs = {
  "studio.connect": {}, "studio.disconnect": {}, "studio.get_status": {}, "project.get": {}, "sequence.get": {}, "transport.get": {}, "transport.play": {}, "transport.pause": {}, "transport.stop": {},
  "transport.seek": { seconds: z.number().finite().min(0) },
  "track.list": {}, "track.get": { trackIndex: index }, "track.create": { name: text.optional() }, "track.update": { trackIndex: index, name: text }, "track.delete": { trackIndex: index },
  "part.list": { trackIndex: index }, "part.get": { trackIndex: index, partIndex: index },
  "part.create": { trackIndex: index, name: text.optional(), timeOffset: blick.optional(), pitchOffset: pitchOffset.optional() },
  "part.update": { trackIndex: index, partIndex: index, changes: z.object({ name: text.optional(), timeOffset: blick.optional(), pitchOffset: pitchOffset.optional() }).refine((value) => value.name !== undefined || value.timeOffset !== undefined || value.pitchOffset !== undefined, "changes must include name, timeOffset, or pitchOffset") },
  "part.delete": { trackIndex: index, partIndex: index },
  "note.list": { trackIndex: index, partIndex: index },
  "note.create": { trackIndex: index, partIndex: index, onset: blick, duration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), pitch: z.number().int().min(0).max(127), lyrics: z.string().max(4096).optional(), phonemes: z.string().max(4096).optional() },
  "note.update": { trackIndex: index, partIndex: index, noteIndex: index, changes: z.object({ onset: blick.optional(), duration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), pitch: z.number().int().min(0).max(127).optional(), lyrics: z.string().max(4096).optional(), phonemes: z.string().max(4096).optional() }).refine((value) => Object.values(value).some((entry) => entry !== undefined), "changes must include at least one note field") },
  "note.delete": { trackIndex: index, partIndex: index, noteIndex: index },
} as const;
export type LegacyToolName = keyof typeof toolInputs;
export const legacyToolNames = Object.keys(toolInputs) as LegacyToolName[];
const writeTools = new Set<LegacyToolName>(["transport.play", "transport.pause", "transport.stop", "transport.seek", "track.create", "track.update", "track.delete", "part.create", "part.update", "part.delete", "note.create", "note.update", "note.delete"]);

function errorResult(error: unknown): ToolResult {
  const publicError = error instanceof LegacyIpcError ? { code: error.code, message: error.message } : { code: "INTERNAL_ERROR", message: "Legacy bridge request failed." };
  return { content: [{ type: "text", text: JSON.stringify({ error: publicError }) }], isError: true };
}

type ToolResult = { readonly content: readonly [{ readonly type: "text"; readonly text: string }]; readonly isError?: true };
type RegisterTool = (name: LegacyToolName, description: string, schema: (typeof toolInputs)[LegacyToolName], callback: (args: Record<string, unknown>) => Promise<ToolResult>) => unknown;
const success = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

export function createLegacyServer(client = new LegacyIpcClient(loadLegacyConfig())): McpServer {
  const server = new McpServer({ name: "synthv-agent-bridge-sv1-legacy", version: "1.0.0" });
  const registerTool = server.tool as unknown as RegisterTool;
  for (const name of legacyToolNames) {
    registerTool(name, `SV1 standard operation: ${name}`, toolInputs[name], async (args) => {
      try {
        if (name === "studio.disconnect") return success(await client.disconnect());
        const { changes, ...direct } = args as Record<string, unknown> & { changes?: Record<string, unknown> };
        const result = name === "studio.connect" || name === "studio.get_status" ? await client.status() : await client.call(name, { ...direct, ...changes, writeIntent: writeTools.has(name) });
        return success(result);
      } catch (error) { return errorResult(error); }
    });
  }
  return server;
}

export async function runLegacyStdioServer(): Promise<void> {
  const server = createLegacyServer();
  await server.connect(new StdioServerTransport());
}
