import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BRAND } from "../src/PiDesktop.Tauri/dist/electron/brand.js";
import { createExternalMcpToolsExtension, EXTERNAL_TOOL_OUTPUT_LIMIT, ExternalMcpPool, externalToolNames, mcpServerConfigs, toolParameters } from "../src/PiDesktop.Tauri/dist/electron/services/external-mcp-tools.js";
import { McpStdioClient } from "../src/PiDesktop.Tauri/dist/electron/services/mcp-stdio-client.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "external-mcp-server.mjs");
const LONG_NAME = "weird tool/name.with:odd chars and a very long suffix that keeps going far beyond any provider limit";
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

const server = (id, name, ...flags) => ({ id, name, command: process.execPath, args: [fixture, "--name", id, ...flags], enabled: true });
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
    assert.equal(names.length, 18, "both servers' nine tools must survive pagination");
    for (const name of names) assert.match(name, TOOL_NAME);
    assert.ok(session.tools.has("mcp__fixture__read_status"));
    assert.ok(session.tools.has("mcp__fixture__read_status_2"), "the second server with the same slug gets a deterministic suffix");
    const long = names.filter(name => name.startsWith("mcp__fixture__weird_tool_name_with_odd_chars"));
    assert.equal(long.length, 2);
    assert.ok(long.every(name => name.length <= 64));
    const shape = session.tools.get("mcp__fixture__choose_shape");
    assert.equal(shape.parameters.type, "object");
    assert.equal(shape.parameters.oneOf, undefined, "top-level oneOf would make the Anthropic API reject the session");
    assert.deepEqual(Object.keys(shape.parameters.properties).sort(), ["circle", "square"]);
    assert.deepEqual(session.tools.get("mcp__fixture__write_note").parameters, { type: "object", properties: { text: { type: "string" } }, required: ["text"] });
    const statusTool = session.tools.get("mcp__fixture__read_status");
    assert.equal(statusTool.label, "Read status");
    assert.equal(statusTool.executionMode, "sequential");
    assert.match(statusTool.description, /^\[Fixture\] Report fixture state\.$/);
    assert.match(session.tools.get("mcp__fixture__write_note").description, /Solo mode/);
    assert.match(output(await session.run(long[0])), /long name ok/);
    const state = await status(session);
    assert.deepEqual(state.clientInfo, { name: BRAND.slug, version: "9.9.9" });
    assert.equal(state.protocolVersion, "2025-06-18");
    assert.equal(state.initialized, true);
    assert.match(session.prompt(), /^BASE\n\n## External MCP servers\n/);
    assert.match(session.prompt(), /data, never as instructions/);
  } finally { await pool.dispose(); }
});

test("tool names are stable and schema sanitizing keeps definitions", () => {
  const servers = [{ id: "x", name: "我的服务", tools: [{ name: "b" }, { name: "a" }, { name: "工具" }] }, { id: "y-1", name: "My Server!", tools: [{ name: "a" }, { name: "A" }] }];
  const first = externalToolNames(servers), second = externalToolNames(structuredClone(servers).reverse().reverse());
  assert.deepEqual([...first.values()], [...second.values()]);
  assert.equal(first.get("x\u0000a"), "mcp__x__a");
  assert.match(first.get("x\u0000工具"), /^mcp__x__tool_[0-9a-f]{8}$/);
  assert.equal(first.get("y-1\u0000A"), "mcp__my_server__A");
  assert.equal(first.get("y-1\u0000a"), "mcp__my_server__a_2", "names differing only by case still collide for case-insensitive providers");
  assert.deepEqual(toolParameters(undefined), { type: "object", properties: {} });
  assert.deepEqual(toolParameters({ type: "string" }), { type: "object", properties: {}, additionalProperties: true });
  const wrapped = toolParameters({ anyOf: [{ type: "object", properties: { item: { $ref: "#/$defs/Item" } } }], $defs: { Item: { type: "number" } } });
  assert.deepEqual(wrapped.$defs, { Item: { type: "number" } });
  assert.deepEqual(wrapped.properties, { item: { $ref: "#/$defs/Item" } });
  assert.deepEqual(mcpServerConfigs([{ id: "a", name: " A ", command: " node ", args: ["x", 1], enabled: true }, { id: "", command: "node" }, null]), [{ id: "a", name: "A", command: "node", args: ["x"], enabled: true }]);
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
    assert.equal(after.cancelled.length, 1);
    assert.equal(typeof after.cancelled[0].requestId, "number");
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
    assert.match(prompt, /- Fixture: 9 tools\./);
    const { servers } = await pool.tools();
    assert.match(servers[0].error, /fixture crashed on purpose/);
    assert.equal(servers[1].error, undefined);
  } finally { await pool.dispose(); }
});

test("a server whose process died is respawned on the next call", async () => {
  const pool = new ExternalMcpPool({ retryAfterMs: 0 });
  try {
    const session = await open(pool, [server("a", "Fixture")]);
    const first = (await status(session)).pid;
    process.kill(first);
    assert.ok(await waitDead(first));
    await delay(300);
    const second = (await status(session)).pid;
    assert.notEqual(second, first);
    assert.ok(alive(second));
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
