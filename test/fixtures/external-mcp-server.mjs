// Minimal newline-delimited JSON-RPC stdio MCP server for test/external-mcp-tools.mjs.
// Flags: --name <label>, --page-size <n>, --crash (exit before initialize), --hang (never answer initialize),
// --ignore-eof (keep running after stdin closes, so the client must kill the process tree),
// --fragmented (every message travels with a log notification, coalesced or batched, in chunks that split a line and a UTF-8 character).
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const option = (name, fallback) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };

if (flag("--crash")) { process.stderr.write("fatal: fixture crashed on purpose\n"); process.exit(3); }

const LONG_NAME = "weird tool/name.with:odd chars and a very long suffix that keeps going far beyond any provider limit";
const pageSize = Number(option("--page-size", "3"));
const state = { name: option("--name", "fixture"), pid: process.pid, ppid: process.ppid, argv, notes: [], slowCalls: [], cancelled: [], initialized: false, clientInfo: null, protocolVersion: null,
  env: { secret: process.env.TONESHUTTLE_TEST_SECRET ?? null, configured: process.env.FIXTURE_CONFIGURED ?? null, path: Boolean(process.env.PATH ?? process.env.Path) } };
const slow = new Map();
const waiting = new Map();
let serverRequestId = 0;

const readOnly = { readOnlyHint: true };
const tools = [
  { name: "read_status", title: "Read status", description: "Report fixture state.", inputSchema: { type: "object", properties: {} }, annotations: readOnly },
  { name: "write_note", description: "Store a note.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "choose_shape", description: "Tool with a top-level oneOf schema.", inputSchema: { oneOf: [{ type: "object", properties: { circle: { type: "number" } }, required: ["circle"] }, { type: "object", properties: { square: { type: "number" } }, required: ["square"] }] }, annotations: readOnly },
  { name: LONG_NAME, description: "Tool with a long, odd name.", inputSchema: { type: "object", properties: {} }, annotations: readOnly },
  { name: "fail_always", description: "Always reports a tool error.", inputSchema: { type: "object", properties: {} }, annotations: readOnly },
  { name: "slow", description: "Waits before answering.", inputSchema: { type: "object", properties: { ms: { type: "integer" } } }, annotations: readOnly },
  { name: "mixed_content", description: "Returns text, an image and an embedded resource.", inputSchema: { type: "object", properties: {} }, annotations: readOnly },
  { name: "huge_output", description: "Returns more text than the client keeps.", inputSchema: { type: "object", properties: {} }, annotations: readOnly },
  { name: "ask_client", description: "Sends roots/list and ping to the client and reports the answers.", inputSchema: { type: "object", properties: {} }, annotations: readOnly },
  { name: "unicode", description: "Returns multi-byte text.", inputSchema: { type: "object", properties: {} }, annotations: readOnly },
  { name: "add_tool", description: "Adds a tool and announces tools/list_changed.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
];

const LOG = { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "log ✓" } };
let writing = Promise.resolve(), sent = 0;
function sendFragmented(message) {
  const line = ++sent % 2 ? `${JSON.stringify(LOG)}\r\n${JSON.stringify(message)}\r\n` : `${JSON.stringify([LOG, message])}\r\n`;
  const bytes = Buffer.from(line, "utf8");
  const cut = bytes.indexOf(Buffer.from("✓", "utf8")) + 1;
  const pieces = [bytes.subarray(0, 1), bytes.subarray(1, cut), bytes.subarray(cut)];
  writing = writing.then(async () => { for (const piece of pieces) { await new Promise(done => process.stdout.write(piece, done)); await delay(15); } });
}
const send = message => flag("--fragmented") ? sendFragmented(message) : process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const text = value => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const askClient = method => new Promise(resolve => { const id = `server-${++serverRequestId}`; waiting.set(id, resolve); send({ jsonrpc: "2.0", id, method }); });

async function callTool(id, name, args) {
  if (name === "read_status") return reply(id, text(state));
  if (name === "write_note") { state.notes.push(args.text); return reply(id, text(`saved: ${args.text}`)); }
  if (name === "choose_shape") return reply(id, text(args));
  if (name === LONG_NAME) return reply(id, text("long name ok"));
  if (name === "fail_always") return reply(id, { content: [{ type: "text", text: "boom: fixture failure" }], isError: true });
  if (name === "slow") { state.slowCalls.push(id); slow.set(id, setTimeout(() => { slow.delete(id); reply(id, text("slow done")); }, Number(args.ms ?? 10_000))); return; }
  if (name === "mixed_content") return reply(id, { content: [{ type: "text", text: "before" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }, { type: "resource", resource: { uri: "file:///notes.txt", mimeType: "text/plain", text: "resource body" } }, { type: "text", text: "after" }] });
  if (name === "huge_output") return reply(id, text("x".repeat(150_000)));
  if (name === "ask_client") { const [roots, ping] = await Promise.all([askClient("roots/list"), askClient("ping")]); return reply(id, text({ roots, ping })); }
  if (name === "unicode") return reply(id, text("音符 🎵 ok"));
  if (name === "add_tool") {
    tools.push({ name: args.name, description: "Added at runtime.", inputSchema: { type: "object", properties: {} }, annotations: readOnly });
    reply(id, text(`added ${args.name}`));
    return send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }
  send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } });
}

function handle(message) {
  const { id, method, params } = message;
  if (method === undefined && waiting.has(id)) { const resolve = waiting.get(id); waiting.delete(id); return resolve(message.error ? { error: message.error } : { result: message.result }); }
  if (method === "initialize") {
    if (flag("--hang")) return;
    state.clientInfo = params.clientInfo; state.protocolVersion = params.protocolVersion;
    return reply(id, { protocolVersion: option("--answer-protocol", params.protocolVersion), capabilities: flag("--no-tools") ? { resources: {} } : { tools: { listChanged: false } }, serverInfo: { name: "external-mcp-fixture", version: "1.0.0" } });
  }
  if (method === "notifications/initialized") { state.initialized = true; return; }
  if (method === "notifications/cancelled") {
    const timer = slow.get(params.requestId);
    if (timer) { clearTimeout(timer); slow.delete(params.requestId); }
    state.cancelled.push({ requestId: params.requestId, reason: params.reason });
    return;
  }
  if (method === "ping") return reply(id, {});
  // A resources-only server: it never offered tools, so asking for them is an error.
  if (method === "tools/list" && flag("--no-tools")) return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  // --many-tools offers one tool more than the client keeps from a server.
  if (method === "tools/list" && flag("--many-tools")) return reply(id, { tools: Array.from({ length: 1_001 }, (_, index) => ({ name: `tool_${index}`, inputSchema: { type: "object" } })) });
  // --loose-list answers tools/list without the JSON-RPC envelope, like a log object that happens to carry the id.
  if (method === "tools/list" && flag("--loose-list")) return send({ id, result: { tools: [] } });
  // --big-line answers tools/list with one line longer than the client's limit in the tests (2 MiB).
  if (method === "tools/list" && flag("--big-line")) return process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [], padding: "x".repeat(2 * 1024 * 1024) } })}\n`);
  // --fail-first-list fails the first tools/list and answers later ones, as a server still warming up might.
  if (method === "tools/list" && flag("--fail-first-list") && !state.listedOnce) { state.listedOnce = true; return send({ jsonrpc: "2.0", id, error: { code: -32000, message: "still starting" } }); }
  if (method === "tools/list") {
    const start = Number(params?.cursor ?? 0);
    const next = start + pageSize;
    return reply(id, { tools: tools.slice(start, next), ...(next < tools.length ? { nextCursor: String(next) } : {}) });
  }
  if (method === "tools/call") return void callTool(id, params.name, params.arguments ?? {});
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

process.stdout.write("fixture banner: this line is not JSON\n");
process.stderr.write(`fixture ${state.name} ready\n`);
const lines = createInterface({ input: process.stdin });
lines.on("line", line => { if (line.trim()) handle(JSON.parse(line)); });
lines.on("close", () => { if (flag("--ignore-eof")) setInterval(() => { }, 1_000); else process.exit(0); });
