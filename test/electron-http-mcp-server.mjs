import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { importElectronSource } from "./fixtures/electron-source.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { HttpMcpServer, ClientError, SUPPORTED_MCP_PROTOCOL_VERSIONS } = await importElectronSource("services/http-mcp-server.ts");
const { TOOLBOX_OPERATIONS, hostResultToToolResult, toToolContent, toolboxMcpTools } = await importElectronSource("services/mcp-tools.ts");

const token = "test-token-0123456789abcdefghijklmnopqrstuv";
const authorization = { authorization: `Bearer ${token}` };
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
    if (arguments_.operation === "processes") return hostResultToToolResult([{ pid: 1 }, { pid: 2 }]);
    return { content: `${name}:ok` };
  },
  async agentChat(input, conversationId) {
    return [{ role: "assistant", content: `${conversationId}:${input}` }];
  },
  async agentTask(args) { agentTasks.push(args); const task = { taskId: "task-1", status: "running", ...args }; return args.action === "list" ? { tasks: [task] } : task; },
};
const post = (endpoint, body, headers = {}) => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", ...authorization, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const rpc = async (endpoint, id, method, params = {}, headers = {}) => {
  const response = await post(endpoint, { jsonrpc: "2.0", id, method, params }, headers);
  return { status: response.status, body: response.status === 202 ? undefined : await response.json() };
};
const config = (overrides = {}) => ({ enabled: true, agentEnabled: false, internalEnabled: false, advancedEnabled: false, port: 0, token, ...overrides });

const server = new HttpMcpServer(host);
let status = await server.start(config());
assert.equal(status.running, true);
assert.equal(status.serverName, "toneshuttle");
assert.match(status.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
assert.equal(status.agentEndpoint, undefined);

let response = await rpc(status.endpoint, 1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
assert.equal(response.body.result.protocolVersion, "2025-11-25");
assert.deepEqual(response.body.result.serverInfo, { name: "toneshuttle", title: "Toneshuttle", version: "0.0.0" });
assert.match(response.body.result.instructions, /toolbox_agent[\s\S]*status[\s\S]*\{capability, operation, params\}/);
assert.equal((await rpc(status.endpoint, 11, "initialize", { protocolVersion: "2025-03-26" })).body.result.protocolVersion, "2025-03-26");
assert.equal((await rpc(status.endpoint, 12, "initialize", { protocolVersion: "2099-01-01" })).body.result.protocolVersion, "2025-06-18");
assert.equal((await rpc(status.endpoint, 13, "initialize")).body.result.protocolVersion, "2025-06-18");
assert.deepEqual(SUPPORTED_MCP_PROTOCOL_VERSIONS, ["2025-11-25", "2025-06-18", "2025-03-26"]);
response = await rpc(status.endpoint, 2, "tools/list");
assert.deepEqual(response.body.result.tools.map((tool) => tool.name), ["public_tool"]);
response = await rpc(status.endpoint, 3, "tools/call", { name: "toolbox_advanced", arguments: { permission: "advanced" } });
assert.equal(response.body.error.code, -32602);
assert.equal(calls.length, 0);
assert.deepEqual(authorizations.at(-1), { internalEnabled: false, advancedEnabled: false });
response = await rpc(status.endpoint, 30, "tools/list");
assert.equal(response.body.result.tools.some((tool) => tool.name === "toolbox_agent"), false);

const firstListener = server.server;
status = await server.start(config());
assert.equal(server.server, firstListener, "an unchanged config keeps the running listener");
status = await server.start(config({ agentEnabled: true, internalEnabled: true }));
assert.notEqual(server.server, firstListener);
const occupiedPort = Number(new URL(status.endpoint).port);
const competing = new HttpMcpServer(host);
const failed = await competing.start(config({ port: occupiedPort }));
assert.equal(failed.running, false);
assert.equal(typeof failed.lastError, "string");
await assert.rejects(() => competing.start(config({ token: "" })), /bearer token is required/);
response = await rpc(status.endpoint, 4, "tools/list");
assert.deepEqual(response.body.result.tools.map((tool) => tool.name), ["public_tool", "toolbox_internal", "toolbox_agent"]);
assert.equal(response.body.result.tools.some((tool) => "permission" in tool), false);
const agentTool = response.body.result.tools.find((tool) => tool.name === "toolbox_agent");
for (const keyword of ["oneOf", "anyOf", "allOf"]) assert.equal(keyword in agentTool.inputSchema, false, `toolbox_agent inputSchema must not use top-level ${keyword}`);
assert.deepEqual(agentTool.inputSchema.properties.action.enum, ["start", "continue", "status", "cancel", "list"]);
assert.deepEqual(agentTool.inputSchema.required, ["action"]);
assert.equal(agentTool.inputSchema.additionalProperties, false);
assert.equal(agentTool.title, "Toneshuttle agent tasks");
assert.equal(agentTool.annotations.readOnlyHint, false);
assert.match(agentTool.description, /status \{taskId or conversationId\}/);
response = await rpc(status.endpoint, 40, "tools/call", { name: "toolbox_agent", arguments: { action: "start", input: "do work", permission: "advanced" } });
assert.equal(response.body.result.isError, false);
assert.deepEqual(agentTasks.at(-1), { action: "start", input: "do work" });
assert.deepEqual(response.body.result.content, [{ type: "text", text: JSON.stringify({ taskId: "task-1", status: "running", action: "start", input: "do work" }) }]);
assert.deepEqual(response.body.result.structuredContent, { taskId: "task-1", status: "running", action: "start", input: "do work" });
response = await rpc(status.endpoint, 41, "tools/call", { name: "toolbox_agent", arguments: { action: "list" } });
assert.deepEqual(response.body.result.content, [{ type: "text", text: JSON.stringify({ tasks: [{ taskId: "task-1", status: "running", action: "list" }] }) }]);
assert.deepEqual(response.body.result.structuredContent, { tasks: [{ taskId: "task-1", status: "running", action: "list" }] });
response = await rpc(status.endpoint, 5, "tools/call", { name: "toolbox_internal", arguments: { capability: "host.internal", permission: "advanced" } });
assert.equal(response.body.result.isError, false);
assert.deepEqual(response.body.result.content, [{ type: "text", text: "toolbox_internal:ok" }]);
assert.equal("structuredContent" in response.body.result, false);
assert.deepEqual(calls.at(-1), { name: "toolbox_internal", arguments_: { capability: "host.internal" }, authorization: { internalEnabled: true, advancedEnabled: false } });
response = await rpc(status.endpoint, 6, "tools/call", { name: "toolbox_internal", arguments: { capability: "synthv", operation: "processes", params: {} } });
assert.deepEqual(response.body.result.structuredContent, { items: [{ pid: 1 }, { pid: 2 }] });
assert.deepEqual(response.body.result.content, [{ type: "text", text: JSON.stringify([{ pid: 1 }, { pid: 2 }]) }]);
response = await rpc(status.endpoint, 7, "tools/call", { name: "missing_tool", arguments: {} });
assert.equal(response.body.error.code, -32602);

const agent = await post(status.agentEndpoint, { input: "hello", conversationId: "conversation-1" });
assert.deepEqual(await agent.json(), { messages: [{ role: "assistant", content: "conversation-1:hello" }] });
const crossOrigin = await fetch(status.endpoint, { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/list" }) });
assert.equal(crossOrigin.status, 403, "loopback checks run before authentication");
const formPost = await post(status.endpoint, JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/list" }), { "content-type": "text/plain" });
assert.equal(formPost.status, 415);
const reboundHostStatus = await new Promise((resolve, reject) => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 43, method: "tools/list" });
  const request = httpRequest({ host: "127.0.0.1", port: occupiedPort, path: "/mcp", method: "POST", headers: { host: `evil.example:${occupiedPort}`, "content-type": "application/json", "content-length": Buffer.byteLength(body), ...authorization } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
  request.on("error", reject);
  request.end(body);
});
assert.equal(reboundHostStatus, 403);
const rawPost = (headers, body = JSON.stringify({ jsonrpc: "2.0", id: 44, method: "tools/list" }), path = "/mcp", method = "POST") => new Promise((resolve, reject) => {
  const merged = Object.fromEntries(Object.entries({ "content-type": "application/json", "content-length": Buffer.byteLength(body), ...authorization, ...headers }).filter(([, value]) => value !== undefined));
  const request = httpRequest({ host: "127.0.0.1", port: occupiedPort, path, method, headers: merged }, (res) => {
    let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; }); res.on("end", () => resolve({ status: res.statusCode, text, headers: res.headers }));
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

const loopback = { host: `127.0.0.1:${occupiedPort}` };
for (const [label, value] of [["missing", undefined], ["wrong", `Bearer ${token.slice(0, -1)}x`], ["short", "Bearer abc"], ["basic", `Basic ${token}`]]) {
  const denied = await rawPost({ ...loopback, authorization: value });
  assert.equal(denied.status, 401, `${label} token is rejected`);
  assert.equal(denied.headers["www-authenticate"], 'Bearer realm="toneshuttle"');
  assert.equal(typeof JSON.parse(denied.text).error, "string");
}
assert.equal((await rawPost({ ...loopback, authorization: `bearer ${token}` })).status, 200, "the auth scheme is case-insensitive");
assert.equal((await rawPost({ ...loopback, authorization: undefined }, JSON.stringify({ input: "hi" }), "/agent")).status, 401);
assert.equal((await rawPost({ ...loopback, authorization: undefined }, "", "/mcp", "GET")).status, 401);
const getStream = await rawPost(loopback, "", "/mcp", "GET");
assert.equal(getStream.status, 405);
assert.equal(getStream.headers.allow, "POST");

const parseError = await rawPost(loopback, "{");
assert.equal(parseError.status, 400);
assert.deepEqual(JSON.parse(parseError.text), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
const notification = await rawPost(loopback, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
assert.equal(notification.status, 202);
assert.equal(notification.text, "");
const clientResponse = await rawPost(loopback, JSON.stringify({ jsonrpc: "2.0", id: "server-1", result: {} }));
assert.equal(clientResponse.status, 202);
assert.equal(clientResponse.text, "");
const batch = await rawPost(loopback, JSON.stringify([{ jsonrpc: "2.0", id: 60, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 61, method: "resources/list" }, { id: 62 }]));
assert.equal(batch.status, 200);
assert.deepEqual(JSON.parse(batch.text), [{ jsonrpc: "2.0", id: 60, result: {} }, { jsonrpc: "2.0", id: 61, error: { code: -32601, message: "Method not found." } }, { jsonrpc: "2.0", id: 62, error: { code: -32600, message: "Invalid JSON-RPC request." } }]);
assert.equal((await rawPost(loopback, JSON.stringify([{ jsonrpc: "2.0", method: "notifications/initialized" }]))).status, 202);
assert.equal((await rawPost(loopback, "[]")).status, 400);
const invalidRequest = await rawPost(loopback, JSON.stringify({ id: 45, method: "tools/list" }));
assert.equal(invalidRequest.status, 400);
assert.equal(JSON.parse(invalidRequest.text).error.code, -32600);
const unsupportedVersion = await rawPost({ ...loopback, "mcp-protocol-version": "2024-01-01" });
assert.equal(unsupportedVersion.status, 400);
assert.equal(JSON.parse(unsupportedVersion.text).id, 44);
assert.equal(JSON.parse(unsupportedVersion.text).error.code, -32600);
assert.equal((await rawPost({ ...loopback, "mcp-protocol-version": "2025-06-18" })).status, 200);
assert.equal((await rawPost({ ...loopback, "mcp-protocol-version": "2024-01-01" }, JSON.stringify({ jsonrpc: "2.0", id: 46, method: "initialize", params: {} }))).status, 200, "initialize negotiates instead of rejecting");
const multibyte = await rawPost(loopback, JSON.stringify({ jsonrpc: "2.0", id: 47, method: "ping", params: { padding: "é".repeat(600_000) } }));
assert.equal(multibyte.status, 413, "the size limit counts bytes, not UTF-16 units");
assert.equal((await rawPost(loopback, JSON.stringify({ jsonrpc: "2.0", id: 48, method: "ping", params: { padding: "e".repeat(600_000) } }))).status, 200);

const secret = "secret-internal-detail";
const originalTools = host.mcpTools;
const originalChat = host.agentChat;
const originalCall = host.callMcpTool;
const originalError = console.error;
console.error = () => {};
host.mcpTools = async () => { throw new Error(secret); };
const rpcFailure = await rawPost(loopback);
assert.equal(rpcFailure.status, 200);
assert.equal(JSON.parse(rpcFailure.text).error.code, -32603);
assert.equal(rpcFailure.text.includes(secret), false);
const unhandled = await rawPost(loopback, JSON.stringify({ jsonrpc: "2.0", id: 45, method: "tools/call", params: { name: "x" } }));
assert.equal(unhandled.text.includes(secret), false);
host.agentChat = async () => { throw new Error(secret); };
const agentFailure = await post(status.agentEndpoint, { input: "hello" });
assert.equal(agentFailure.status, 500);
assert.equal((await agentFailure.text()).includes(secret), false);
host.agentChat = async () => { throw new ClientError("An agent task is already running for this conversation."); };
const agentConflict = await post(status.agentEndpoint, { input: "hello", conversationId: "busy" });
assert.equal(agentConflict.status, 409);
assert.deepEqual(await agentConflict.json(), { error: "An agent task is already running for this conversation." });
host.mcpTools = originalTools;
host.callMcpTool = async () => { throw new Error("slotId must be a non-empty string."); };
const failedCall = JSON.parse((await rawPost(loopback, JSON.stringify({ jsonrpc: "2.0", id: 49, method: "tools/call", params: { name: "toolbox_internal", arguments: { capability: "synthv", operation: "session-size", params: {} } } }))).text);
assert.equal(failedCall.error, undefined);
assert.deepEqual(failedCall.result, { content: [{ type: "text", text: "Toolbox operation failed: slotId must be a non-empty string." }], isError: true });
host.callMcpTool = originalCall;
const originalTask = host.agentTask;
host.agentTask = async () => { throw new ClientError("Agent task was not found."); };
const staleTask = await rawPost(loopback, JSON.stringify({ jsonrpc: "2.0", id: 47, method: "tools/call", params: { name: "toolbox_agent", arguments: { action: "status", taskId: "stale" } } }));
const staleBody = JSON.parse(staleTask.text);
assert.equal(staleBody.error, undefined);
assert.equal(staleBody.result.isError, true);
assert.deepEqual(staleBody.result.content, [{ type: "text", text: "Agent task was not found." }]);
host.agentTask = originalTask;
host.agentChat = originalChat;
console.error = originalError;

const rotated = await server.start(config({ agentEnabled: true, internalEnabled: true, token: `${token}-rotated` }));
assert.equal((await rpc(rotated.endpoint, 50, "ping")).status, 401, "a changed token restarts the server and retires the old one");
assert.equal((await rpc(rotated.endpoint, 51, "ping", {}, { authorization: `Bearer ${token}-rotated` })).status, 200);

const stopped = await server.stop();
assert.equal(stopped.running, false);
assert.equal(stopped.endpoint, undefined);

console.log("Electron HTTP MCP server binds loopback, requires its bearer token and enforces runtime host authorization.");

test("server identity comes from the constructor", async (t) => {
  const named = new HttpMcpServer(host, { name: "toneshuttle", title: "Toneshuttle", version: "1.4.0", instructions: "Custom." });
  t.after(() => named.stop());
  const { endpoint } = await named.start(config());
  const { body } = await rpc(endpoint, 1, "initialize", { protocolVersion: "2025-06-18" });
  assert.deepEqual(body.result.serverInfo, { name: "toneshuttle", title: "Toneshuttle", version: "1.4.0" });
  assert.equal(body.result.instructions, "Custom.");
});

test("response serialization failures preserve the JSON-RPC request id and hide internal details", async (t) => {
  t.mock.method(console, "error", () => {});
  const failing = { toJSON() { throw new Error(secret); } };
  const server = new HttpMcpServer({ ...host, async agentTask() { return failing; }, async callMcpTool() { return { content: "ok", structuredContent: failing }; } });
  t.after(() => server.stop());
  const status = await server.start(config({ agentEnabled: true, internalEnabled: true }));
  const converted = await rpc(status.endpoint, 46, "tools/call", { name: "toolbox_agent", arguments: { action: "list" } });
  assert.equal(converted.status, 200);
  assert.deepEqual(converted.body, { jsonrpc: "2.0", id: 46, error: { code: -32603, message: "Internal error." } });
  const sent = await rpc(status.endpoint, "call-47", "tools/call", { name: "toolbox_internal", arguments: { capability: "synthv", operation: "scan", params: {} } });
  assert.equal(sent.status, 500);
  assert.deepEqual(sent.body, { jsonrpc: "2.0", id: "call-47", error: { code: -32603, message: "Internal error." } });
  assert.equal(JSON.stringify([converted.body, sent.body]).includes(secret), false);
});

test("an unfinished request body times out before it can invoke a tool", { timeout: 70_000 }, async (t) => {
  let calls = 0;
  const server = new HttpMcpServer({ async mcpTools() { calls++; return []; }, async callMcpTool() { throw new Error("must not run"); } });
  const status = await server.start(config());
  let request;
  t.after(async () => { request?.destroy(); await server.stop(); });
  const response = await new Promise((resolve, reject) => {
    request = httpRequest(status.endpoint, { method: "POST", headers: { "content-type": "application/json", "content-length": 100, ...authorization } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", reject);
    request.write("{");
  });
  assert.equal(response, 408);
  assert.equal(calls, 0);
});

test("toolbox tool definitions describe every supported operation and carry annotations", () => {
  const tools = toolboxMcpTools(["toolbox_advanced", "toolbox_internal", "toolbox_unknown"]);
  assert.deepEqual(tools.map((tool) => [tool.name, tool.permission]), [["toolbox_advanced", "advanced"], ["toolbox_internal", "internal"]]);
  const [advanced, internal] = tools;
  assert.deepEqual(internal.inputSchema, {
    type: "object",
    properties: {
      capability: { type: "string", enum: ["synthv", "creative"], description: internal.inputSchema.properties.capability.description },
      operation: { type: "string", description: internal.inputSchema.properties.operation.description },
      params: { type: "object", description: internal.inputSchema.properties.params.description },
    },
    required: ["capability", "operation", "params"],
    additionalProperties: false,
  });
  assert.deepEqual(advanced.inputSchema.properties.capability.enum, ["network", "filesystem", "sandbox", "authorization", "synthv"]);
  assert.deepEqual(internal.annotations, { title: internal.title, readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  assert.deepEqual(advanced.annotations, { title: advanced.title, readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  assert.match(internal.description, /- synthv: profile-state, session-size \{slotId\}, scan, processes/);
  assert.match(advanced.description, /- filesystem: read \{path\}, write \{path, content\}, mkdir \{path\}, delete \{path\}/);
  for (const [name, capabilities] of Object.entries(TOOLBOX_OPERATIONS)) {
    const description = tools.find((tool) => tool.name === name).description;
    for (const [capability, operations] of Object.entries(capabilities)) for (const operation of Object.keys(operations)) assert.ok(description.includes(operation), `${name} describes ${capability}.${operation}`);
  }
});

test("the documented operations match what HostCapabilities and the creative services dispatch", async () => {
  const services = join(root, "src/PiDesktop.Tauri/electron/services");
  const capabilities = await readFile(join(services, "host-capabilities.ts"), "utf8");
  const dispatched = (method) => {
    const start = capabilities.indexOf(`private async ${method}(`);
    const body = capabilities.slice(start, capabilities.indexOf("\n  }\n", start));
    const pairs = {};
    let current;
    for (const match of body.matchAll(/capability === "([^"]+)"|operation === "([^"]+)"/g)) {
      if (match[1]) pairs[current = match[1]] ??= [];
      else pairs[current].push(match[2]);
    }
    return pairs;
  };
  const documented = (tool) => Object.fromEntries(Object.entries(TOOLBOX_OPERATIONS[tool]).map(([capability, operations]) => [capability, Object.keys(operations)]));
  const internal = dispatched("internal");
  assert.deepEqual(internal.creative, [], "creative forwards any operation to CreativeService");
  assert.deepEqual({ ...documented("toolbox_internal"), creative: [] }, internal);
  assert.deepEqual(documented("toolbox_advanced"), dispatched("advanced"));
  const creativeSources = (await Promise.all(["creative-service.ts", "lyric-service.ts", "creative-bridge.ts", "cover-service.ts", "component-executor.ts"].map((file) => readFile(join(services, file), "utf8")))).join("\n");
  for (const operation of Object.keys(TOOLBOX_OPERATIONS.toolbox_internal.creative)) assert.ok(creativeSources.includes(`"${operation}"`), `creative.${operation} is handled by a creative service`);
});

test("host results always become object structuredContent and valid content blocks", () => {
  assert.deepEqual(hostResultToToolResult({ ok: true }), { content: [{ type: "text", text: "{\"ok\":true}" }], structuredContent: { ok: true } });
  assert.deepEqual(hostResultToToolResult([1, 2]), { content: [{ type: "text", text: "[1,2]" }], structuredContent: { items: [1, 2] } });
  assert.deepEqual(hostResultToToolResult("done"), { content: [{ type: "text", text: "done" }], structuredContent: { items: "done" } });
  assert.deepEqual(hostResultToToolResult(undefined), { content: [{ type: "text", text: "null" }], structuredContent: { items: null } });
  const blocks = [{ type: "text", text: "a" }, { type: "image", data: "AA==", mimeType: "image/png" }, { type: "resource_link", uri: "file:///a", name: "a" }, { type: "resource", resource: { uri: "file:///b", text: "b" } }];
  assert.equal(toToolContent(blocks), blocks);
  assert.deepEqual(toToolContent([{ type: "text", text: "a" }, { pid: 1 }]), [{ type: "text", text: "[{\"type\":\"text\",\"text\":\"a\"},{\"pid\":1}]" }]);
  assert.deepEqual(toToolContent([]), [{ type: "text", text: "[]" }]);
  assert.deepEqual(toToolContent([{ type: "text", text: 1 }]), [{ type: "text", text: "[{\"type\":\"text\",\"text\":1}]" }]);
});
