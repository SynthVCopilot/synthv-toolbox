// Minimal newline-delimited JSON-RPC MCP server for test/mcp-stdio-probe.mjs.
// argv[2] selects the behaviour: ok (default), exit, hang, error, flood (stdout without line breaks), oldversion (answers
// initialize with an unsupported protocol version), endless (tools/list never stops paging). Remaining args are echoed back as a tool name.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [mode = "ok", ...extra] = process.argv.slice(2);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let initialize;

if (mode === "exit") {
  process.stderr.write("loading configuration\nfixture failed: missing API key\n");
  process.exit(3);
}
// Lets the timeout test check that the probe really ended this process.
if (mode === "hang" || mode === "flood") process.stderr.write(`fixture pid ${process.pid}\n`);
if (mode === "flood") { const chunk = "x".repeat(64 * 1024); const pump = () => process.stdout.write(chunk, pump); pump(); }
if (mode === "bigline") process.stdout.write(`${"x".repeat(2 * 1024 * 1024)}\n`);
if (mode === "loose") process.stderr.write(`fixture pid ${process.pid}\n`);
// Behind a launcher that exits early: report this process and keep running after stdin closes, so only a kill ends it.
if (process.env.FIXTURE_PID_FILE) writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid));
if (process.env.FIXTURE_LINGER === "1") setInterval(() => { }, 1_000);

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (mode === "hang" || message.id === undefined) return;
  // The initialize result waits for the client to answer this server's ping, as servers may legitimately do.
  if (message.id === "server-ping" && message.result) return send({ id: initialize.id, result: { protocolVersion: initialize.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture-stdio", version: "1.2.3" }, instructions: `client ${initialize.params.clientInfo.name}` } });
  if (message.method === "initialize") {
    if (mode === "error") return send({ id: message.id, error: { code: -32602, message: "Unsupported client." } });
    if (mode === "oldversion") return send({ id: message.id, result: { protocolVersion: "2023-01-01", capabilities: { tools: {} }, serverInfo: { name: "fixture-stdio", version: "0.1.0" } } });
    if (mode === "loose") return process.stdout.write(`${JSON.stringify({ id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "loose", version: "1" } } })}\n`);
    initialize = message;
    process.stdout.write("this line is not JSON-RPC and must be ignored\n");
    send({ method: "notifications/message", params: { level: "info", data: "starting" } });
    return send({ id: "server-ping", method: "ping" });
  }
  if (message.method === "tools/list") {
    if (mode === "manytools") return send({ id: message.id, result: { tools: Array.from({ length: 1_001 }, (_, index) => ({ name: `tool_${index}`, inputSchema: { type: "object" } })) } });
    if (mode === "endless") return send({ id: message.id, result: { tools: [{ name: `page-${message.params?.cursor ?? 0}`, inputSchema: { type: "object" } }], nextCursor: String(Number(message.params?.cursor ?? 0) + 1) } });
    if (!message.params?.cursor) return send({ id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }], nextCursor: "page-2" } });
    return send({ id: message.id, result: { tools: [{ name: `args:${extra.join("|")}`, inputSchema: { type: "object" } }] } });
  }
  if (message.method) send({ id: message.id, error: { code: -32601, message: "Method not found." } });
});
