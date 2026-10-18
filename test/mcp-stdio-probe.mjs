import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importElectronSource } from "./fixtures/electron-source.mjs";

const { probeStdioMcpServer, stdioMcpServerConfig } = await importElectronSource("services/mcp-stdio-probe.ts");
const fixture = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));
const isRunning = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const pidFrom = (detail) => Number(/fixture pid (\d+)/.exec(detail)?.[1]);

test("a working stdio server reports its identity and every page of tools", async () => {
  const result = await probeStdioMcpServer({ command: process.execPath, args: [fixture, "ok", "a b", "c&d"] }, { clientVersion: "9.9.9" });
  assert.equal(result.succeeded, true, result.summary);
  assert.deepEqual(result.serverInfo, { name: "fixture-stdio", version: "1.2.3" });
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.deepEqual(result.tools, ["echo", "args:a b|c&d"]);
  assert.match(result.summary, /fixture-stdio 1\.2\.3.*2 tools/);
  assert.equal(result.detail, "echo, args:a b|c&d");
});

test("a server that exits during startup fails with its exit code and last stderr lines", async () => {
  const result = await probeStdioMcpServer({ command: process.execPath, args: [fixture, "exit"] });
  assert.equal(result.succeeded, false);
  assert.match(result.summary, /exited before the MCP handshake finished \(exit code 3\)/);
  assert.match(result.detail, /fixture failed: missing API key/);
  assert.deepEqual(result.tools, []);
});

test("a server that never answers times out and is stopped", async () => {
  const started = Date.now();
  const result = await probeStdioMcpServer({ command: process.execPath, args: [fixture, "hang"] }, { timeoutMs: 1_500 });
  assert.equal(result.succeeded, false);
  assert.match(result.summary, /did not complete the MCP handshake within 1\.5 s/);
  assert.ok(Date.now() - started < 10_000);
  const pid = pidFrom(result.detail);
  assert.ok(pid > 0, result.detail);
  assert.equal(isRunning(pid), false);
});

test("JSON-RPC errors and launch failures are reported as failed probes", async () => {
  const rejected = await probeStdioMcpServer({ command: process.execPath, args: [fixture, "error"] });
  assert.equal(rejected.succeeded, false);
  assert.match(rejected.summary, /Unsupported client\. \(JSON-RPC -32602\)/);
  const missing = await probeStdioMcpServer({ command: "toneshuttle-missing-mcp-server-command" });
  assert.equal(missing.succeeded, false);
  assert.match(missing.summary, /Could not start toneshuttle-missing-mcp-server-command/);
  const blank = await probeStdioMcpServer({ command: "  " });
  assert.equal(blank.succeeded, false);
});

test("saved server entries are validated before launch", () => {
  assert.deepEqual(stdioMcpServerConfig({ id: "x", name: "X", command: " npx ", args: ["-y", "pkg"], enabled: true }), { command: "npx", args: ["-y", "pkg"] });
  assert.deepEqual(stdioMcpServerConfig({ command: "uvx", env: { TOKEN: "t" }, cwd: "C:/work" }), { command: "uvx", args: [], env: { TOKEN: "t" }, cwd: "C:/work" });
  assert.throws(() => stdioMcpServerConfig({ command: "" }), /command is required/);
  assert.throws(() => stdioMcpServerConfig({ command: "npx", args: [1] }), /args must be a list of strings/);
  assert.throws(() => stdioMcpServerConfig({ command: "npx", env: { A: 1 } }), /env must map names to strings/);
});

test("test_mcp_server probes the saved server by id, and rotate_http_api_token delegates to the runtime host", async () => {
  const { ElectronCommandRegistry } = await import(pathToFileURL(fileURLToPath(new URL("../src/PiDesktop.Tauri/dist/electron/services/command-registry.js", import.meta.url))).href);
  let rotations = 0;
  const host = { async contributions() { return []; }, runtime: { dispose: async () => {} }, async rotateHttpApiToken() { rotations++; return { token: "rotated" }; } };
  const desktop = { async bootstrap() { return { appVersion: "2.0.0", mcpServers: [{ id: "fixture", name: "Fixture", command: process.execPath, args: [fixture, "ok"], enabled: true }, { id: "broken", name: "Broken", command: "", args: [], enabled: true }] }; } };
  const registry = new ElectronCommandRegistry(host, { ai: {}, creative: {}, desktop, synthv: {}, approvals: {}, componentAudio: { dataRoot: process.cwd() } });
  const tested = await registry.invoke("test_mcp_server", { id: "fixture" });
  assert.equal(tested.succeeded, true, tested.summary);
  assert.deepEqual(tested.tools, ["echo", "args:"]);
  assert.deepEqual(tested.serverInfo, { name: "fixture-stdio", version: "1.2.3" });
  assert.deepEqual(await registry.invoke("test_mcp_server", { id: "missing" }), { succeeded: false, summary: "MCP server was not found.", detail: "missing", tools: [], serverInfo: null });
  assert.equal((await registry.invoke("test_mcp_server", { id: "broken" })).summary, "MCP server command is required.");
  assert.deepEqual(await registry.invoke("rotate_http_api_token"), { token: "rotated" });
  assert.equal(rotations, 1);
});

test("Windows .cmd shims run through cmd.exe with metacharacters kept literal and the whole tree stopped", { skip: process.platform !== "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-stdio-shim-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "fixture-mcp.cmd"), `@"${process.execPath}" "${fixture}" %*\r\n`);
  const env = { PATH: `${directory};${process.env.PATH}` };
  const result = await probeStdioMcpServer({ command: "fixture-mcp", args: ["ok", "a b", "c&d", "x|y", "(z)"], env });
  assert.equal(result.succeeded, true, `${result.summary}\n${result.detail}`);
  assert.deepEqual(result.tools, ["echo", "args:a b|c&d|x|y|(z)"]);
  const hung = await probeStdioMcpServer({ command: "fixture-mcp", args: ["hang"], env }, { timeoutMs: 1_500 });
  assert.equal(hung.succeeded, false);
  const pid = pidFrom(hung.detail);
  assert.ok(pid > 0, hung.detail);
  assert.equal(isRunning(pid), false, "the node grandchild behind cmd.exe was stopped");
});
