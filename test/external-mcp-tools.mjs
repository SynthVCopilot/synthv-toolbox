import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { BRAND } from "../src/PiDesktop.Tauri/dist/electron/brand.js";
import { createExternalMcpToolsExtension, EXTERNAL_TOOL_OUTPUT_LIMIT, ExternalMcpPool, externalToolNames, mcpServerConfigs, renderMcpResult, toolParameters } from "../src/PiDesktop.Tauri/dist/electron/services/external-mcp-tools.js";
import { McpStdioClient } from "../src/PiDesktop.Tauri/dist/electron/services/mcp-stdio-client.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixture = join(testDirectory, "fixtures", "external-mcp-server.mjs");
const LONG_NAME = "weird tool/name.with:odd chars and a very long suffix that keeps going far beyond any provider limit";
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const FIXTURE_TOOLS = 11;

// Orphans are found through WMI, whose first query on a fresh CI runner can outlast the reaping timeout. Warming it up here
// keeps these tests about the reaping logic rather than WMI start-up time.
if (process.platform === "win32") {
  const { spawnSync } = await import("node:child_process");
  spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Out-Null"], { stdio: "ignore", timeout: 120_000, windowsHide: true });
}
// Pi validates tool arguments with this before execute; its install location depends on npm hoisting.
const piValidation = ["packages/agent-runtime/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai", "packages/agent-runtime/node_modules/@earendil-works/pi-ai", "node_modules/@earendil-works/pi-ai"]
  .map(path => join(testDirectory, "..", path, "dist", "utils", "validation.js")).find(path => existsSync(path));

const server = (id, name, ...flags) => ({ id, name, command: process.execPath, args: [fixture, "--name", id, ...flags], enabled: true });
const idHash = id => createHash("sha256").update(id).digest("hex").slice(0, 4);
const output = result => result.content.map(block => block.text).join("");
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitDead(pid, ms = 8_000) { const end = Date.now() + ms; while (alive(pid) && Date.now() < end) await delay(50); return !alive(pid); }

async function open(pool, servers, mode = "edit") {
  let workMode = mode;
  const tools = new Map(), handlers = {};
  await createExternalMcpToolsExtension({ pool, servers: () => servers, workMode: () => workMode }).factory({ on: (event, handler) => { handlers[event] = handler; }, registerTool: tool => { assert.ok(!tools.has(tool.name), `duplicate tool ${tool.name}`); tools.set(tool.name, tool); } });
  return {
    tools,
    setMode: next => { workMode = next; },
    prompt: () => handlers.before_agent_start?.({ systemPrompt: "BASE" }).systemPrompt ?? "BASE",
    run: (name, args = {}, signal) => { const tool = tools.get(name); assert.ok(tool, `missing tool ${name}; have ${[...tools.keys()].join(", ")}`); return tool.execute("call", args, signal); },
  };
}

async function status(session, name = "mcp__fixture__read_status") { return JSON.parse(output(await session.run(name))); }

test("registers sanitized, collision-safe tool names and provider-safe schemas across paginated tools/list", async () => {
  const pool = new ExternalMcpPool({ clientVersion: "9.9.9", retryAfterMs: 0 });
  try {
    const session = await open(pool, [server("a", "Fixture", "--page-size", "2"), server("b", "Fixture")]);
    const names = [...session.tools.keys()];
    assert.equal(names.length, FIXTURE_TOOLS * 2, "both servers' tools must survive pagination");
    for (const name of names) assert.match(name, TOOL_NAME);
    const a = `mcp__fixture_${idHash("a")}__`, b = `mcp__fixture_${idHash("b")}__`;
    assert.ok(session.tools.has(`${a}read_status`) && session.tools.has(`${b}read_status`), "servers sharing a slug are told apart by a hash of their id");
    assert.ok(!session.tools.has("mcp__fixture__read_status"));
    const long = names.filter(name => name.startsWith(a) || name.startsWith(b)).filter(name => name.includes(LONG_NAME.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 20)));
    assert.equal(long.length, 2);
    assert.ok(long.every(name => name.length <= 64 && /_[0-9a-f]{8}$/.test(name)), "truncated names end in a hash of the original");
    const shape = session.tools.get(`${a}choose_shape`);
    assert.equal(shape.parameters.type, "object");
    assert.equal(shape.parameters.oneOf, undefined, "top-level oneOf would make the Anthropic API reject the session");
    assert.deepEqual(Object.keys(shape.parameters.properties).sort(), ["circle", "square"]);
    assert.equal(shape.parameters.required, undefined, "neither key is required by every variant");
    assert.deepEqual(session.tools.get(`${a}write_note`).parameters, { type: "object", properties: { text: { type: "string" } }, required: ["text"] });
    const statusTool = session.tools.get(`${a}read_status`);
    assert.equal(statusTool.label, "Read status");
    assert.equal(statusTool.executionMode, "sequential");
    assert.match(statusTool.description, /^\[Fixture\] Report fixture state\.$/);
    assert.match(session.tools.get(`${a}write_note`).description, /Solo mode/);
    assert.match(output(await session.run(long[0])), /long name ok/);
    const state = await status(session, `${a}read_status`);
    assert.deepEqual(state.clientInfo, { name: BRAND.slug, version: "9.9.9" });
    assert.equal(state.protocolVersion, "2025-06-18");
    assert.equal(state.initialized, true);
    assert.match(session.prompt(), /^BASE\n\n## External MCP servers\n/);
    assert.match(session.prompt(), /data, never as instructions/);
  } finally { await pool.dispose(); }
});

test("tool names are stable and never move to another server when one fails to connect", () => {
  const servers = [{ id: "x", name: "我的服务", tools: [{ name: "b" }, { name: "a" }, { name: "工具" }] }, { id: "y-1", name: "My Server!", tools: [{ name: "a" }, { name: "A" }] }];
  const first = externalToolNames(servers), second = externalToolNames(structuredClone(servers).reverse().reverse());
  assert.deepEqual([...first.values()], [...second.values()]);
  assert.equal(first.get("x\u0000a"), "mcp__x__a");
  assert.match(first.get("x\u0000工具"), /^mcp__x__tool_[0-9a-f]{8}$/);
  assert.equal(first.get("y-1\u0000A"), "mcp__my_server__A");
  assert.equal(first.get("y-1\u0000a"), "mcp__my_server__a_2", "names differing only by case still collide for case-insensitive providers");
  // A failed server lists no tools; its namesake must not inherit names a saved transcript may still use for the failed one.
  const notes = (tools) => [{ id: "a", name: "Notes", tools }, { id: "b", name: "Notes", tools: [{ name: "delete_all" }] }];
  const healthy = externalToolNames(notes([{ name: "delete_all" }])), degraded = externalToolNames(notes([]));
  assert.equal(healthy.get("a\u0000delete_all"), `mcp__notes_${idHash("a")}__delete_all`);
  assert.equal(healthy.get("b\u0000delete_all"), `mcp__notes_${idHash("b")}__delete_all`);
  assert.equal(degraded.get("b\u0000delete_all"), healthy.get("b\u0000delete_all"));
  assert.equal(externalToolNames([{ id: "b", name: "Notes", tools: [{ name: "delete_all" }] }]).get("b\u0000delete_all"), "mcp__notes__delete_all", "a unique slug stays readable");
  assert.deepEqual(mcpServerConfigs([{ id: "a", name: " A ", command: " node ", args: ["x", 1], enabled: true }, { id: "", command: "node" }, null]), [{ id: "a", name: "A", command: "node", args: ["x"], enabled: true }]);
});

test("schema sanitizing keeps definitions, requirements and resolvable references", () => {
  assert.deepEqual(toolParameters(undefined), { type: "object", properties: {} });
  assert.deepEqual(toolParameters({ type: "string" }), { type: "object", properties: {}, additionalProperties: true });
  const wrapped = toolParameters({ anyOf: [{ type: "object", properties: { item: { $ref: "#/$defs/Item" } } }], $defs: { Item: { type: "number" } } });
  assert.deepEqual(wrapped.$defs, { Item: { type: "number" } });
  assert.deepEqual(wrapped.properties, { item: { $ref: "#/$defs/Item" } });
  assert.deepEqual(toolParameters({ anyOf: [{ type: "object", properties: { item: { $ref: "#/$defs/Item" } }, $defs: { Item: { type: "string" } } }] }).$defs, { Item: { type: "string" } }, "definitions inside a variant are hoisted");
  assert.deepEqual(toolParameters({ $ref: "#/$defs/Args", $defs: { Args: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } } }), { $defs: { Args: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }, type: "object", properties: { q: { type: "string" } }, required: ["q"] });
  const constrained = toolParameters({ type: "object", properties: { q: { type: "string" }, id: { type: "string" }, name: { type: "string" } }, required: ["q"], anyOf: [{ required: ["id", "scope"] }, { required: ["name", "scope"] }] });
  assert.deepEqual(constrained.required, ["q", "scope"], "own requirements stay; a variant requirement stays only when every variant has it");
  assert.deepEqual(toolParameters({ allOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { properties: { b: { type: "string" } }, required: ["b"] }] }).required, ["a", "b"]);
  const union = toolParameters({ anyOf: [{ $ref: "#/$defs/Circle" }, { $ref: "#/$defs/Square" }], $defs: { Circle: { type: "object", properties: { kind: { const: "circle" }, r: { type: "number" } }, required: ["kind", "r"] }, Square: { type: "object", properties: { kind: { const: "square" }, side: { type: "number" } }, required: ["kind", "side"] } } });
  assert.deepEqual(union.properties, { kind: { anyOf: [{ const: "circle" }, { const: "square" }] }, r: { type: "number" }, side: { type: "number" } });
  assert.deepEqual(union.required, ["kind"]);
  const dangling = toolParameters({ anyOf: [{ type: "object", properties: { a: { $ref: "#/anyOf/0/$defs/A", description: "an A" }, b: { $ref: "#/$defs/B" }, c: { type: "number" } } }], $defs: { B: { type: "object", properties: { x: { $ref: "#/$defs/Missing" } } } } });
  assert.deepEqual(dangling.properties, { a: { description: "an A" }, b: {}, c: { type: "number" } }, "properties reaching a dangling $ref become unconstrained hints");
  assert.equal(dangling.$defs, undefined, "definitions reaching a dangling $ref are dropped");
  assert.equal(JSON.stringify(dangling).includes("$ref"), false);
  const plain = { type: "object", properties: { text: { type: "string", default: { $ref: "not a reference" } } } };
  assert.equal(toolParameters(plain), plain, "a valid object schema passes through untouched");
});

test("sanitized schemas accept every valid shape in Pi's argument validator", { skip: piValidation ? false : "pi-ai is not installed" }, async () => {
  const { validateToolArguments } = await import(pathToFileURL(piValidation).href);
  const accepts = (schema, args) => validateToolArguments({ name: "t", parameters: toolParameters(schema) }, { name: "t", arguments: args });
  const union = { anyOf: [{ $ref: "#/$defs/Circle" }, { $ref: "#/$defs/Square" }], $defs: { Circle: { type: "object", properties: { kind: { const: "circle" }, r: { type: "number" } }, required: ["kind", "r"] }, Square: { type: "object", properties: { kind: { const: "square" }, side: { type: "number" } }, required: ["kind", "side"] } } };
  assert.deepEqual(accepts(union, { kind: "square", side: 2 }), { kind: "square", side: 2 });
  assert.deepEqual(accepts(union, { kind: "circle", r: 1 }), { kind: "circle", r: 1 });
  assert.deepEqual(accepts({ anyOf: [{ type: "object", properties: { item: { $ref: "#/$defs/Item" } }, $defs: { Item: { type: "string" } } }] }, { item: "x" }), { item: "x" });
  assert.deepEqual(accepts({ anyOf: [{ type: "object", properties: { a: { $ref: "#/anyOf/0/$defs/A" } } }] }, { a: 1 }), { a: 1 });
  assert.deepEqual(accepts({ anyOf: [{ type: "object", properties: { tree: { $ref: "#/$defs/Node" } } }], $defs: { Node: { type: "object", properties: { children: { type: "array", items: { $ref: "#/$defs/Node" } } } } } }, { tree: { children: [{ children: [] }] } }), { tree: { children: [{ children: [] }] } });
  const args = { $ref: "#/$defs/Args", $defs: { Args: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } } };
  assert.deepEqual(accepts(args, { q: "hi" }), { q: "hi" });
  assert.throws(() => accepts(args, {}), /q/);
});

test("framing survives split lines, coalesced and batched messages and UTF-8 split across chunks", async () => {
  const logs = [];
  const client = new McpStdioClient({ command: process.execPath, args: [fixture, "--fragmented"], label: "Fragmented", onNotification: (method, params) => { if (method === "notifications/message") logs.push(params.data); } });
  try {
    await client.connect();
    assert.equal((await client.listTools()).length, FIXTURE_TOOLS);
    const [unicode, shape, state] = await Promise.all([client.callTool("unicode", {}), client.callTool("choose_shape", { circle: 1 }), client.callTool("read_status", {})]);
    assert.equal(output(unicode), "音符 🎵 ok");
    assert.deepEqual(JSON.parse(output(shape)), { circle: 1 });
    assert.equal(JSON.parse(output(state)).name, "fixture");
    // initialize, four tools/list pages and three calls each arrived with one log notification.
    assert.deepEqual(logs, Array(8).fill("log ✓"));
  } finally { await client.close(); }
});

test("read-only tools run in Edit mode; other tools are refused until Solo mode", async () => {
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    const session = await open(pool, [server("a", "Fixture")]);
    assert.equal((await status(session)).name, "a");
    await assert.rejects(session.run("mcp__fixture__write_note", { text: "hello" }), error => /may change data outside Toneshuttle/.test(error.message) && /Solo mode/.test(error.message) && /request_input/.test(error.message) && /approval/.test(error.message));
    assert.deepEqual((await status(session)).notes, [], "a refused call must never reach the server");
    assert.match(session.prompt(), /Edit mode: tools not marked read-only/);
    session.setMode("solo");
    assert.equal(output(await session.run("mcp__fixture__write_note", { text: "hello" })), "saved: hello");
    assert.deepEqual((await status(session)).notes, ["hello"]);
    assert.match(session.prompt(), /Solo mode/);
  } finally { await pool.dispose(); }
});

test("isError results throw, non-text content is summarized and long output is capped", async () => {
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    const session = await open(pool, [server("a", "Fixture")]);
    await assert.rejects(session.run("mcp__fixture__fail_always"), /boom: fixture failure/);
    assert.equal(output(await session.run("mcp__fixture__mixed_content")), "before\n[image omitted: image/png]\n[resource file:///notes.txt]\nresource body\nafter");
    const huge = output(await session.run("mcp__fixture__huge_output"));
    assert.ok(huge.startsWith("x".repeat(EXTERNAL_TOOL_OUTPUT_LIMIT)));
    assert.match(huge, /\[Output truncated: showing 100000 of 150000 characters\.\]$/);
    assert.deepEqual(JSON.parse(output(await session.run("mcp__fixture__choose_shape", { circle: 2 }))), { circle: 2 });
  } finally { await pool.dispose(); }
});

test("server-to-client requests get -32601 or a ping answer instead of hanging", async () => {
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    const session = await open(pool, [server("a", "Fixture")]);
    const answers = JSON.parse(output(await session.run("mcp__fixture__ask_client")));
    assert.equal(answers.roots.error.code, -32601);
    assert.deepEqual(answers.ping, { result: {} });
  } finally { await pool.dispose(); }
});

test("abort sends notifications/cancelled and the client stays usable", async () => {
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    const session = await open(pool, [server("a", "Fixture")]);
    const before = await status(session);
    const controller = new AbortController();
    const pending = session.run("mcp__fixture__slow", { ms: 20_000 }, controller.signal);
    await delay(200);
    controller.abort();
    await assert.rejects(pending, error => error.name === "AbortError");
    let after = await status(session);
    for (let attempt = 0; attempt < 20 && after.cancelled.length === 0; attempt++) { await delay(50); after = await status(session); }
    assert.equal(after.pid, before.pid, "aborting must not restart the server");
    assert.equal(after.slowCalls.length, 1);
    assert.deepEqual(after.cancelled, [{ requestId: after.slowCalls[0], reason: "The user cancelled the request." }], "the cancellation names the aborted call's request id");
    assert.equal(output(await session.run("mcp__fixture__slow", { ms: 10 })), "slow done");
  } finally { await pool.dispose(); }
});

test("a crashing server is reported in the prompt without hiding a healthy one", async () => {
  const pool = new ExternalMcpPool({ retryAfterMs: 60_000 });
  try {
    const session = await open(pool, [server("broken", "Broken", "--crash"), server("a", "Fixture")]);
    assert.ok(session.tools.has("mcp__fixture__read_status"));
    assert.ok(![...session.tools.keys()].some(name => name.startsWith("mcp__broken__")));
    const prompt = session.prompt();
    assert.match(prompt, /- Broken: unavailable \(MCP server "Broken" exited with code 3\..*fixture crashed on purpose.*\)/);
    assert.match(prompt, new RegExp(`- Fixture: ${FIXTURE_TOOLS} tools\\.`));
    const { servers } = await pool.tools();
    assert.match(servers[0].error, /fixture crashed on purpose/);
    assert.equal(servers[1].error, undefined);
  } finally { await pool.dispose(); }
});

test("tools/list_changed bumps the pool revision, and the next session sees the new tool list", async () => {
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    // add_tool changes the server, so it only runs in Solo mode.
    const before = await open(pool, [server("a", "Fixture")], "solo");
    const revision = pool.revision;
    assert.ok(!before.tools.has("mcp__fixture__added_later"));
    await before.run("mcp__fixture__add_tool", { name: "added_later" });
    for (let waited = 0; pool.revision === revision && waited < 3_000; waited += 25) await delay(25);
    assert.equal(pool.revision, revision + 1, "the agent prompt digest changes with it, so the conversation's session is rebuilt");
    const after = await open(pool, [server("a", "Fixture")]);
    assert.ok(after.tools.has("mcp__fixture__added_later"), "a session built afterwards registers the new tool");
  } finally { await pool.dispose(); }
});

test("a tools/list_changed that arrives while the tools are being listed is not overwritten by the stale answer", async () => {
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    const session = await open(pool, [server("a", "Fixture", "--change-during-list", "--page-size", "100")]);
    assert.ok(session.tools.has("mcp__fixture__arrived_mid_list"), "the pool listed again after the notification");
    const again = await open(pool, [server("a", "Fixture", "--change-during-list", "--page-size", "100")]);
    assert.ok(again.tools.has("mcp__fixture__arrived_mid_list"), "and caches the fresh list");
  } finally { await pool.dispose(); }
});

test("structured results reach the agent next to a text summary, without repeating JSON the text already holds", () => {
  const records = { rows: [{ id: 1, name: "take" }] };
  assert.equal(renderMcpResult({ content: [{ type: "text", text: "1 row found." }], structuredContent: records }), `1 row found.\nStructured result:\n${JSON.stringify(records)}`);
  assert.equal(renderMcpResult({ content: [{ type: "text", text: JSON.stringify(records, null, 2) }], structuredContent: records }), JSON.stringify(records, null, 2), "a text block that already carries the JSON is not duplicated");
  assert.equal(renderMcpResult({ content: [], structuredContent: records }), JSON.stringify(records));
});

test("a server whose process died is respawned on the next call", async () => {
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    const session = await open(pool, [server("a", "Fixture")]);
    const revision = pool.revision;
    const first = (await status(session)).pid;
    process.kill(first);
    assert.ok(await waitDead(first));
    await delay(300);
    const second = (await status(session)).pid;
    assert.notEqual(second, first);
    assert.ok(alive(second));
    assert.equal(pool.revision, revision + 1, "the new process may offer other tools, so conversations rebuild their sessions");
  } finally { await pool.dispose(); }
});

test("reconcile keeps unchanged servers and closes changed or removed ones", async () => {
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    const a = server("a", "Alpha"), b = server("b", "Beta"), c = server("c", "Gamma");
    const session = await open(pool, [a, b, c]);
    const pids = { a: (await status(session, "mcp__alpha__read_status")).pid, b: (await status(session, "mcp__beta__read_status")).pid, c: (await status(session, "mcp__gamma__read_status")).pid };
    await pool.reconcile([{ ...a, name: "Alpha renamed" }, { ...b, args: [...b.args, "--page-size", "4"] }, { ...c, enabled: false }]);
    assert.ok(await waitDead(pids.b), "a changed command line restarts the server");
    assert.ok(await waitDead(pids.c), "a disabled server is closed");
    assert.ok(alive(pids.a), "a rename alone must not restart the server");
    const next = await open(pool, [{ ...a, name: "Alpha renamed" }, { ...b, args: [...b.args, "--page-size", "4"] }]);
    assert.equal((await status(next, "mcp__alpha_renamed__read_status")).pid, pids.a);
    assert.notEqual((await status(next, "mcp__beta__read_status")).pid, pids.b);
    await assert.rejects(pool.call("c", "read_status", {}), /no longer enabled/);
  } finally { await pool.dispose(); }
});

test("dispose leaves no child process running, including servers that ignore stdin EOF", async () => {
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  const session = await open(pool, [server("a", "Fixture"), server("stubborn", "Stubborn", "--ignore-eof")]);
  const pids = [(await status(session)).pid, (await status(session, "mcp__stubborn__read_status")).pid];
  assert.ok(pids.every(alive));
  await pool.dispose();
  for (const pid of pids) assert.ok(await waitDead(pid, 1_000), `process ${pid} survived dispose`);
});

test("connect times out on a server that never answers initialize and kills it", async () => {
  const client = new McpStdioClient({ command: process.execPath, args: [fixture, "--hang"], label: "Hang", connectTimeoutMs: 400 });
  const started = Date.now();
  await assert.rejects(client.connect(), /MCP server "Hang" did not answer initialize within 0\.4 s/);
  assert.ok(Date.now() - started < 5_000);
  assert.ok(client.closed);
  assert.ok(await waitDead(client.pid, 3_000));
  await assert.rejects(client.callTool("read_status", {}), /Hang/);
});

test("a tool call that exceeds its timeout is cancelled without breaking the client", async () => {
  const client = new McpStdioClient({ command: process.execPath, args: [fixture], label: "Timeout" });
  try {
    await client.connect();
    await assert.rejects(client.callTool("slow", { ms: 5_000 }, undefined, 200), /did not answer tools\/call within 0\.2 s/);
    await delay(100);
    const state = JSON.parse(output(await client.callTool("read_status", {})));
    assert.deepEqual(state.cancelled.map(item => item.reason), ["timeout"]);
    assert.ok(client.stderr().some(line => line.includes("fixture banner")), "non-JSON stdout is kept for diagnostics, not parsed");
  } finally { await client.close(); }
});

test("a server inherits only the basic environment plus its own env, never the app's secrets", async () => {
  process.env.TONESHUTTLE_TEST_SECRET = "must-not-leak";
  const client = new McpStdioClient({ command: process.execPath, args: [fixture], label: "Env", env: { FIXTURE_CONFIGURED: "yes" } });
  try {
    await client.connect();
    assert.deepEqual(JSON.parse(output(await client.callTool("read_status", {}))).env, { secret: null, configured: "yes", path: true });
  } finally {
    delete process.env.TONESHUTTLE_TEST_SECRET;
    await client.close();
  }
});

test("a server answering with an unsupported protocol version is refused; an older supported one connects", async () => {
  const refused = new McpStdioClient({ command: process.execPath, args: [fixture, "--answer-protocol", "2023-01-01"], label: "Old" });
  await assert.rejects(refused.connect(), /protocol version 2023-01-01, which is not supported/);
  await refused.close();
  const older = new McpStdioClient({ command: process.execPath, args: [fixture, "--answer-protocol", "2025-03-26"], label: "Older" });
  try {
    await older.connect();
    assert.ok((await older.listTools()).length > 0);
  } finally { await older.close(); }
});

test("a server without a tools capability has no tools and is not reported as unavailable", async () => {
  const client = new McpStdioClient({ command: process.execPath, args: [fixture, "--no-tools"], label: "Resources" });
  try {
    await client.connect();
    assert.deepEqual(await client.listTools(), [], "tools/list is not sent to a server that never offered tools");
  } finally { await client.close(); }
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    const session = await open(pool, [{ ...server("r", "Resources"), args: [fixture, "--no-tools"] }]);
    assert.ok(![...session.tools.keys()].some((name) => name.startsWith("mcp__resources__")));
    assert.doesNotMatch(session.prompt(), /Resources: unavailable/u);
  } finally { await pool.dispose(); }
});

test("only JSON-RPC 2.0 responses settle requests, and an oversized finished line ends the connection", async () => {
  const { isJsonRpcResponse } = await import("../src/PiDesktop.Tauri/dist/electron/services/mcp-stdio-client.js");
  assert.equal(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, result: {} }), true);
  assert.equal(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, error: { code: 1, message: "x" } }), true);
  assert.equal(isJsonRpcResponse({ id: 1, result: {} }), false, "no version");
  assert.equal(isJsonRpcResponse({ jsonrpc: "1.0", id: 1, result: {} }), false);
  assert.equal(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, result: {}, error: {} }), false, "both");
  assert.equal(isJsonRpcResponse({ jsonrpc: "2.0", id: 1 }), false, "neither");
  const loose = new McpStdioClient({ command: process.execPath, args: [fixture, "--loose-list"], label: "Loose" });
  try {
    await loose.connect();
    await assert.rejects(loose.listTools({ timeoutMs: 500 }), /did not answer tools\/list within 0\.5 s/, "the envelope-less answer is ignored, not taken as the result");
  } finally { await loose.close(); }
  const big = new McpStdioClient({ command: process.execPath, args: [fixture, "--big-line"], label: "Big", maxMessageLength: 1024 * 1024 });
  try {
    await big.connect();
    await assert.rejects(big.listTools({ timeoutMs: 10_000 }), /larger than 1 MiB/, "a finished line over the limit is refused before parsing");
  } finally { await big.close(); }
  const wide = new McpStdioClient({ command: process.execPath, args: [fixture, "--wide-line"], label: "Wide", maxMessageLength: 1024 * 1024 });
  try {
    await wide.connect();
    await assert.rejects(wide.listTools({ timeoutMs: 10_000 }), /larger than 1 MiB/, "the limit counts UTF-8 bytes, not UTF-16 units");
  } finally { await wide.close(); }
});

test("a server that recovers through its running process rebuilds sessions created while it was failing", async () => {
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    const failing = await open(pool, [{ ...server("w", "Warmup"), args: [fixture, "--name", "warmup", "--fail-first-list"] }]);
    assert.ok(![...failing.tools.keys()].some((name) => name.startsWith("mcp__warmup__")));
    const revision = pool.revision;
    const recovered = await open(pool, [{ ...server("w", "Warmup"), args: [fixture, "--name", "warmup", "--fail-first-list"] }]);
    assert.ok(recovered.tools.has("mcp__warmup__read_status"));
    assert.equal(pool.revision, revision + 1, "conversations opened during the failure rebuild on their next turn");
  } finally { await pool.dispose(); }
});

test("tool definitions kept from one server are bounded across pages", async () => {
  const client = new McpStdioClient({ command: process.execPath, args: [fixture, "--many-tools"], label: "Many" });
  try {
    await client.connect();
    await assert.rejects(client.listTools(), /offers more than 1000 tools or 8 MiB of tool definitions/);
  } finally { await client.close(); }
});

test("tool definitions are bounded in UTF-8 bytes, not UTF-16 units", async () => {
  const client = new McpStdioClient({ command: process.execPath, args: [fixture, "--wide-tools"], label: "Wide" });
  try {
    await client.connect();
    await assert.rejects(client.listTools({ timeoutMs: 20_000 }), /8 MiB of tool definitions/);
  } finally { await client.close(); }
});

test("Test runs an enabled server through the agent's process instead of starting a second copy", async () => {
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    const config = server("a", "Fixture");
    const session = await open(pool, [config]);
    const before = await status(session);
    const checked = await pool.check(config);
    assert.equal(checked.succeeded, true, checked.summary);
    assert.ok(checked.tools.includes("read_status"));
    assert.match(checked.summary, /through the agent's running connection/);
    const after = await status(session);
    assert.equal(after.pid, before.pid);
    assert.ok(after.lists > before.lists, "the pooled process answered the fresh tools/list");
    assert.equal(await pool.check({ ...config, args: [...config.args, "--changed"] }), undefined, "an edited server is probed on its own");
    assert.equal(await new ExternalMcpPool().check(config), undefined, "nothing pooled: the caller probes as before");
  } finally { await pool.dispose(); }
});

test("a reconfigured server starts again only after its old process is gone", async () => {
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    // --ignore-eof makes the old process outlive stdin, so retiring it takes the client's grace period and a kill.
    const config = { ...server("a", "Fixture"), args: [fixture, "--name", "fixture", "--ignore-eof"] };
    const first = await status(await open(pool, [config]));
    void pool.reconcile([]);
    const second = await status(await open(pool, [{ ...config, args: [...config.args, "--changed"] }]));
    assert.notEqual(second.pid, first.pid);
    assert.equal(alive(first.pid), false, "the replacement never runs beside the process it replaces");
  } finally { await pool.dispose(); }
});

test("a cancelled call stops waiting for a server that is still starting", async () => {
  const pool = new ExternalMcpPool({ retryAfterMs: 0, connectTimeoutMs: 10_000 });
  try {
    await pool.reconcile([server("a", "Fixture", "--hang")]);
    const controller = new AbortController();
    const started = Date.now();
    const pending = pool.call("a", "read_status", {}, controller.signal);
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(pending, { name: "AbortError" });
    assert.ok(Date.now() - started < 3_000, `the call waited ${Date.now() - started} ms after Stop`);
  } finally { await pool.dispose(); }
});

test("a server removed while its tools are loading makes sessions rebuild", async () => {
  const pool = new ExternalMcpPool({ retryAfterMs: 0, connectTimeoutMs: 10_000 });
  try {
    await pool.reconcile([server("a", "Fixture", "--hang")]);
    const revision = pool.revision;
    const listing = pool.tools();
    await delay(200);
    // AI mode turned off while the session was being built: it lists the server as unavailable.
    await pool.reconcile([]);
    const { servers } = await listing;
    assert.match(servers[0].error ?? "", /no longer enabled|closed/i);
    assert.notEqual(pool.revision, revision, "turning AI mode back on must not reuse that session");
  } finally { await pool.dispose(); }
});

test("a server that failed while a conversation was built is retried on that conversation's next turn", async () => {
  const pool = new ExternalMcpPool({ retryAfterMs: 300 });
  try {
    const config = server("a", "Fixture", "--fail-first-list");
    const first = await open(pool, [config]);
    assert.ok(!first.tools.has("mcp__fixture__read_status"), "the first tools/list failed");
    const revision = pool.revision;
    assert.equal(pool.revision, revision, "within the backoff the conversation keeps its session");
    await delay(400);
    const announced = pool.revision;
    assert.ok(announced > revision, "after the backoff the next turn's prompt changes, so its session is rebuilt and lists again");
    assert.equal(pool.revision, announced, "announced once per failure");
    const rebuilt = await open(pool, [config]);
    assert.ok(rebuilt.tools.has("mcp__fixture__read_status"), "the rebuilt session has the recovered server's tools");
  } finally { await pool.dispose(); }
});

test("a hostile schema depth degrades that tool to any object instead of exhausting the stack", () => {
  let deep = { type: "string" };
  for (let level = 0; level < 20_000; level++) deep = { type: "object", properties: { next: deep } };
  assert.deepEqual(toolParameters(deep), { type: "object", properties: {}, additionalProperties: true });
  let ordinary = { type: "string" };
  for (let level = 0; level < 20; level++) ordinary = { type: "object", properties: { next: ordinary } };
  assert.equal(toolParameters(ordinary).properties.next.type, "object", "real nesting is kept");
});

test("a missing command fails with a clear error", async () => {
  const client = new McpStdioClient({ command: "toneshuttle-definitely-missing-mcp-server", label: "Missing" });
  await assert.rejects(client.connect(), /Missing.*(not found|ENOENT)/s);
  assert.ok(client.closed);
});

test("Windows batch shims resolve through PATH and receive arguments verbatim", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "toneshuttle mcp shim "));
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    await writeFile(join(directory, "fixture-shim.cmd"), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`, "utf8");
    // The unbalanced quote case leaves "& echo injected &" outside quotes when the shim's %* is re-parsed, unless metacharacters are escaped twice.
    const args = ["--name", "shim", "a & b | c > d", "x \"quoted\" y", "x\" & echo injected & \"y", "100% ^caret (paren)", "trailing\\", ""];
    const config = { id: "shim", name: "Shim", command: "fixture-shim", args, enabled: true, env: { PATH: `${directory}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}` } };
    const session = await open(pool, [config]);
    const state = await status(session, "mcp__shim__read_status");
    assert.deepEqual(state.argv, args);
    await pool.dispose();
    assert.ok(await waitDead(state.pid, 2_000), "the node process behind cmd.exe must exit with the shim");
  } finally { await pool.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("a server that outlives its cmd.exe launcher is reaped, and the pool reconnects", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "toneshuttle mcp orphan "));
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    await writeFile(join(directory, "fixture-shim.cmd"), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`, "utf8");
    const config = { id: "shim", name: "Shim", command: "fixture-shim", args: ["--name", "shim", "--ignore-eof"], enabled: true, env: { PATH: `${directory}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}` } };
    const session = await open(pool, [config]);
    const first = await status(session, "mcp__shim__read_status");
    assert.notEqual(first.ppid, process.pid, "the fixture must run behind cmd.exe");
    // Only the launcher dies; the server keeps the pipes open and ignores EOF, so taskkill /T from the dead launcher finds nothing.
    process.kill(first.ppid);
    await delay(300);
    const second = await status(session, "mcp__shim__read_status");
    assert.notEqual(second.pid, first.pid, "the next call reconnects");
    assert.equal(alive(first.pid), false, `orphaned server ${first.pid} was still running when its replacement started`);
    await pool.dispose();
    assert.ok(await waitDead(second.pid, 3_000), `server ${second.pid} survived dispose`);
    assert.ok(await waitDead(second.ppid, 3_000), `launcher ${second.ppid} survived dispose`);
  } finally { await pool.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("a server removed while its dead process is reaped is not started again", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "toneshuttle mcp orphan "));
  const launches = join(directory, "launches.txt");
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    // The shim logs every launch, so a replacement started after dispose shows up even though the pool no longer tracks it.
    await writeFile(join(directory, "fixture-shim.cmd"), `@echo off\r\necho launch>>"${launches}"\r\n"${process.execPath}" "${fixture}" %*\r\n`, "utf8");
    const config = { id: "shim", name: "Shim", command: "fixture-shim", args: ["--name", "shim", "--ignore-eof"], enabled: true, env: { PATH: `${directory}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}` } };
    const state = await status(await open(pool, [config]), "mcp__shim__read_status");
    process.kill(state.ppid);
    await delay(300);
    // The call finds the client dead and waits while the orphaned server is reaped; the app quits meanwhile.
    const refused = assert.rejects(pool.call("shim", "read_status", {}), /no longer enabled/);
    await pool.dispose();
    await refused;
    await delay(500);
    assert.equal((await readFile(launches, "utf8")).trim().split(/\r?\n/).length, 1, "no replacement was launched after dispose");
    assert.ok(await waitDead(state.pid, 3_000), `orphaned server ${state.pid} survived dispose`);
  } finally { await pool.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("a server edited while its dead process is reaped starts again only after the reap", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "toneshuttle mcp orphan "));
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    await writeFile(join(directory, "fixture-shim.cmd"), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`, "utf8");
    const config = { id: "shim", name: "Shim", command: "fixture-shim", args: ["--name", "shim", "--ignore-eof"], enabled: true, env: { PATH: `${directory}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}` } };
    const first = await status(await open(pool, [config]), "mcp__shim__read_status");
    process.kill(first.ppid);
    await delay(300);
    // A call finds the client dead and starts reaping the orphan; meanwhile the user edits the server.
    const refused = assert.rejects(pool.call("shim", "read_status", {}), /no longer enabled/);
    void pool.reconcile([{ ...config, args: [...config.args, "--changed"] }]);
    const second = JSON.parse(output(await pool.call("shim", "read_status", {})));
    assert.notEqual(second.pid, first.pid);
    assert.equal(alive(first.pid), false, `orphaned server ${first.pid} was still running when the edited server started`);
    await refused;
  } finally { await pool.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("dispose reaps a server whose launcher already died", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "toneshuttle mcp orphan "));
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    await writeFile(join(directory, "fixture-shim.cmd"), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`, "utf8");
    const config = { id: "shim", name: "Shim", command: "fixture-shim", args: ["--name", "shim", "--ignore-eof"], enabled: true, env: { PATH: `${directory}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}` } };
    const state = await status(await open(pool, [config]), "mcp__shim__read_status");
    process.kill(state.ppid);
    await pool.dispose();
    assert.ok(await waitDead(state.pid, 3_000), `orphaned server ${state.pid} survived dispose`);
  } finally { await pool.dispose(); await rm(directory, { recursive: true, force: true }); }
});
