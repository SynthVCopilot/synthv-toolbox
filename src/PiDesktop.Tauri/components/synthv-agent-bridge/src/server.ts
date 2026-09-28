import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createBridgeCore } from "./bridge-core.js";
import {
  SERVER_NAME,
  SERVER_VERSION,
  type BridgeConfig,
} from "./config.js";
import { V3_FACADE_INSTRUCTIONS } from "./v3-facade.js";

export function createServer(config: BridgeConfig): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      websiteUrl: "https://github.com/zhoupengjie/synthv-agent-bridge",
    },
    {
      instructions: V3_FACADE_INSTRUCTIONS,
    },
  );

  const clientLabel = (): string =>
    server.server.getClientVersion()?.name ?? "mcp-client";
  const core = createBridgeCore(config, { clientLabel });

  for (const tool of core.publicTools) {
    server.registerTool(
      tool.name,
      tool.config as never,
      tool.handler as never,
    );
  }

  server.server.onclose = () => {
    void core.close();
  };
  const closeServer = server.close.bind(server);
  let closePromise: Promise<void> | null = null;
  server.close = () => {
    if (closePromise !== null) {
      return closePromise;
    }
    const transportClose = Promise.resolve().then(closeServer);
    const coreClose = core.close();
    closePromise = (async () => {
      const [transportResult, coreResult] = await Promise.allSettled([
        transportClose,
        coreClose,
      ]);
      if (transportResult.status === "rejected") {
        throw transportResult.reason;
      }
      if (coreResult.status === "rejected") {
        throw coreResult.reason;
      }
    })();
    return closePromise;
  };

  return server;
}

export async function runStdioServer(config: BridgeConfig): Promise<void> {
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
