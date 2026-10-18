import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { BRAND } from "../brand.js";

/**
 * Client for ONE external stdio MCP server (newline-delimited JSON-RPC 2.0, MCP 2025-06-18). The server is untrusted
 * third-party code: every message is validated, unknown server->client requests are refused instead of left hanging,
 * and the process tree is always torn down on close.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpToolAnnotations { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; }
export interface McpToolInfo { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: McpToolAnnotations; }
export interface McpContent { type: string; text?: string; mimeType?: string; uri?: string; name?: string; resource?: { uri?: string; mimeType?: string; text?: string; blob?: string }; [key: string]: unknown; }
export interface McpCallToolResult { content: McpContent[]; structuredContent?: unknown; isError?: boolean; }

export interface McpStdioClientOptions {
  command: string;
  args?: readonly string[];
  /** Merged over process.env; on Windows keys replace inherited ones case-insensitively (Path vs PATH). */
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  /** Names the server in errors; defaults to the command. */
  label?: string;
  /** clientInfo.version sent in initialize. */
  clientVersion?: string;
  connectTimeoutMs?: number;
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
const MAX_MESSAGE_LENGTH = 64 * 1024 * 1024;
const CLOSE_GRACE_MS = 1_000;

export class McpStdioClient {
  private child?: ChildProcessWithoutNullStreams;
  private state: State = "idle";
  private connecting?: Promise<void>;
  private exited?: Promise<void>;
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
    const tools: McpToolInfo[] = [], seen = new Set<string>();
    let cursor: string | undefined;
    // A server that keeps returning cursors would otherwise hold session creation forever.
    for (let page = 0; page < 100; page++) {
      const result = await this.request("tools/list", cursor === undefined ? undefined : { cursor }, { signal: options.signal, timeoutMs: options.timeoutMs ?? this.connectTimeout() });
      if (!isRecord(result) || !Array.isArray(result.tools)) throw this.error("answered tools/list without a tools array");
      for (const raw of result.tools) { const tool = toolInfo(raw); if (tool && !seen.has(tool.name)) { seen.add(tool.name); tools.push(tool); } }
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (cursor === undefined) return tools;
    }
    throw this.error("returned more than 100 pages from tools/list");
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 120_000): Promise<McpCallToolResult> {
    await this.connect();
    const result = await this.request("tools/call", { name, arguments: args }, { signal, timeoutMs });
    if (!isRecord(result)) throw this.error(`answered tools/call for ${name} without a result object`);
    const content = Array.isArray(result.content) ? result.content.filter((block): block is McpContent => isRecord(block) && typeof block.type === "string") : [];
    return { content, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}), ...(result.isError === true ? { isError: true } : {}) };
  }

  /** Ends stdin so a well-behaved server exits on EOF; a server that ignores it loses its whole process tree after a short grace period. */
  async close(graceMs = CLOSE_GRACE_MS): Promise<void> {
    this.fail("was closed");
    const child = this.child;
    if (!child || !running(child)) return;
    try { child.stdin.end(); } catch { }
    if (await this.waitExit(graceMs)) return;
    await terminateTree(child);
    await this.waitExit(2_000);
  }

  private connectTimeout(): number { return this.options.connectTimeoutMs ?? 15_000; }
  private label(): string { return this.options.label ?? this.options.command; }

  private async handshake(): Promise<void> {
    this.state = "connecting";
    try {
      this.start();
      const result = await this.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: BRAND.slug, version: this.options.clientVersion ?? "0.0.0" } }, { timeoutMs: this.connectTimeout() });
      if (!isRecord(result) || typeof result.protocolVersion !== "string") throw this.error("answered initialize without a protocolVersion");
      if (this.state !== "connecting") throw this.error(this.reason ?? "is closed");
      if (isRecord(result.serverInfo)) this.serverInfo = { ...(typeof result.serverInfo.name === "string" ? { name: result.serverInfo.name } : {}), ...(typeof result.serverInfo.version === "string" ? { version: result.serverInfo.version } : {}) };
      this.state = "ready";
      this.notify("notifications/initialized");
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private start(): void {
    const env = mergeEnv(process.env, this.options.env);
    const plan = spawnPlan(this.options.command, this.options.args ?? [], env, this.options.cwd);
    // POSIX children lead their own process group so close() can take down grandchildren (npx -> node) too.
    const child = spawn(plan.file, plan.args, { cwd: this.options.cwd, env, windowsHide: true, shell: false, windowsVerbatimArguments: plan.verbatim, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    let markExited!: () => void;
    this.exited = new Promise(done => { markExited = done; });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => this.onStderr(chunk));
    // Writes after the server died fail with EPIPE; the exit handler reports that, so the stream error must not crash the host.
    child.stdin.on("error", () => { });
    child.once("error", (error: NodeJS.ErrnoException) => {
      markExited();
      this.fail(error.code === "ENOENT" ? `could not be started: command "${this.options.command}" was not found. Check that it is installed and on PATH` : `could not be started: ${error.message}`);
    });
    const exitReason = (code: number | null, signal: NodeJS.Signals | null) => signal ? `was terminated by ${signal}` : `exited with code ${code}`;
    child.once("close", (code, signal) => this.fail(exitReason(code, signal)));
    child.once("exit", (code, signal) => {
      markExited();
      // Let buffered stdout/stderr drain first; "close" normally follows within milliseconds unless a grandchild still holds the pipes.
      setTimeout(() => this.fail(exitReason(code, signal)), 100).unref();
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
    if (!chunk.includes("\n")) {
      this.stdout += chunk;
      if (this.stdout.length > MAX_MESSAGE_LENGTH) { this.stdout = ""; this.fail("sent a message larger than 64 MiB"); void this.close(0); }
      return;
    }
    const lines = (this.stdout + chunk).split("\n");
    this.stdout = lines.pop() ?? "";
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
    if (!child || !running(child)) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>(done => { timer = setTimeout(() => done(false), ms); });
    try { return await Promise.race([this.exited!.then(() => true), timedOut]); } finally { clearTimeout(timer); }
  }
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
export function mergeEnv(base: NodeJS.ProcessEnv, extra: Readonly<Record<string, string>> | undefined, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (platform === "win32") for (const existing of Object.keys(env)) if (existing !== key && existing.toUpperCase() === key.toUpperCase()) delete env[existing];
    env[key] = value;
  }
  return env;
}

function running(child: ChildProcessWithoutNullStreams): boolean { return child.pid !== undefined && child.exitCode === null && child.signalCode === null; }

async function terminateTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((done) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
      killer.once("error", () => done());
      killer.once("close", () => done());
      setTimeout(() => done(), 3_000).unref();
    });
    return;
  }
  let hasProcessGroup = true;
  try { process.kill(-child.pid, "SIGTERM"); } catch {
    hasProcessGroup = false;
    try { child.kill("SIGTERM"); } catch { }
  }
  await new Promise((done) => setTimeout(done, 300));
  if (hasProcessGroup) try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { } }
  else try { child.kill("SIGKILL"); } catch { }
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

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : Object.assign(new Error("The MCP request was cancelled."), { name: "AbortError" });
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
