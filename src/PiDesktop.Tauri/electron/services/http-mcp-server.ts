import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BRAND } from "../brand.js";
import { hostResultToToolResult, toStructuredContent, toToolContent, toolboxAgentMcpTool } from "./mcp-tools.js";

/** Newest first; initialize echoes the client's version when listed here and otherwise offers the fallback. */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const MCP_SERVER_NAME = BRAND.slug;
const fallbackProtocolVersion = "2025-06-18";
const internalTool = "toolbox_internal";
const advancedTool = "toolbox_advanced";
const agentTaskTool = "toolbox_agent";
const requestTimeoutMs = 30_000;
const headersTimeoutMs = 10_000;
const closeGraceMs = 2_000;
const maxBodyBytes = 1_048_576;
const defaultInstructions = "toolbox_agent runs the app's own agent asynchronously: call action \"start\" with input, then poll action \"status\" with the returned taskId every few seconds until status is no longer running or cancelling; when it is needs_input, answer with action \"continue\" (conversationId, input). toolbox_internal and toolbox_advanced take {capability, operation, params}; their descriptions list the supported operations and params is always an object.";

/** Error whose message is safe to return to the client; the marker lets other modules raise it without importing this one. */
export class ClientError extends Error { readonly clientSafe = true; }

function isClientError(error: unknown): error is Error {
  return error instanceof Error && (error as { clientSafe?: unknown }).clientSafe === true;
}

export interface McpAuthorization {
  internalEnabled: boolean;
  advancedEnabled: boolean;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  permission?: "internal" | "advanced";
}

export interface McpServerIdentity {
  name: string;
  title: string;
  version: string;
  instructions?: string;
}

export interface RuntimeMcpHost {
  mcpTools(authorization: McpAuthorization): Promise<McpTool[]>;
  callMcpTool(name: string, arguments_: Record<string, unknown>, authorization: McpAuthorization): Promise<{ content: unknown; structuredContent?: unknown; isError?: boolean }>;
  agentChat?(input: string, conversationId?: string): Promise<unknown>;
  agentTask?(args: Record<string, unknown>): Promise<unknown>;
}

export interface HttpMcpConfig extends McpAuthorization {
  enabled: boolean;
  agentEnabled: boolean;
  port: number;
  /** Bearer token every /mcp and /agent request must present. */
  token: string;
}

export interface HttpMcpStatus extends HttpMcpConfig {
  running: boolean;
  serverName: string;
  endpoint?: string;
  agentEndpoint?: string;
  lastError?: string;
}

interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

/** Loopback-only MCP transport; authorization is evaluated for every tool list and call. */
export class HttpMcpServer {
  private server?: Server;
  private config?: HttpMcpConfig;
  private boundPort?: number;
  private lastError?: string;

  constructor(private readonly host: RuntimeMcpHost, private readonly identity: McpServerIdentity = { name: MCP_SERVER_NAME, title: BRAND.productName, version: "0.0.0" }) {}

  async start(config: HttpMcpConfig): Promise<HttpMcpStatus> {
    validateConfig(config);
    if (!config.enabled && !config.agentEnabled) {
      await this.stop();
      this.config = config;
      return this.status();
    }
    if (this.server && sameConfig(this.config, config)) return this.status();
    // Only the token changed: requests read this.config as they arrive, so the old token stops working at once while
    // requests already in flight (an agent run can take minutes) finish instead of holding up the rotation.
    if (this.server?.listening && this.config && sameConfig({ ...this.config, token: config.token }, config)) {
      this.config = { ...config };
      return this.status();
    }
    await this.stop();
    this.config = { ...config };
    try {
      const server = createServer((request, response) => {
        this.handleRequest(request, response).catch((error) => {
          console.error("MCP request failed:", error);
          if (!response.headersSent) send(response, 500, { error: "Internal server error." });
          else response.destroy();
        });
      });
      server.requestTimeout = requestTimeoutMs;
      server.headersTimeout = headersTimeoutMs;
      server.on("error", (error) => { this.lastError = error.message; });
      await listen(server, config.port);
      this.server = server;
      const address = server.address();
      this.boundPort = typeof address === "object" && address ? address.port : config.port;
      this.lastError = undefined;
      return this.status();
    } catch (error) {
      this.lastError = errorMessage(error);
      return this.status();
    }
  }

  async stop(): Promise<HttpMcpStatus> {
    const server = this.server;
    this.server = undefined;
    this.boundPort = undefined;
    if (server) await close(server);
    return this.status();
  }

  async restart(config: HttpMcpConfig): Promise<HttpMcpStatus> {
    await this.stop();
    return this.start(config);
  }

  status(): HttpMcpStatus {
    const config = this.config ?? disabledConfig();
    const running = Boolean(this.server?.listening);
    const port = this.boundPort ?? config.port;
    return {
      ...config,
      running,
      serverName: this.identity.name,
      ...(config.enabled && running ? { endpoint: `http://127.0.0.1:${port}/mcp` } : {}),
      ...(config.agentEnabled && running ? { agentEndpoint: `http://127.0.0.1:${port}/agent` } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const config = this.config;
    if (!config) return send(response, 503, { error: "MCP server is not configured." });
    const boundaryError = requestBoundaryError(request, this.boundPort);
    if (boundaryError) return send(response, 403, { error: boundaryError });
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path !== "/mcp" && path !== "/agent") return send(response, 404, { error: "Not found." });
    if (!hasBearerToken(request, config.token)) return send(response, 401, { error: "A valid bearer token is required." }, { "WWW-Authenticate": `Bearer realm="${BRAND.slug}"` });
    if (request.method !== "POST") return send(response, 405, { error: "Method not allowed." }, { Allow: "POST" });
    return path === "/mcp" ? this.handleMcp(request, response, config) : this.handleAgent(request, response, config);
  }

  private async handleMcp(request: IncomingMessage, response: ServerResponse, config: HttpMcpConfig): Promise<void> {
    if (!config.enabled) return send(response, 404, { error: "MCP is disabled." });
    if (!isJsonRequest(request)) return send(response, 415, { error: "Content-Type must be application/json." });
    const body = await readBody(request);
    if (body instanceof BodyError) return send(response, body.status, { error: body.message });
    const parsed = parseJson(body);
    if (!parsed) return send(response, 400, rpcError(null, -32700, "Parse error."));
    const message = parsed.value;
    const id = isRecord(message) && isRequestId(message.id) ? message.id : null;
    const version = request.headers["mcp-protocol-version"];
    if (typeof version === "string" && !(isRecord(message) && message.method === "initialize") && !isSupportedVersion(version)) {
      return send(response, 400, rpcError(id, -32600, `Unsupported MCP-Protocol-Version ${version}; supported versions are ${SUPPORTED_MCP_PROTOCOL_VERSIONS.join(", ")}.`));
    }
    try {
      if (Array.isArray(message)) {
        // 2025-03-26 servers must accept batches; later revisions dropped them, and accepting one costs nothing.
        if (!message.length) return send(response, 400, rpcError(null, -32600, "Invalid JSON-RPC request."));
        const replies: Array<Record<string, unknown>> = [];
        for (const item of message) if (!needsNoReply(item)) replies.push(isRequestMessage(item) ? await this.handleRpc(item) : rpcError(isRecord(item) && isRequestId(item.id) ? item.id : null, -32600, "Invalid JSON-RPC request."));
        return replies.length ? send(response, 200, replies) : send(response, 202);
      }
      if (needsNoReply(message)) return send(response, 202);
      if (!isRequestMessage(message)) return send(response, 400, rpcError(id, -32600, "Invalid JSON-RPC request."));
      return send(response, 200, await this.handleRpc(message));
    } catch (error) {
      console.error("MCP response failed:", error);
      return send(response, 500, rpcError(id, -32603, "Internal error."));
    }
  }

  private async handleAgent(request: IncomingMessage, response: ServerResponse, config: HttpMcpConfig): Promise<void> {
    if (!config.agentEnabled || !this.host.agentChat) return send(response, 404, { error: "Agent endpoint is disabled." });
    if (!isJsonRequest(request)) return send(response, 415, { error: "Content-Type must be application/json." });
    const body = await readBody(request);
    if (body instanceof BodyError) return send(response, body.status, { error: body.message });
    const value = parseJson(body)?.value;
    if (!isRecord(value) || typeof value.input !== "string") return send(response, 400, { error: "Agent input is required." });
    try {
      return send(response, 200, { messages: await this.host.agentChat(value.input, typeof value.conversationId === "string" ? value.conversationId : undefined) });
    } catch (error) {
      if (isClientError(error)) return send(response, 409, { error: error.message });
      console.error("Agent request failed:", error);
      return send(response, 500, { error: "Agent request failed." });
    }
  }

  private async handleRpc(request: JsonRpcRequest): Promise<Record<string, unknown>> {
    const id = request.id;
    try {
      switch (request.method) {
        case "initialize":
          return rpcResult(id, {
            protocolVersion: negotiatedVersion(request.params),
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.identity.name, title: this.identity.title, version: this.identity.version },
            instructions: this.identity.instructions ?? defaultInstructions,
          });
        case "ping":
          return rpcResult(id, {});
        case "tools/list":
          return rpcResult(id, { tools: (await this.listTools()).map(({ permission: _, ...tool }) => tool) });
        case "tools/call":
          return rpcResult(id, await this.callTool(request.params));
        default:
          return rpcError(id, -32601, "Method not found.");
      }
    } catch (error) {
      if (isClientError(error)) return rpcError(id, -32602, error.message);
      console.error("MCP request failed:", error);
      return rpcError(id, -32603, "Internal error.");
    }
  }

  private authorization(): McpAuthorization {
    const config = this.config ?? disabledConfig();
    return { internalEnabled: config.internalEnabled, advancedEnabled: config.advancedEnabled };
  }

  private async availableTools(authorization: McpAuthorization): Promise<McpTool[]> {
    const tools = [...await this.host.mcpTools(authorization)];
    if (this.config?.enabled && this.config.agentEnabled && this.host.agentTask) tools.push(toolboxAgentMcpTool());
    return tools;
  }

  private async listTools(): Promise<McpTool[]> {
    const authorization = this.authorization();
    return (await this.availableTools(authorization)).filter((tool) => isToolPermitted(tool, authorization));
  }

  private async callTool(params: unknown): Promise<Record<string, unknown>> {
    if (!isRecord(params) || typeof params.name !== "string") throw new ClientError("tools/call requires a tool name.");
    const authorization = this.authorization();
    const tool = (await this.availableTools(authorization)).find((candidate) => candidate.name === params.name);
    if (!tool || !isToolPermitted(tool, authorization)) throw new ClientError("Tool is disabled or unavailable.");
    const arguments_ = isRecord(params.arguments) ? withoutPermission(params.arguments) : {};
    let output: unknown;
    try {
      output = tool.name === agentTaskTool ? await this.host.agentTask!(arguments_) : await this.host.callMcpTool(tool.name, arguments_, authorization);
    } catch (error) {
      // Execution failures go back as tool results so the model can read them and correct its call.
      if (isClientError(error)) return { content: [{ type: "text", text: error.message }], isError: true };
      if (error instanceof Error) return { content: [{ type: "text", text: `Toolbox operation failed: ${error.message}` }], isError: true };
      throw error;
    }
    // Serialization stays outside the try above: its failures are server faults and must not echo internals.
    const result: { content: unknown; structuredContent?: unknown; isError?: boolean } = tool.name === agentTaskTool ? hostResultToToolResult(output) : output as { content: unknown };
    return { content: toToolContent(result.content), ...(result.structuredContent === undefined ? {} : { structuredContent: toStructuredContent(result.structuredContent) }), isError: result.isError === true };
  }
}

class BodyError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function disabledConfig(): HttpMcpConfig {
  return { enabled: false, agentEnabled: false, internalEnabled: false, advancedEnabled: false, port: 0, token: "" };
}

function validateConfig(config: HttpMcpConfig): void {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) throw new Error("MCP port must be between 0 and 65535.");
  if ((config.enabled || config.agentEnabled) && (typeof config.token !== "string" || !config.token)) throw new Error("MCP bearer token is required.");
}

function requestBoundaryError(request: IncomingMessage, boundPort: number | undefined): string | undefined {
  if (boundPort === undefined) return "MCP server is not listening.";
  const host = request.headers.host;
  if (typeof host !== "string" || !isLoopbackAuthority(host, boundPort)) return "Host must identify this loopback MCP server.";
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { return "Origin is invalid."; }
    if (parsed.protocol !== "http:" || parsed.origin !== `http://${host}` || !isLoopbackHostname(parsed.hostname) || effectivePort(parsed) !== boundPort) return "Origin does not match this loopback MCP server.";
  }
}

function hasBearerToken(request: IncomingMessage, token: string): boolean {
  const match = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(request.headers.authorization ?? "");
  if (!match || !token) return false;
  const supplied = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isJsonRequest(request: IncomingMessage): boolean {
  const contentType = request.headers["content-type"];
  return typeof contentType === "string" && /^application\/json(?:\s*;|\s*$)/i.test(contentType);
}

function isLoopbackAuthority(authority: string, port: number): boolean {
  if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(authority)) return false;
  try {
    const parsed = new URL(`http://${authority}`);
    return isLoopbackHostname(parsed.hostname) && effectivePort(parsed) === port && parsed.pathname === "/" && !parsed.username && !parsed.password;
  } catch { return false; }
}

function isLoopbackHostname(hostname: string): boolean { return hostname.toLowerCase() === "127.0.0.1" || hostname.toLowerCase() === "localhost"; }
function effectivePort(url: URL): number { return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80; }
function isSupportedVersion(version: unknown): version is string { return (SUPPORTED_MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(version); }
function negotiatedVersion(params: unknown): string { return isRecord(params) && isSupportedVersion(params.protocolVersion) ? params.protocolVersion : fallbackProtocolVersion; }
function isRequestId(value: unknown): value is string | number { return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)); }
function isRequestMessage(value: unknown): value is JsonRpcRequest { return isRecord(value) && value.jsonrpc === "2.0" && typeof value.method === "string" && isRequestId(value.id); }
/** Notifications and responses to server requests need no reply under Streamable HTTP. */
function needsNoReply(value: unknown): boolean { return isRecord(value) && value.jsonrpc === "2.0" && (typeof value.method === "string" ? value.id === undefined : value.method === undefined && isRequestId(value.id) && ("result" in value || "error" in value)); }

function sameConfig(left: HttpMcpConfig | undefined, right: HttpMcpConfig): boolean {
  return Boolean(left && left.enabled === right.enabled && left.agentEnabled === right.agentEnabled && left.internalEnabled === right.internalEnabled && left.advancedEnabled === right.advancedEnabled && left.port === right.port && left.token === right.token);
}

function isToolPermitted(tool: McpTool, authorization: McpAuthorization): boolean {
  const permission = tool.permission ?? (tool.name === internalTool ? "internal" : tool.name === advancedTool ? "advanced" : undefined);
  if (permission === "internal") return authorization.internalEnabled;
  if (permission === "advanced") return authorization.advancedEnabled;
  return true;
}

function withoutPermission(arguments_: Record<string, unknown>): Record<string, unknown> {
  const { permission: _, ...safe } = arguments_;
  return safe;
}

function rpcResult(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(text: string): { value: unknown } | undefined {
  try { return { value: JSON.parse(text) }; } catch { return undefined; }
}

/** Reads the whole body, counting bytes rather than UTF-16 units; an oversized body is drained and rejected without being buffered. */
function readBody(request: IncomingMessage): Promise<string | BodyError> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size <= maxBodyBytes) chunks.push(chunk);
    });
    request.on("error", (error) => resolve(new BodyError(error.message, 400)));
    request.on("end", () => resolve(size > maxBodyBytes ? new BodyError("Request body is too large.", 413) : Buffer.concat(chunks).toString("utf8")));
  });
}

function send(response: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  response.writeHead(status, { ...headers, ...(payload === undefined ? {} : { "content-type": "application/json" }) });
  response.end(payload);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

/** Stops listening, drops idle keep-alive sockets, and gives requests in flight a short grace period before cutting them off. */
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const cutoff = setTimeout(() => server.closeAllConnections(), closeGraceMs);
    server.close((error) => { clearTimeout(cutoff); if (error) reject(error); else resolve(); });
    server.closeIdleConnections();
  });
}
