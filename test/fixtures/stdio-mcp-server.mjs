// Minimal newline-delimited JSON-RPC MCP server for test/mcp-stdio-probe.mjs.
// argv[2] selects the behaviour: ok (default), exit, hang, error. Remaining args are echoed back as a tool name.
import { createInterface } from "node:readline";

const [mode = "ok", ...extra] = process.argv.slice(2);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let initialize;

if (mode === "exit") {
  process.stderr.write("loading configuration\nfixture failed: missing API key\n");
  process.exit(3);
}
// Lets the timeout test check that the probe really ended this process.
if (mode === "hang") process.stderr.write(`fixture pid ${process.pid}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (mode === "hang" || message.id === undefined) return;
  // The initialize result waits for the client to answer this server's ping, as servers may legitimately do.
  if (message.id === "server-ping" && message.result) return send({ id: initialize.id, result: { protocolVersion: initialize.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture-stdio", version: "1.2.3" }, instructions: `client ${initialize.params.clientInfo.name}` } });
  if (message.method === "initialize") {
    if (mode === "error") return send({ id: message.id, error: { code: -32602, message: "Unsupported client." } });
    initialize = message;
    process.stdout.write("this line is not JSON-RPC and must be ignored\n");
    send({ method: "notifications/message", params: { level: "info", data: "starting" } });
    return send({ id: "server-ping", method: "ping" });
  }
  if (message.method === "tools/list") {
    if (!message.params?.cursor) return send({ id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }], nextCursor: "page-2" } });
    return send({ id: message.id, result: { tools: [{ name: `args:${extra.join("|")}`, inputSchema: { type: "object" } }] } });
  }
  if (message.method) send({ id: message.id, error: { code: -32601, message: "Method not found." } });
});
