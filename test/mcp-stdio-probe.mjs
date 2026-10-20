import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importElectronSource } from "./fixtures/electron-source.mjs";

const { probeStdioMcpServer, stdioMcpServerConfig } = await importElectronSource("services/mcp-stdio-probe.ts");
const fixture = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));
const isRunning = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const pidFrom = (detail) => Number(/fixture pid (\d+)/.exec(detail)?.[1]);

// Orphans are found through WMI, whose first query on a fresh CI runner can outlast the reaping timeout. Warming it up here
// keeps these tests about the reaping logic rather than WMI start-up time.
if (process.platform === "win32") {
  spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Out-Null"], { stdio: "ignore", timeout: 120_000, windowsHide: true });
}

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

test("a server left running by a launcher that already exited is stopped when the probe ends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "toneshuttle-probe-launcher-"));
  const pidFile = join(directory, "server.pid");
  const env = { FIXTURE_LINGER: "1", FIXTURE_PID_FILE: pidFile };
  let config;
  if (process.platform === "win32") {
    // cmd.exe returns as soon as `start /b` has launched the server on its pipes, like an npx or uvx shim that exits early.
    const shim = join(directory, "launch-and-exit.cmd");
    await writeFile(shim, `@echo off\r\nstart "" /b "${process.execPath}" "${fixture}" ok\r\n`, "utf8");
    config = { command: shim, args: [], env };
  } else {
    config = { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/stdio-mcp-launcher.mjs", import.meta.url)), fixture, "ok"], env };
  }
  let pid = 0;
  const started = Date.now();
  try {
    // On POSIX the server answers on the inherited pipes. Behind `start /b` it holds them without using them for stdio, so the
    // handshake times out; either way the probe ends with the launcher long gone and the server still holding the pipes.
    const result = await probeStdioMcpServer(config, { timeoutMs: 5_000 });
    assert.ok(result.succeeded || /did not complete the MCP handshake/.test(result.summary), `${result.summary} ${result.detail}`);
    pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(pid > 0);
    // The launcher was gone before the handshake ended; its server must not outlive the probe.
    const deadline = Date.now() + 5_000;
    while (isRunning(pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
    // If it survived, say what the reaper would have seen (parent pid and creation time) so a CI failure is diagnosable.
    const seen = !isRunning(pid) || process.platform !== "win32" ? "" : spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ForEach-Object { "parent $($_.ParentProcessId) created $($_.CreationDate)" }`], { encoding: "utf8", windowsHide: true }).stdout.trim();
    assert.equal(isRunning(pid), false, `server ${pid} survived the probe ${seen}; probe started ${new Date(started).toISOString()}`);
  } finally {
    if (pid && isRunning(pid)) process.kill(pid);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a server with an unsupported protocol version fails the test, as the agent would refuse it", async () => {
  const result = await probeStdioMcpServer({ command: process.execPath, args: [fixture, "oldversion"] });
  assert.equal(result.succeeded, false);
  assert.match(result.summary, /protocol version 2023-01-01, which is not supported/);
  assert.deepEqual(result.serverInfo, { name: "fixture-stdio", version: "0.1.0" });
});

test("stdout without line breaks is capped, and the flooding server is stopped", async () => {
  const started = Date.now();
  const result = await probeStdioMcpServer({ command: process.execPath, args: [fixture, "flood"] }, { maxMessageLength: 1024 * 1024, timeoutMs: 15_000 });
  assert.equal(result.succeeded, false);
  assert.match(result.summary, /larger than 1 MiB without a line break/);
  assert.ok(Date.now() - started < 10_000, "the probe does not wait for its timeout");
  const pid = pidFrom(result.detail);
  assert.ok(pid > 0, result.detail);
  assert.equal(isRunning(pid), false);
});

test("a server that pages tools/list past the client's limit fails the test instead of passing with a partial list", async () => {
  const result = await probeStdioMcpServer({ command: process.execPath, args: [fixture, "endless"] }, { timeoutMs: 30_000 });
  assert.equal(result.succeeded, false);
  assert.match(result.summary, /more than 100 pages from tools\/list/);
  assert.match(result.detail, /^100 tools listed before giving up\.$/);
});

test("an oversized finished line fails the probe, and an answer without the JSON-RPC envelope is not accepted", async () => {
  const big = await probeStdioMcpServer({ command: process.execPath, args: [fixture, "bigline"] }, { maxMessageLength: 1024 * 1024 });
  assert.equal(big.succeeded, false);
  // Pipes split a 2 MiB line into chunks, so whichever check sees it first (tail or finished line) must end the probe.
  assert.match(big.summary, /larger than 1 MiB/);
  const loose = await probeStdioMcpServer({ command: process.execPath, args: [fixture, "loose"] }, { timeoutMs: 1_500 });
  assert.equal(loose.succeeded, false);
  assert.match(loose.summary, /did not complete the MCP handshake/, "an envelope-less initialize answer is ignored");
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
  // A shim outside node_modules/.bin re-parses %* too, so an unmatched quote must not let "& echo injected &" escape.
  const args = ["a b", "c&d", "x|y", "(z)", "x\" & echo injected & \"y", "100% ^caret"];
  const result = await probeStdioMcpServer({ command: "fixture-mcp", args: ["ok", ...args], env });
  assert.equal(result.succeeded, true, `${result.summary}\n${result.detail}`);
  assert.deepEqual(result.tools, ["echo", `args:${args.join("|")}`], "the probe passes the same arguments the agent's client would");
  const hung = await probeStdioMcpServer({ command: "fixture-mcp", args: ["hang"], env }, { timeoutMs: 1_500 });
  assert.equal(hung.succeeded, false);
  const pid = pidFrom(hung.detail);
  assert.ok(pid > 0, hung.detail);
  assert.equal(isRunning(pid), false, "the node grandchild behind cmd.exe was stopped");
});
