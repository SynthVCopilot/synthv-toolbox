import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { BRAND } from "../brand.js";

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
}

export interface StdioMcpProbeResult {
  succeeded: boolean;
  summary: string;
  detail: string;
  serverInfo?: { name: string; version?: string };
  protocolVersion?: string;
  tools: string[];
}

interface Launch { file: string; args: string[]; verbatim: boolean }

const probeProtocolVersion = "2025-06-18";
const maxToolPages = 50;
const stderrLimit = 8_192;
/** Mirrors the official SDK's StdioClientTransport: user-configured servers inherit only these, plus their own env. */
const inheritedEnvironment = process.platform === "win32"
  ? ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PATHEXT", "COMSPEC", "PROCESSOR_ARCHITECTURE", "PROGRAMFILES", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERNAME", "USERPROFILE"]
  : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "TMPDIR", "LANG"];

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
  const env = probeEnvironment(config.env);
  const launch = await launchFor(command, config.args ?? [], env, config.cwd);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(launch.file, launch.args, { cwd: config.cwd, env, stdio: "pipe", windowsHide: true, windowsVerbatimArguments: launch.verbatim, detached: process.platform !== "win32" });
  } catch (error) {
    return failure(`Could not start ${command}: ${errorMessage(error)}`, "");
  }
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
      void terminate(child).then(() => resolveProbe(result));
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
    });
    void (async (): Promise<StdioMcpProbeResult> => {
      const initialized = await request("initialize", { protocolVersion: probeProtocolVersion, capabilities: {}, clientInfo: { name: BRAND.slug, version: options.clientVersion ?? "0.0.0" } });
      const info = isRecord(initialized.serverInfo) && typeof initialized.serverInfo.name === "string" ? { name: initialized.serverInfo.name, ...(typeof initialized.serverInfo.version === "string" ? { version: initialized.serverInfo.version } : {}) } : undefined;
      if (!info || typeof initialized.protocolVersion !== "string") return { ...failure("The server answered initialize without serverInfo or protocolVersion.", JSON.stringify(initialized)), ...(info ? { serverInfo: info } : {}) };
      write({ method: "notifications/initialized" });
      const tools: string[] = [];
      const capabilities = isRecord(initialized.capabilities) ? initialized.capabilities : {};
      if (capabilities.tools !== undefined) {
        let cursor: string | undefined;
        for (let page = 0; page < maxToolPages; page++) {
          const listed = await request("tools/list", cursor ? { cursor } : {});
          if (!Array.isArray(listed.tools)) throw new Error("tools/list did not return a tools array.");
          tools.push(...listed.tools.map((tool) => isRecord(tool) && typeof tool.name === "string" ? tool.name : "(unnamed)"));
          cursor = typeof listed.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : undefined;
          if (!cursor) break;
        }
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

function probeEnvironment(overrides: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of inheritedEnvironment) {
    const value = process.env[name];
    if (value !== undefined && !value.startsWith("()")) env[name] = value;
  }
  return { ...env, ...overrides };
}

/**
 * Windows cannot spawn .cmd/.bat shims (npx, uvx wrappers) without cmd.exe, and cmd.exe re-parses the whole line,
 * so those go through cmd with every argument quoted and its metacharacters caret-escaped (the cross-spawn rules).
 */
async function launchFor(command: string, args: string[], env: Record<string, string>, cwd: string | undefined): Promise<Launch> {
  if (process.platform !== "win32") return { file: command, args, verbatim: false };
  const resolved = await resolveWindowsCommand(command, env, cwd);
  if (!resolved || !/\.(?:cmd|bat)$/i.test(resolved)) return { file: resolved ?? command, args, verbatim: false };
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
  const line = [escapeCommand(resolved), ...args.map((arg) => escapeArgument(arg, doubleEscape))].join(" ");
  return { file: env.COMSPEC || process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

async function resolveWindowsCommand(command: string, env: Record<string, string>, cwd: string | undefined): Promise<string | undefined> {
  const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const names = extensions.some((extension) => extension.toLowerCase() === extname(command).toLowerCase()) ? [command] : extensions.map((extension) => `${command}${extension}`);
  const hasDirectory = /[\\/]/.test(command);
  const directories = hasDirectory ? [isAbsolute(command) ? "" : resolve(cwd ?? process.cwd())] : (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = directory ? join(directory, name) : name;
      try { if ((await stat(candidate)).isFile()) return candidate; } catch {}
    }
  }
  return undefined;
}

const metaCharacters = /([()\][%!^"`<>&|;, *?])/g;
function escapeCommand(command: string): string { return command.replace(metaCharacters, "^$1"); }
function escapeArgument(argument: string, doubleEscape: boolean): string {
  const quoted = `"${argument.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\*)$/, "$1$1")}"`.replace(metaCharacters, "^$1");
  return doubleEscape ? quoted.replace(metaCharacters, "^$1") : quoted;
}

/** Ends the server and anything it spawned; npx and cmd.exe shims leave the real server as a grandchild. */
async function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("close", () => done()));
  child.stdin.end();
  if (process.platform === "win32") {
    const taskkill = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    taskkill.once("error", () => child.kill());
  } else {
    killGroup(child, "SIGTERM");
  }
  const stopped = await Promise.race([exited.then(() => true), delay(3_000).then(() => false)]);
  if (stopped) return;
  if (process.platform === "win32") child.kill(); else killGroup(child, "SIGKILL");
  await Promise.race([exited, delay(1_000)]);
}

function killGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try { process.kill(-child.pid!, signal); } catch { child.kill(signal); }
}

function delay(ms: number): Promise<void> { return new Promise((done) => { setTimeout(done, ms).unref(); }); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
