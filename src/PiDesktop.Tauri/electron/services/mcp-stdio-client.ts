import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BRAND } from "../brand.js";

/**
 * Client for ONE external stdio MCP server (newline-delimited JSON-RPC 2.0, MCP 2025-06-18). The server is untrusted
 * third-party code: every message is validated, unknown server->client requests are refused instead of left hanging,
 * and the process tree is always torn down on close.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
/**
 * Versions a server may answer initialize with. Everything this client uses (tools/list and tools/call, ping, cancellation,
 * tools/list_changed, roots/list) means the same in each; anything else is refused rather than half working.
 */
export const STDIO_MCP_PROTOCOL_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface McpToolAnnotations { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; }
export interface McpToolInfo { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: McpToolAnnotations; }
export interface McpContent { type: string; text?: string; mimeType?: string; uri?: string; name?: string; resource?: { uri?: string; mimeType?: string; text?: string; blob?: string }; [key: string]: unknown; }
export interface McpCallToolResult { content: McpContent[]; structuredContent?: unknown; isError?: boolean; }

export interface McpStdioClientOptions {
  command: string;
  args?: readonly string[];
  /** Merged over the basic inherited variables (serverEnvironment); on Windows keys replace inherited ones case-insensitively (Path vs PATH). */
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  /** Names the server in errors; defaults to the command. */
  label?: string;
  /** clientInfo.version sent in initialize. */
  clientVersion?: string;
  connectTimeoutMs?: number;
  /** Longest single message accepted from the server; defaults to MAX_MESSAGE_LENGTH. */
  maxMessageLength?: number;
  onNotification?(method: string, params: unknown): void;
}

export class McpRpcError extends Error {
  constructor(message: string, readonly code: number, readonly data?: unknown) { super(message); this.name = "McpRpcError"; }
}

interface Pending { method: string; resolve(value: unknown): void; reject(error: Error): void; dispose(): void; }
type State = "idle" | "connecting" | "ready" | "closed";

const STDERR_LINES = 20;
const MAX_LINE_LENGTH = 500;
/** A server that streams a single line beyond this is broken or hostile; it would otherwise grow main-process memory without bound. */
export const MAX_MESSAGE_LENGTH = 64 * 1024 * 1024;
/** tools/list pages a session reads before giving up on a server that keeps returning cursors. */
export const MAX_TOOL_PAGES = 100;
/** Tools, and bytes of tool definitions, kept from one server across all pages; each page is bounded on its own as well. */
export const MAX_TOOLS = 1_000;
export const MAX_TOOL_DEFINITION_BYTES = 8 * 1024 * 1024;
const CLOSE_GRACE_MS = 1_000;

export class McpStdioClient {
  private child?: ChildProcessWithoutNullStreams;
  private state: State = "idle";
  private connecting?: Promise<void>;
  private exited?: Promise<void>;
  /** Settles on "close": every holder of the stdio pipes is gone, including descendants that outlived the direct child. */
  private drained?: Promise<void>;
  private closing?: Promise<void>;
  private spawnedAt = 0;
  private offersTools = true;
  private reason?: string;
  private nextId = 0;
  private stdout = "";
  private stderrPartial = "";
  private readonly pending = new Map<number, Pending>();
  private readonly tail: string[] = [];
  serverInfo?: { name?: string; version?: string };

  constructor(private readonly options: McpStdioClientOptions) {}

  get pid(): number | undefined { return this.child?.pid; }
  get closed(): boolean { return this.state === "closed" || (this.child !== undefined && !running(this.child)); }
  get ready(): boolean { return this.state === "ready" && !this.closed; }
  /** Last stderr lines (and stray non-JSON stdout lines) for diagnostics. */
  stderr(): string[] { return [...this.tail, ...(this.stderrPartial ? [this.stderrPartial.slice(0, MAX_LINE_LENGTH)] : [])]; }

  connect(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.state === "closed") return Promise.reject(this.error(this.reason ?? "is closed"));
    return this.connecting ??= this.handshake();
  }

  async listTools(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<McpToolInfo[]> {
    await this.connect();
    // Servers that only offer resources or prompts may reject tools/list; the Connections probe treats them as having none too.
    if (!this.offersTools) return [];
    const tools: McpToolInfo[] = [], seen = new Set<string>();
    let cursor: string | undefined, bytes = 0;
    // A server that keeps returning cursors would otherwise hold session creation forever.
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await this.request("tools/list", cursor === undefined ? undefined : { cursor }, { signal: options.signal, timeoutMs: options.timeoutMs ?? this.connectTimeout() });
      if (!isRecord(result) || !Array.isArray(result.tools)) throw this.error("answered tools/list without a tools array");
      for (const raw of result.tools) {
        const tool = toolInfo(raw);
        if (!tool || seen.has(tool.name)) continue;
        seen.add(tool.name);
        tools.push(tool);
        bytes += JSON.stringify(raw).length;
        // Many pages that each fit the message limit could still add up to gigabytes in the main process.
        if (tools.length > MAX_TOOLS || bytes > MAX_TOOL_DEFINITION_BYTES) throw this.error(`offers more than ${MAX_TOOLS} tools or ${MAX_TOOL_DEFINITION_BYTES / 1024 / 1024} MiB of tool definitions`);
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (cursor === undefined) return tools;
    }
    throw this.error(`returned more than ${MAX_TOOL_PAGES} pages from tools/list`);
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 120_000): Promise<McpCallToolResult> {
    await this.connect();
    const result = await this.request("tools/call", { name, arguments: args }, { signal, timeoutMs });
    if (!isRecord(result)) throw this.error(`answered tools/call for ${name} without a result object`);
    const content = Array.isArray(result.content) ? result.content.filter((block): block is McpContent => isRecord(block) && typeof block.type === "string") : [];
    return { content, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}), ...(result.isError === true ? { isError: true } : {}) };
  }

  /**
   * Ends stdin so a well-behaved server exits on EOF; a server that ignores it loses its whole process tree after a short grace period.
   * Runs once; later calls share the first shutdown, so every caller can await the cleanup.
   */
  close(graceMs = CLOSE_GRACE_MS): Promise<void> {
    this.fail("was closed");
    return this.closing ??= this.shutdown(graceMs);
  }

  private async shutdown(graceMs: number): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    try { child.stdin.end(); } catch { }
    if (!(await this.waitExit(graceMs))) { await terminateTree(child); await this.waitExit(2_000); }
    // The real server behind a cmd.exe or npx launcher can outlive it, keep the pipes open and ignore EOF. taskkill /T cannot
    // walk from a dead parent, so Windows looks the orphans up by parent pid; POSIX signals the process group the child led.
    if (process.platform !== "win32") await signalGroup(child.pid);
    else if (!(await within(this.drained!, Math.max(graceMs, 250)))) { await killWindowsOrphans(child.pid, this.spawnedAt); await within(this.drained!, 2_000); }
  }

  private connectTimeout(): number { return this.options.connectTimeoutMs ?? 15_000; }
  private label(): string { return this.options.label ?? this.options.command; }

  private async handshake(): Promise<void> {
    this.state = "connecting";
    try {
      this.start();
      const result = await this.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: BRAND.slug, version: this.options.clientVersion ?? "0.0.0" } }, { timeoutMs: this.connectTimeout() });
      if (!isRecord(result) || typeof result.protocolVersion !== "string") throw this.error("answered initialize without a protocolVersion");
      if (!STDIO_MCP_PROTOCOL_VERSIONS.includes(result.protocolVersion)) throw this.error(`answered with MCP protocol version ${result.protocolVersion}, which is not supported (${STDIO_MCP_PROTOCOL_VERSIONS.join(", ")})`);
      if (this.state !== "connecting") throw this.error(this.reason ?? "is closed");
      this.offersTools = isRecord(result.capabilities) && result.capabilities.tools !== undefined;
      if (isRecord(result.serverInfo)) this.serverInfo = { ...(typeof result.serverInfo.name === "string" ? { name: result.serverInfo.name } : {}), ...(typeof result.serverInfo.version === "string" ? { version: result.serverInfo.version } : {}) };
      this.state = "ready";
      this.notify("notifications/initialized");
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private start(): void {
    const env = serverEnvironment(this.options.env);
    const plan = spawnPlan(this.options.command, this.options.args ?? [], env, this.options.cwd);
    // POSIX children lead their own process group so close() can take down grandchildren (npx -> node) too.
    const child = spawn(plan.file, plan.args, { cwd: this.options.cwd, env, windowsHide: true, shell: false, windowsVerbatimArguments: plan.verbatim, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.spawnedAt = Date.now();
    let markExited!: () => void, markDrained!: () => void;
    this.exited = new Promise(done => { markExited = done; });
    this.drained = new Promise(done => { markDrained = done; });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => this.onStderr(chunk));
    // Writes after the server died fail with EPIPE; the exit handler reports that, so the stream error must not crash the host.
    child.stdin.on("error", () => { });
    child.once("error", (error: NodeJS.ErrnoException) => {
      markExited();
      markDrained();
      this.fail(error.code === "ENOENT" ? `could not be started: command "${this.options.command}" was not found. Check that it is installed and on PATH` : `could not be started: ${error.message}`);
    });
    const exitReason = (code: number | null, signal: NodeJS.Signals | null) => signal ? `was terminated by ${signal}` : `exited with code ${code}`;
    child.once("close", (code, signal) => { markDrained(); this.fail(exitReason(code, signal)); });
    child.once("exit", (code, signal) => {
      markExited();
      // Let buffered stdout/stderr drain first; "close" normally follows within milliseconds unless a grandchild still holds the pipes.
      // An exit nobody asked for still gets close(), because a launcher can die while the real server keeps running behind it.
      setTimeout(() => { this.fail(exitReason(code, signal)); void this.close(); }, 100).unref();
    });
  }

  private fail(reason: string): void {
    if (this.state !== "closed") { this.state = "closed"; this.reason = reason; }
    if (!this.pending.size) return;
    const error = this.error(this.reason ?? reason);
    for (const [id, pending] of [...this.pending]) { this.pending.delete(id); pending.dispose(); pending.reject(error); }
  }

  private error(reason: string): Error {
    const tail = this.stderr();
    return new Error(`MCP server "${this.label()}" ${reason}.${tail.length ? `\nRecent server output:\n${tail.join("\n")}` : ""}`);
  }

  private request(method: string, params: unknown, options: { signal?: AbortSignal; timeoutMs: number }): Promise<unknown> {
    if (this.state === "closed") return Promise.reject(this.error(this.reason ?? "is closed"));
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal));
    const id = ++this.nextId;
    return new Promise((resolvePromise, reject) => {
      const forget = (reason: string): boolean => {
        if (!this.pending.delete(id)) return false;
        dispose();
        // The spec forbids cancelling initialize; the client is torn down instead.
        if (method !== "initialize") this.notify("notifications/cancelled", { requestId: id, reason });
        return true;
      };
      const timer = setTimeout(() => { if (forget("timeout")) reject(this.error(`did not answer ${method} within ${Math.round(options.timeoutMs / 100) / 10} s`)); }, options.timeoutMs);
      const onAbort = () => { if (forget("The user cancelled the request.")) reject(abortError(options.signal!)); };
      const dispose = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { method, resolve: resolvePromise, reject, dispose });
      if (!this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })) { this.pending.delete(id); dispose(); reject(this.error(this.reason ?? "is not running")); }
    });
  }

  private notify(method: string, params?: unknown): void { this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }); }

  private send(message: Record<string, unknown>): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  private onStdout(chunk: string): void {
    const lines = (this.stdout + chunk).split("\n");
    this.stdout = lines.pop() ?? "";
    // Finished lines and the unfinished tail both count, before anything is parsed or kept in the main process.
    const limit = this.options.maxMessageLength ?? MAX_MESSAGE_LENGTH;
    if (this.stdout.length > limit || lines.some(line => line.length > limit)) { this.stdout = ""; this.fail(`sent a message larger than ${Math.round(limit / 1024 / 1024)} MiB`); void this.close(0); return; }
    for (const line of lines) this.onLine(line.trim());
  }

  private onStderr(chunk: string): void {
    const lines = (this.stderrPartial + chunk).split(/\r?\n/);
    this.stderrPartial = (lines.pop() ?? "").slice(-MAX_LINE_LENGTH * 4);
    for (const line of lines) if (line.trim()) this.remember(line);
  }

  private remember(line: string): void { this.tail.push(line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}...` : line); if (this.tail.length > STDERR_LINES) this.tail.splice(0, this.tail.length - STDERR_LINES); }

  private onLine(line: string): void {
    if (!line) return;
    let message: unknown;
    // Servers sometimes print banners or logs to stdout; they are not protocol messages and must not break the session.
    try { message = JSON.parse(line); } catch { this.remember(`[stdout] ${line}`); return; }
    for (const item of Array.isArray(message) ? message : [message]) if (isRecord(item)) this.onMessage(item);
  }

  private onMessage(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof message.method === "string") {
      if (id === undefined || id === null) { try { this.options.onNotification?.(message.method, message.params); } catch { } return; }
      if (typeof id !== "string" && typeof id !== "number") return;
      // This client declares no capabilities, so sampling, roots and elicitation are refused rather than left to time out.
      if (message.method === "ping") this.send({ jsonrpc: "2.0", id, result: {} });
      else this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      return;
    }
    // A log object that happens to carry an id is not an answer; only a proper envelope may settle a request.
    if (!isJsonRpcResponse(message)) { this.remember("[stdout] ignored a message that is not a JSON-RPC 2.0 response"); return; }
    const key = typeof id === "number" ? id : typeof id === "string" && /^\d+$/.test(id) ? Number(id) : undefined;
    const pending = key === undefined ? undefined : this.pending.get(key);
    if (!pending || key === undefined) return;
    this.pending.delete(key);
    pending.dispose();
    if (isRecord(message.error)) pending.reject(new McpRpcError(`MCP server "${this.label()}" rejected ${pending.method}: ${typeof message.error.message === "string" ? message.error.message : "unknown error"}`, typeof message.error.code === "number" ? message.error.code : -32603, message.error.data));
    else pending.resolve(message.result);
  }

  private async waitExit(ms: number): Promise<boolean> {
    const child = this.child;
    return !child || !running(child) || within(this.exited!, ms);
  }
}

/** A JSON-RPC 2.0 response carries the version and exactly one of result and error. */
export function isJsonRpcResponse(message: Record<string, unknown>): boolean {
  return message.jsonrpc === "2.0" && Object.hasOwn(message, "result") !== Object.hasOwn(message, "error");
}

export interface SpawnPlan { file: string; args: string[]; verbatim: boolean; }

/**
 * Windows cannot CreateProcess a .cmd/.bat shim (npx, pnpm, globally installed npm servers), and Node refuses them without
 * a shell since CVE-2024-27980. Instead of shell:true (which joins args unquoted), the command is resolved through PATH and
 * PATHEXT like cmd.exe would. Real executables (node.exe, uvx.exe, python.exe) are spawned directly. Batch shims run as
 * `cmd.exe /d /s /c ""<shim>" <args>"` with verbatim arguments, each argument quoted per MSVCRT rules and every cmd
 * metacharacter caret-escaped twice, because npm-style shims forward %* and cmd re-parses that line (the cross-spawn
 * approach). /d skips AutoRun hooks.
 */
export function spawnPlan(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd?: string, platform: NodeJS.Platform = process.platform): SpawnPlan {
  if (platform !== "win32") return { file: command, args: [...args], verbatim: false };
  const resolved = resolveWindowsCommand(command, env, cwd);
  if (!resolved || !/\.(cmd|bat)$/i.test(resolved)) return { file: resolved ?? command, args: [...args], verbatim: false };
  const line = [`"${resolved}"`, ...args.map(arg => escapeBatchArgument(arg))].join(" ");
  return { file: envValue(env, "ComSpec") ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

export function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv, cwd?: string): string | undefined {
  const extensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").map(item => item.trim().toLowerCase()).filter(Boolean);
  const names = extensions.includes(extname(command).toLowerCase()) ? [command] : extensions.map(extension => `${command}${extension}`);
  const explicit = isAbsolute(command) || /[\\/]/.test(command);
  const directories = explicit ? [resolve(cwd ?? process.cwd())] : (envValue(env, "PATH") ?? "").split(delimiter).map(item => item.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  for (const directory of directories) for (const name of names) {
    const candidate = explicit ? resolve(directory, name) : join(directory, name);
    try { if (statSync(candidate).isFile()) return candidate; } catch { }
  }
  return undefined;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeBatchArgument(argument: string): string {
  const quoted = `"${argument.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(item => item.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** Windows environment names are case-insensitive; a configured PATH must replace the inherited Path, not sit beside it. */
/** What a local MCP server inherits from the app, as the official MCP stdio transport does (plus what Windows shims need). */
export function inheritedEnvironmentNames(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === "win32"
    ? ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PATHEXT", "COMSPEC", "PROCESSOR_ARCHITECTURE", "PROGRAMFILES", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERNAME", "USERPROFILE"]
    : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "TMPDIR", "LANG"];
}

/**
 * A third-party server sees only the basics plus its own configured `env`: the app may have been started with API keys or
 * other secrets in its environment that no server should receive unasked.
 */
export function serverEnvironment(extra: Readonly<Record<string, string>> | undefined, base: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const name of inheritedEnvironmentNames(platform)) {
    const value = base[name];
    // Exported bash functions start with "()" and must not reach a child that may run a shell.
    if (value !== undefined && !value.startsWith("()")) inherited[name] = value;
  }
  return mergeEnv(inherited, extra, platform) as Record<string, string>;
}

export function mergeEnv(base: NodeJS.ProcessEnv, extra: Readonly<Record<string, string>> | undefined, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (platform === "win32") for (const existing of Object.keys(env)) if (existing !== key && existing.toUpperCase() === key.toUpperCase()) delete env[existing];
    env[key] = value;
  }
  return env;
}

function running(child: ChildProcessWithoutNullStreams): boolean { return child.pid !== undefined && child.exitCode === null && child.signalCode === null; }

async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>(done => { timer = setTimeout(() => done(false), ms); });
  try { return await Promise.race([promise.then(() => true), timedOut]); } finally { clearTimeout(timer); }
}

/**
 * Ends a child and everything it started, for callers that manage their own child (the Connections probe). A launcher (npx,
 * cmd.exe) may already have exited while the real server keeps the pipes open; `closed` settles on the child's "close" event,
 * once no process holds them any more.
 */
export async function reapProcessTree(child: ChildProcessWithoutNullStreams, spawnedAt: number, closed: Promise<unknown>): Promise<void> {
  if (!child.pid) return;
  if (child.exitCode === null && child.signalCode === null) await terminateTree(child);
  if (process.platform !== "win32") await signalGroup(child.pid);
  else if (!(await within(closed, 250))) { await killWindowsOrphans(child.pid, spawnedAt); await within(closed, 2_000); }
}

async function terminateTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") return taskkill(child.pid);
  if (await signalGroup(child.pid)) return;
  try { child.kill("SIGTERM"); } catch { }
  await delay(300);
  try { child.kill("SIGKILL"); } catch { }
}

/** SIGTERM, then SIGKILL, to the process group the child led (it was spawned detached). False when no such group exists. */
async function signalGroup(pid: number): Promise<boolean> {
  try { process.kill(-pid, "SIGTERM"); } catch { return false; }
  await delay(300);
  try { process.kill(-pid, "SIGKILL"); } catch { }
  return true;
}

function taskkill(pid: number): Promise<void> {
  return new Promise<void>((done) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
    killer.once("error", () => done());
    killer.once("close", () => done());
    setTimeout(() => done(), 3_000).unref();
  });
}

const PROCESS_TABLE = "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() } }";
const FILETIME_UNIX_EPOCH_MS = 11_644_473_600_000;

/**
 * Windows keeps a process's parent pid after the parent exits, so a dead child's orphans can still be found (taskkill /T then
 * takes their subtrees). Only processes created after the spawn qualify, and when the pid was reused, only those older than the reuser.
 */
async function killWindowsOrphans(pid: number, spawnedAt: number): Promise<void> {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // The first WMI query after the service went idle can take well over ten seconds; giving up early would leave the orphans running.
  const table = await capture(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(PROCESS_TABLE, "utf16le").toString("base64")], 30_000);
  const rows = table.split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === 3 && row.every(Number.isFinite)).map(([id, parent, created]) => ({ id: id!, parent: parent!, created: created! / 10_000 - FILETIME_UNIX_EPOCH_MS }));
  // The dead child itself may still be listed (created right at spawn); any other holder of its pid is a newer process whose children are not ours.
  const holder = rows.find(row => row.id === pid && Math.abs(row.created - spawnedAt) > 1_000);
  for (const row of rows) if (row.parent === pid && row.id !== pid && row.id !== process.pid && row.created >= spawnedAt - 2_000 && (!holder || row.created < holder.created)) await taskkill(row.id);
}

function capture(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((done) => {
    let output = "";
    const child = spawn(file, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => { try { child.kill(); } catch { } done(output); }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.once("error", () => { clearTimeout(timer); done(output); });
    child.once("close", () => { clearTimeout(timer); done(output); });
  });
}

function toolInfo(raw: unknown): McpToolInfo | undefined {
  if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) return undefined;
  const annotations = isRecord(raw.annotations) ? raw.annotations : undefined;
  const hints: McpToolAnnotations = {};
  if (annotations) {
    if (typeof annotations.title === "string") hints.title = annotations.title;
    for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) if (typeof annotations[key] === "boolean") hints[key] = annotations[key] as boolean;
  }
  return {
    name: raw.name,
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(isRecord(raw.inputSchema) ? { inputSchema: raw.inputSchema } : {}),
    ...(annotations ? { annotations: hints } : {}),
  };
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : Object.assign(new Error("The MCP request was cancelled."), { name: "AbortError" });
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
