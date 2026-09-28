import * as fs from "node:fs/promises";

import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { z } from "zod";

import { createBridgeCore, type BridgeCore } from "./bridge-core.js";
import { PUBLIC_MCP_TOOL_NAMES } from "./build-info.js";
import type { BridgeConfig } from "./config.js";
import { loadConfig } from "./config.js";
import type { BridgeStatusSnapshot } from "./ipc/file-ipc-client.js";
import { commandPolicyFor } from "./v3-command-policy.js";

export type EmbeddedBridgeCategory =
  | "read"
  | "uiChange"
  | "projectWrite"
  | "executorControl";

export type EmbeddedBridgeRisk = "normal" | "high";

export interface EmbeddedBridgeClassification {
  readonly category: EmbeddedBridgeCategory;
  readonly risk: EmbeddedBridgeRisk;
}

export interface EmbeddedBridgeTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly inputSchema: Record<string, unknown>;
  call(input: unknown): Promise<{ text: string; isError: boolean }>;
}

export interface EmbeddedBridge {
  readonly tools: readonly EmbeddedBridgeTool[];
  readonly instructions: string;
  classify(name: string, input: unknown): EmbeddedBridgeClassification;
  status(): Promise<BridgeStatusSnapshot>;
  requestStop(): Promise<void>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failedOutcomeEnvelope(
  code: string,
  message: string,
  phase: string,
): string {
  return JSON.stringify({
    outcome: "failed",
    phase,
    wrote: false,
    undoRequired: false,
    retry: "correct_request",
    error: { code, message },
  });
}

function buildTool(
  name: string,
  config: {
    readonly title: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly annotations?: ToolAnnotations;
  },
  handler: (input: unknown) => CallToolResult | Promise<CallToolResult>,
): EmbeddedBridgeTool {
  const schema = z.object(config.inputSchema as z.ZodRawShape);
  const jsonSchema = toJsonSchemaCompat(schema, {
    strictUnions: true,
    pipeStrategy: "input",
  }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return {
    name,
    title: config.title,
    description: config.description,
    annotations: config.annotations ?? {},
    inputSchema: jsonSchema,
    async call(input: unknown): Promise<{ text: string; isError: boolean }> {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return {
          text: failedOutcomeEnvelope(
            "INVALID_ARGUMENT",
            `Invalid arguments for ${name}`,
            "accepted",
          ),
          isError: true,
        };
      }
      const result = await handler(parsed.data);
      const block = result.content.find(
        (entry): entry is { type: "text"; text: string } =>
          entry.type === "text" && typeof (entry as { text?: unknown }).text === "string",
      );
      return {
        text: block?.text ?? "",
        isError: result.isError === true,
      };
    },
  };
}

function classifyFromCore(
  core: BridgeCore,
  name: string,
  input: unknown,
): EmbeddedBridgeClassification {
  const args = isRecord(input) ? input : {};

  if (name === "sv_command") {
    const action = typeof args.action === "string" ? args.action : undefined;
    const commandArgs = isRecord(args.args) ? args.args : {};
    let risk: EmbeddedBridgeRisk = "normal";
    if (action !== undefined) {
      try {
        const policy = commandPolicyFor(action);
        if (
          policy.category === "delete" ||
          policy.category === "transaction" ||
          commandArgs.sharedGroupPolicy === "allowAllReferences"
        ) {
          risk = "high";
        }
      } catch {
        risk = "normal";
      }
    }
    return { category: "projectWrite", risk };
  }

  if (name === "sv_ui") {
    const action = typeof args.action === "string" ? args.action : undefined;
    const actionTool = action === undefined ? undefined : core.actionTools.get(action);
    if (actionTool?.annotations?.readOnlyHint === true) {
      return { category: "read", risk: "normal" };
    }
    return { category: "uiChange", risk: "normal" };
  }

  if (name === "sv_status") {
    const operation = typeof args.operation === "string" ? args.operation : "bridge";
    if (operation === "reload") {
      return { category: "executorControl", risk: "high" };
    }
    return { category: "read", risk: "normal" };
  }

  return { category: "read", risk: "normal" };
}

export function createEmbeddedBridge(options: {
  readonly config?: BridgeConfig;
  readonly clientLabel: string;
}): EmbeddedBridge {
  const config = options.config ?? loadConfig();
  const core = createBridgeCore(config, {
    clientLabel: () => options.clientLabel,
  });

  const toolsByName = new Map<string, EmbeddedBridgeTool>();
  for (const publicTool of core.publicTools) {
    toolsByName.set(
      publicTool.name,
      buildTool(publicTool.name, publicTool.config, publicTool.handler),
    );
  }
  const tools = PUBLIC_MCP_TOOL_NAMES.map((name) => {
    const tool = toolsByName.get(name);
    if (tool === undefined) {
      throw new Error(`Embedded bridge is missing the public tool: ${name}`);
    }
    return tool;
  });

  return {
    tools,
    instructions: core.instructions,
    classify: (name, input) => classifyFromCore(core, name, input),
    status: () => core.client.getStatus(),
    requestStop: async () => {
      await fs.mkdir(config.paths.directory, { recursive: true });
      await fs.writeFile(config.paths.stopFile, "", "utf8");
    },
    close: () => core.close(),
  };
}
