import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import type { BridgeConfig } from "./config.js";
import { GuardTokenStore } from "./guard-token-store.js";
import { FileIpcClient } from "./ipc/file-ipc-client.js";
import { SidebarStatusMonitor } from "./sidebar-status-monitor.js";
import { collectActionTools } from "./action-tools.js";
import { registerV3Facade, V3_FACADE_INSTRUCTIONS } from "./v3-facade.js";
import { assertV3CommandPolicyCatalog } from "./v3-command-policy.js";
import { WriterLedger } from "./writer-ledger.js";
import type { ActionToolDefinitions, RegisterTool } from "./v3-surface.js";

export interface BridgePublicTool {
  readonly name: string;
  readonly config: {
    readonly title: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly annotations?: ToolAnnotations;
  };
  readonly handler: (input: unknown) => CallToolResult | Promise<CallToolResult>;
}

export interface BridgeCore {
  readonly client: FileIpcClient;
  readonly sidebar: SidebarStatusMonitor;
  readonly actionTools: ActionToolDefinitions;
  readonly publicTools: readonly BridgePublicTool[];
  readonly instructions: string;
  close(): Promise<void>;
}

export function createBridgeCore(
  config: BridgeConfig,
  { clientLabel }: { clientLabel: () => string },
): BridgeCore {
  const client = new FileIpcClient(config, clientLabel);
  const guardTokens = new GuardTokenStore();
  const sidebar = new SidebarStatusMonitor(config);
  const writerLedger = new WriterLedger(config.paths.writerFile, clientLabel);

  const actionTools = collectActionTools({ client, guardTokens, sidebar });
  assertV3CommandPolicyCatalog(actionTools);

  const publicTools: BridgePublicTool[] = [];
  const collect: RegisterTool = <Shape extends z.ZodRawShape | z.ZodType>(
    name: string,
    toolConfig: {
      readonly title: string;
      readonly description: string;
      readonly inputSchema: Shape;
      readonly annotations?: ToolAnnotations;
    },
    handler: (input: any) => CallToolResult | Promise<CallToolResult>,
  ): void => {
    publicTools.push({
      name,
      config: toolConfig as unknown as BridgePublicTool["config"],
      handler: handler as (input: unknown) => CallToolResult | Promise<CallToolResult>,
    });
  };
  registerV3Facade(collect, actionTools, guardTokens, {
    getSessionToken: async () => (await client.getStatus()).status?.sessionToken,
    getSidebarBuildIdentity: async () => sidebar.getRuntimeBuildIdentity(),
    writerLedger,
  });

  sidebar.start();

  return {
    client,
    sidebar,
    actionTools,
    publicTools,
    instructions: V3_FACADE_INSTRUCTIONS,
    close: () => sidebar.stop(),
  };
}
