import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importElectronSource } from "../fixtures/electron-source.mjs";

// Drives the HTTP MCP server with the official TypeScript SDK client (the bridge component's pinned copy), the same
// Streamable HTTP client stack Claude Code, Cursor and VS Code build on, so its schema validation is the compatibility bar.
const sdkRoot = fileURLToPath(new URL("../../src/PiDesktop.Tauri/components/synthv-agent-bridge/node_modules/@modelcontextprotocol/sdk/", import.meta.url));
assert.ok(existsSync(join(sdkRoot, "package.json")), "Run npm run build:bridge first: the bridge component provides @modelcontextprotocol/sdk.");
const sdk = (path) => import(pathToFileURL(join(sdkRoot, "dist/esm", path)).href);
const { Client } = await sdk("client/index.js");
const { StreamableHTTPClientTransport } = await sdk("client/streamableHttp.js");
const { CallToolResultSchema, ErrorCode, LATEST_PROTOCOL_VERSION } = await sdk("types.js");
const { HttpMcpServer } = await importElectronSource("services/http-mcp-server.ts");
const { hostResultToToolResult, toolboxMcpTools } = await importElectronSource("services/mcp-tools.ts");

const token = "sdk-compat-token-0123456789abcdefghijklmnop";
const host = {
  async mcpTools() { return toolboxMcpTools(["toolbox_internal", "toolbox_advanced"]); },
  async callMcpTool(name, args) {
    if (args.operation === "fail") throw new Error("slotId must be a non-empty string.");
    return hostResultToToolResult(args.operation === "processes" ? [{ pid: 101, name: "synthv-studio" }] : { tool: name, operation: args.operation });
  },
  async agentTask(args) { return args.action === "list" ? { tasks: [{ taskId: "task-1", conversationId: "conversation-1", status: "completed" }] } : { taskId: "task-2", conversationId: "conversation-2", status: "running" }; },
  async agentChat() { return []; },
};

async function startServer(t) {
  const server = new HttpMcpServer(host, { name: "toneshuttle", title: "Toneshuttle", version: "9.8.7" });
  const status = await server.start({ enabled: true, agentEnabled: true, internalEnabled: true, advancedEnabled: true, port: 0, token });
  t.after(() => server.stop());
  return status.endpoint;
}

async function connect(t, endpoint, headers) {
  const client = new Client({ name: "sdk-compat-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers } });
  await client.connect(transport);
  t.after(() => client.close());
  return { client, transport };
}

test("the official SDK client connects, lists and calls every tool with schema validation", async (t) => {
  const endpoint = await startServer(t);
  const { client, transport } = await connect(t, endpoint, { Authorization: `Bearer ${token}` });
  assert.equal(transport.protocolVersion, LATEST_PROTOCOL_VERSION, "the SDK's default version is accepted, not downgraded");
  assert.deepEqual(client.getServerVersion(), { name: "toneshuttle", title: "Toneshuttle", version: "9.8.7" });
  assert.match(client.getInstructions(), /toolbox_agent/);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["toolbox_internal", "toolbox_advanced", "toolbox_agent"]);
  const agent = tools.find((tool) => tool.name === "toolbox_agent");
  for (const keyword of ["oneOf", "anyOf", "allOf"]) assert.equal(agent.inputSchema[keyword], undefined, `toolbox_agent inputSchema has no top-level ${keyword}`);
  assert.equal(agent.annotations.readOnlyHint, false);
  assert.equal(tools.find((tool) => tool.name === "toolbox_advanced").annotations.destructiveHint, true);

  const listed = await client.callTool({ name: "toolbox_agent", arguments: { action: "list" } });
  assert.equal(listed.isError, false);
  assert.deepEqual(listed.structuredContent, { tasks: [{ taskId: "task-1", conversationId: "conversation-1", status: "completed" }] });
  assert.deepEqual(JSON.parse(listed.content[0].text), listed.structuredContent);

  const processes = await client.callTool({ name: "toolbox_internal", arguments: { capability: "synthv", operation: "processes", params: {} } });
  assert.deepEqual(processes.structuredContent, { items: [{ pid: 101, name: "synthv-studio" }] });
  assert.equal(CallToolResultSchema.safeParse({ content: processes.content, structuredContent: [{ pid: 101 }] }).success, false, "the SDK would reject an array structuredContent");

  const failed = await client.callTool({ name: "toolbox_advanced", arguments: { capability: "synthv", operation: "fail", params: {} } });
  assert.equal(failed.isError, true);
  assert.deepEqual(failed.content, [{ type: "text", text: "Toolbox operation failed: slotId must be a non-empty string." }]);

  await assert.rejects(() => client.callTool({ name: "toolbox_missing", arguments: {} }), (error) => error.code === ErrorCode.InvalidParams);
  await client.ping();
});

test("the SDK client is refused without the right bearer token", async (t) => {
  const endpoint = await startServer(t);
  for (const headers of [{}, { Authorization: "Bearer not-the-token" }]) {
    const client = new Client({ name: "sdk-compat-test", version: "1.0.0" });
    await assert.rejects(() => client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers } })), (error) => error.code === 401);
    await client.close();
  }
});
