import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(root, "src/PiDesktop.Tauri/electron/services/http-mcp-server.ts"), "utf8");
const executable = stripTypeScriptTypes(source, { mode: "transform" });
const { HttpMcpServer, ClientError } = await import(`data:text/javascript;base64,${Buffer.from(executable).toString("base64")}`);

const authorizations = [];
const calls = [];
const agentTasks = [];
const host = {
  async mcpTools(authorization) {
    authorizations.push({ ...authorization });
    return [
      { name: "public_tool", description: "Public", inputSchema: { type: "object" } },
      { name: "toolbox_internal", description: "Internal", inputSchema: { type: "object" }, permission: "internal" },
      { name: "toolbox_advanced", description: "Advanced", inputSchema: { type: "object" }, permission: "advanced" },
    ];
  },
  async callMcpTool(name, arguments_, authorization) {
    calls.push({ name, arguments_, authorization });
    return { content: `${name}:ok` };
  },
  async agentChat(input, conversationId) {
    return [{ role: "assistant", content: `${conversationId}:${input}` }];
  },
  async agentTask(args) { agentTasks.push(args); const task = { taskId: "task-1", status: "running", ...args }; return args.action === "list" ? [task] : task; },
};
const rpc = async (endpoint, id, method, params = {}) => {
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  return { status: response.status, body: response.status === 202 ? undefined : await response.json() };
};

const server = new HttpMcpServer(host);
let status = await server.start({ enabled: true, agentEnabled: false, internalEnabled: false, advancedEnabled: false, port: 0 });
assert.equal(status.running, true);
assert.match(status.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
assert.equal(status.agentEndpoint, undefined);

let response = await rpc(status.endpoint, 1, "initialize");
assert.equal(response.body.result.protocolVersion, "2025-06-18");
assert.equal(response.body.result.serverInfo.version, "0.2.0");
response = await rpc(status.endpoint, 2, "tools/list");
assert.deepEqual(response.body.result.tools.map((tool) => tool.name), ["public_tool"]);
response = await rpc(status.endpoint, 3, "tools/call", { name: "toolbox_advanced", arguments: { permission: "advanced" } });
assert.ok(response.body.error);
assert.equal(calls.length, 0);
assert.deepEqual(authorizations.at(-1), { internalEnabled: false, advancedEnabled: false });
response = await rpc(status.endpoint, 30, "tools/list");
assert.equal(response.body.result.tools.some((tool) => tool.name === "toolbox_agent"), false);

status = await server.restart({ enabled: true, agentEnabled: true, internalEnabled: true, advancedEnabled: false, port: 0 });
const occupiedPort = Number(new URL(status.endpoint).port);
const competing = new HttpMcpServer(host);
const failed = await competing.start({ enabled: true, agentEnabled: false, internalEnabled: false, advancedEnabled: false, port: occupiedPort });
assert.equal(failed.running, false);
assert.equal(typeof failed.lastError, "string");
response = await rpc(status.endpoint, 4, "tools/list");
assert.deepEqual(response.body.result.tools.map((tool) => tool.name), ["public_tool", "toolbox_internal", "toolbox_agent"]);
assert.equal(response.body.result.tools.some((tool) => tool.name === "toolbox_agent"), true);
const agentSchema = response.body.result.tools.find((tool) => tool.name === "toolbox_agent").inputSchema;
assert.equal(agentSchema.oneOf.length, 5);
response = await rpc(status.endpoint, 40, "tools/call", { name: "toolbox_agent", arguments: { action: "start", input: "do work", permission: "advanced" } });
assert.equal(response.body.result.isError, false);
assert.deepEqual(agentTasks.at(-1), { action: "start", input: "do work" });
assert.deepEqual(response.body.result.content, [{ type: "text", text: JSON.stringify({ taskId: "task-1", status: "running", action: "start", input: "do work" }) }]);
assert.deepEqual(response.body.result.structuredContent, { taskId: "task-1", status: "running", action: "start", input: "do work" });
response = await rpc(status.endpoint, 41, "tools/call", { name: "toolbox_agent", arguments: { action: "list" } });
assert.deepEqual(response.body.result.content, [{ type: "text", text: JSON.stringify([{ taskId: "task-1", status: "running", action: "list" }]) }]);
assert.deepEqual(response.body.result.structuredContent, [{ taskId: "task-1", status: "running", action: "list" }]);
response = await rpc(status.endpoint, 5, "tools/call", { name: "toolbox_internal", arguments: { capability: "host.internal", permission: "advanced" } });
assert.equal(response.body.result.isError, false);
assert.deepEqual(calls.at(-1), { name: "toolbox_internal", arguments_: { capability: "host.internal" }, authorization: { internalEnabled: true, advancedEnabled: false } });

const agent = await fetch(status.agentEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "hello", conversationId: "conversation-1" }) });
assert.deepEqual(await agent.json(), { messages: [{ role: "assistant", content: "conversation-1:hello" }] });
const crossOrigin = await fetch(status.endpoint, { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/list" }) });
assert.equal(crossOrigin.status, 403);
const formPost = await fetch(status.endpoint, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/list" }) });
assert.equal(formPost.status, 415);
const reboundHostStatus = await new Promise((resolve, reject) => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 43, method: "tools/list" });
  const request = httpRequest({ host: "127.0.0.1", port: occupiedPort, path: "/mcp", method: "POST", headers: { host: `evil.example:${occupiedPort}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
  request.on("error", reject);
  request.end(body);
});
assert.equal(reboundHostStatus, 403);
const rawPost = (headers, body = JSON.stringify({ jsonrpc: "2.0", id: 44, method: "tools/list" })) => new Promise((resolve, reject) => {
  const request = httpRequest({ host: "127.0.0.1", port: occupiedPort, path: "/mcp", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers } }, (res) => {
    let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; }); res.on("end", () => resolve({ status: res.statusCode, text }));
  });
  request.on("error", reject);
  request.end(body);
});
assert.equal((await rawPost({ host: `localhost:${occupiedPort}` })).status, 200);
assert.equal((await rawPost({ host: `127.0.0.1:${occupiedPort}`, origin: `http://127.0.0.1:${occupiedPort}` })).status, 200);
assert.equal((await rawPost({ host: `127.0.0.1:${occupiedPort}`, origin: "null" })).status, 403);
assert.equal((await rawPost({ host: `127.0.0.1:${occupiedPort}`, origin: "https://evil.example" })).status, 403);
assert.equal((await rawPost({ host: `127.0.0.1:${occupiedPort + 1}` })).status, 403);
assert.equal((await rawPost({ host: "localhost" })).status, 403);

const secret = "secret-internal-detail";
const originalTools = host.mcpTools;
const originalChat = host.agentChat;
const originalError = console.error;
console.error = () => {};
host.mcpTools = async () => { throw new Error(secret); };
const rpcFailure = await rawPost({ host: `127.0.0.1:${occupiedPort}` });
assert.equal(rpcFailure.status, 200);
assert.equal(JSON.parse(rpcFailure.text).error.code, -32603);
assert.equal(rpcFailure.text.includes(secret), false);
const unhandled = await rawPost({ host: `127.0.0.1:${occupiedPort}` }, JSON.stringify({ jsonrpc: "2.0", id: 45, method: "tools/call", params: { name: "x" } }));
assert.equal(unhandled.text.includes(secret), false);
host.agentChat = async () => { throw new Error(secret); };
const agentFailure = await fetch(status.agentEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "hello" }) });
assert.equal(agentFailure.status, 500);
assert.equal((await agentFailure.text()).includes(secret), false);
host.mcpTools = originalTools;
const originalTask = host.agentTask;
let serializations = 0;
host.agentTask = async () => ({ toJSON() { if (++serializations > 1) throw new Error(secret); return "ok"; } });
const outerFailure = await rawPost({ host: `127.0.0.1:${occupiedPort}` }, JSON.stringify({ jsonrpc: "2.0", id: 46, method: "tools/call", params: { name: "toolbox_agent", arguments: { action: "list" } } }));
assert.equal(outerFailure.status, 500);
assert.equal(outerFailure.text.includes(secret), false);
host.agentTask = async () => { throw new ClientError("Agent task was not found."); };
const staleTask = await rawPost({ host: `127.0.0.1:${occupiedPort}` }, JSON.stringify({ jsonrpc: "2.0", id: 47, method: "tools/call", params: { name: "toolbox_agent", arguments: { action: "status", taskId: "stale" } } }));
const staleBody = JSON.parse(staleTask.text);
assert.equal(staleBody.error, undefined);
assert.equal(staleBody.result.isError, true);
assert.deepEqual(staleBody.result.content, [{ type: "text", text: "Agent task was not found." }]);
host.agentTask = originalTask;
assert.equal(server.server.requestTimeout, 30_000);
assert.ok(server.server.headersTimeout > 0 && server.server.headersTimeout <= 30_000);
host.agentChat = originalChat;
console.error = originalError;

const stopped = await server.stop();
assert.equal(stopped.running, false);
assert.equal(stopped.endpoint, undefined);

console.log("Electron HTTP MCP server binds loopback and enforces runtime host authorization.");
