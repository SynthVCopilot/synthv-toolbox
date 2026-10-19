import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { BRAND } from "../brand.js";
import { MAX_MESSAGE_LENGTH, MAX_TOOL_PAGES, reapProcessTree, serverEnvironment, spawnPlan, STDIO_MCP_PROTOCOL_VERSIONS } from "./mcp-stdio-client.js";

export interface StdioMcpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface StdioMcpProbeOptions {
  timeoutMs?: number;
  /** Reported as clientInfo.version; the app passes its own version. */
  clientVersion?: string;
  /** Longest unterminated stdout the probe buffers; defaults to the client's message limit. */
  maxMessageLength?: number;
}

export interface StdioMcpProbeResult {
  succeeded: boolean;
  summary: string;
  detail: string;
  serverInfo?: { name: string; version?: string };
  protocolVersion?: string;
  tools: string[];
}


const probeProtocolVersion = "2025-06-18";
const stderrLimit = 8_192;
/** Converts a saved MCP server entry (desktop settings) into a launch config, rejecting malformed fields. */
export function stdioMcpServerConfig(server: Record<string, unknown>): StdioMcpServerConfig {
  if (typeof server.command !== "string" || !server.command.trim()) throw new Error("MCP server command is required.");
  if (server.args != null && (!Array.isArray(server.args) || !server.args.every((arg) => typeof arg === "string"))) throw new Error("MCP server args must be a list of strings.");
  if (server.env != null && (!isRecord(server.env) || !Object.values(server.env).every((value) => typeof value === "string"))) throw new Error("MCP server env must map names to strings.");
  if (server.cwd != null && typeof server.cwd !== "string") throw new Error("MCP server cwd must be a path.");
  return { command: server.command.trim(), args: (server.args ?? []) as string[], ...(server.env == null ? {} : { env: server.env as Record<string, string> }), ...(typeof server.cwd === "string" && server.cwd ? { cwd: server.cwd } : {}) };
}

/** Launches a stdio MCP server, performs the initialize handshake and tools/list, then stops the server and its child processes. */
export async function probeStdioMcpServer(config: StdioMcpServerConfig, options: StdioMcpProbeOptions = {}): Promise<StdioMcpProbeResult> {
  const command = typeof config.command === "string" ? config.command.trim() : "";
  if (!command) return failure("MCP server command is required.", "");
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxMessageLength = options.maxMessageLength ?? MAX_MESSAGE_LENGTH;
  const env = serverEnvironment(config.env);
  // The same launch plan as the agent's client, so a test exercises exactly the command line the agent will run.
  const launch = spawnPlan(command, config.args ?? [], env, config.cwd);
  let child: ChildProcessWithoutNullStreams;
  const spawnedAt = Date.now();
  try {
    child = spawn(launch.file, launch.args, { cwd: config.cwd, env, stdio: "pipe", windowsHide: true, windowsVerbatimArguments: launch.verbatim, detached: process.platform !== "win32" });
  } catch (error) {
    return failure(`Could not start ${command}: ${errorMessage(error)}`, "");
  }
  // Settles once no process holds the pipes, which can be long after a launcher exits and leaves the real server running.
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  return new Promise<StdioMcpProbeResult>((resolveProbe) => {
    let stderr = "";
    let stdout = "";
    let nextId = 0;
    let settled = false;
    const pending = new Map<number, { resolve(result: Record<string, unknown>): void; reject(error: Error): void }>();
    const stderrTail = () => stderr.trim().split(/\r?\n/).slice(-10).join("\n");
    const finish = (result: StdioMcpProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const request of pending.values()) request.reject(new Error("The probe finished."));
      void terminate(child, spawnedAt, closed).then(() => resolveProbe(result));
    };
    const timer = setTimeout(() => finish(failure(`${command} did not complete the MCP handshake within ${Math.round(timeoutMs / 100) / 10} s.`, stderrTail())), timeoutMs);
    const write = (message: Record<string, unknown>) => { if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); };
    const request = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolveRequest, rejectRequest) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      write({ id, method, params });
    });
    const receive = (line: string) => {
      let message: unknown;
      try { message = JSON.parse(line); } catch { return; }
      if (!isRecord(message)) return;
      if (typeof message.method === "string") {
        // Answer server-to-client requests so a server that pings or asks for roots during startup is not left waiting.
        if (message.id !== undefined) write(message.method === "ping" ? { id: message.id, result: {} } : { id: message.id, error: { code: -32601, message: "Method not found." } });
        return;
      }
      const waiting = typeof message.id === "number" ? pending.get(message.id) : undefined;
      if (!waiting) return;
      pending.delete(message.id as number);
      if (isRecord(message.error)) waiting.reject(new Error(`${String(message.error.message ?? "Request failed.")} (JSON-RPC ${String(message.error.code ?? "error")})`));
      else waiting.resolve(isRecord(message.result) ? message.result : {});
    };
    child.once("error", (error) => finish(failure(`Could not start ${command}: ${error.message}`, stderrTail())));
    child.once("close", (code, signal) => { if (child.pid !== undefined) finish(failure(`${command} exited before the MCP handshake finished (${signal ?? `exit code ${code}`}).`, stderrTail() || "The server wrote nothing to stderr.")); });
    child.stdin.on("error", () => undefined);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-stderrLimit); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      for (let index = stdout.indexOf("\n"); index >= 0; index = stdout.indexOf("\n")) {
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        if (line) receive(line);
      }
      // A server that never ends a line would otherwise grow this buffer until the timeout, in the app's main process.
      if (stdout.length > maxMessageLength) { stdout = ""; finish(failure(`${command} sent a message larger than ${Math.round(maxMessageLength / 1024 / 1024)} MiB without a line break.`, stderrTail())); }
    });
    void (async (): Promise<StdioMcpProbeResult> => {
      const initialized = await request("initialize", { protocolVersion: probeProtocolVersion, capabilities: {}, clientInfo: { name: BRAND.slug, version: options.clientVersion ?? "0.0.0" } });
      const info = isRecord(initialized.serverInfo) && typeof initialized.serverInfo.name === "string" ? { name: initialized.serverInfo.name, ...(typeof initialized.serverInfo.version === "string" ? { version: initialized.serverInfo.version } : {}) } : undefined;
      if (!info || typeof initialized.protocolVersion !== "string") return { ...failure("The server answered initialize without serverInfo or protocolVersion.", JSON.stringify(initialized)), ...(info ? { serverInfo: info } : {}) };
      // The agent's client would refuse this server, so the test must not report it as working.
      if (!STDIO_MCP_PROTOCOL_VERSIONS.includes(initialized.protocolVersion)) return { ...failure(`The server uses MCP protocol version ${initialized.protocolVersion}, which is not supported.`, `Supported: ${STDIO_MCP_PROTOCOL_VERSIONS.join(", ")}.`), serverInfo: info };
      write({ method: "notifications/initialized" });
      const tools: string[] = [];
      const capabilities = isRecord(initialized.capabilities) ? initialized.capabilities : {};
      if (capabilities.tools !== undefined) {
        let cursor: string | undefined;
        for (let page = 0; page < MAX_TOOL_PAGES; page++) {
          const listed = await request("tools/list", cursor ? { cursor } : {});
          if (!Array.isArray(listed.tools)) throw new Error("tools/list did not return a tools array.");
          tools.push(...listed.tools.map((tool) => isRecord(tool) && typeof tool.name === "string" ? tool.name : "(unnamed)"));
          cursor = typeof listed.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : undefined;
          if (!cursor) break;
        }
        // The agent's client would give up here too, so this server must not pass the test with a partial list.
        if (cursor) return { ...failure(`The server returned more than ${MAX_TOOL_PAGES} pages from tools/list.`, `${tools.length} tools listed before giving up.`), serverInfo: info };
      }
      const name = `${info.name}${info.version ? ` ${info.version}` : ""}`;
      return {
        succeeded: true,
        summary: `Connected to ${name} (MCP ${initialized.protocolVersion}); ${tools.length} ${tools.length === 1 ? "tool" : "tools"} available.`,
        detail: capabilities.tools === undefined ? "The server does not offer tools." : tools.length ? tools.join(", ") : "The server lists no tools.",
        serverInfo: info,
        protocolVersion: initialized.protocolVersion,
        tools,
      };
    })().then(finish, (error) => finish(failure(`MCP handshake with ${command} failed: ${errorMessage(error)}`, stderrTail())));
  });
}

function failure(summary: string, detail: string): StdioMcpProbeResult {
  return { succeeded: false, summary, detail, tools: [] };
}

/** Ends the server and anything it spawned; npx and cmd.exe shims leave the real server as a grandchild, even after they exit. */
async function terminate(child: ChildProcessWithoutNullStreams, spawnedAt: number, closed: Promise<void>): Promise<void> {
  try { child.stdin.end(); } catch { }
  await reapProcessTree(child, spawnedAt, closed);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
