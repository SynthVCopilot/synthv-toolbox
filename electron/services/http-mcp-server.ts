import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const protocolVersion = "2025-06-18";
const internalTool = "toolbox_internal";
const advancedTool = "toolbox_advanced";

export interface McpAuthorization {
  internalEnabled: boolean;
  advancedEnabled: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  permission?: "internal" | "advanced";
}

export interface RuntimeMcpHost {
  mcpTools(authorization: McpAuthorization): Promise<McpTool[]>;
  callMcpTool(name: string, arguments_: Record<string, unknown>, authorization: McpAuthorization): Promise<{ content: unknown; isError?: boolean }>;
  agentChat?(input: string, conversationId?: string): Promise<unknown>;
}

export interface HttpMcpConfig extends McpAuthorization {
  enabled: boolean;
  agentEnabled: boolean;
  port: number;
}

export interface HttpMcpStatus extends HttpMcpConfig {
  running: boolean;
  endpoint?: string;
  agentEndpoint?: string;
  lastError?: string;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** Loopback-only MCP transport; authorization is evaluated for every tool list and call. */
export class HttpMcpServer {
  private server?: Server;
  private config?: HttpMcpConfig;
  private boundPort?: number;
  private lastError?: string;

  constructor(private readonly host: RuntimeMcpHost) {}

  async start(config: HttpMcpConfig): Promise<HttpMcpStatus> {
    validateConfig(config);
    if (!config.enabled && !config.agentEnabled) {
      await this.stop();
      this.config = config;
      return this.status();
    }
    if (this.server && sameConfig(this.config, config)) return this.status();
    await this.stop();
    this.config = { ...config };
    try {
      const server = createServer((request, response) => void this.handleRequest(request, response));
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
      ...(config.enabled && running ? { endpoint: `http://127.0.0.1:${port}/mcp` } : {}),
      ...(config.agentEnabled && running ? { agentEndpoint: `http://127.0.0.1:${port}/agent` } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const config = this.config;
    if (!config) return send(response, 503, { error: "MCP server is not configured." });
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/mcp") {
      if (request.method !== "POST") return send(response, 405, { error: "Method not allowed." }, { Allow: "POST" });
      if (!config.enabled) return send(response, 404, { error: "MCP is disabled." });
      const body = await readJson(request);
      if (body instanceof Error) return send(response, 400, { error: body.message });
      const result = await this.handleRpc(body);
      if (result === undefined) return send(response, 202, undefined);
      return send(response, 200, result);
    }
    if (path === "/agent") {
      if (request.method !== "POST") return send(response, 405, { error: "Method not allowed." }, { Allow: "POST" });
      if (!config.agentEnabled || !this.host.agentChat) return send(response, 404, { error: "Agent endpoint is disabled." });
      const body = await readJson(request);
      if (body instanceof Error || !isRecord(body) || typeof body.input !== "string") return send(response, 400, { error: "Agent input is required." });
      try {
        return send(response, 200, { messages: await this.host.agentChat(body.input, typeof body.conversationId === "string" ? body.conversationId : undefined) });
      } catch (error) {
        return send(response, 400, { error: errorMessage(error) });
      }
    }
    return send(response, 404, { error: "Not found." });
  }

  private async handleRpc(request: unknown): Promise<Record<string, unknown> | undefined> {
    if (!isRecord(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return rpcError(null, -32600, "Invalid JSON-RPC request.");
    }
    if (request.id === undefined) return undefined;
    const id = request.id;
    try {
      switch (request.method) {
        case "initialize":
          return rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "synthv-toolbox" } });
        case "ping":
          return rpcResult(id, {});
        case "tools/list":
          return rpcResult(id, { tools: await this.listTools() });
        case "tools/call":
          return rpcResult(id, await this.callTool(request.params));
        default:
          return rpcError(id, -32601, "Method not found.");
      }
    } catch (error) {
      return rpcError(id, -32603, errorMessage(error));
    }
  }

  private authorization(): McpAuthorization {
    const config = this.config ?? disabledConfig();
    return { internalEnabled: config.internalEnabled, advancedEnabled: config.advancedEnabled };
  }

  private async listTools(): Promise<McpTool[]> {
    const authorization = this.authorization();
    const tools = await this.host.mcpTools(authorization);
    return tools.filter((tool) => isToolPermitted(tool, authorization));
  }

  private async callTool(params: unknown): Promise<Record<string, unknown>> {
    if (!isRecord(params) || typeof params.name !== "string") throw new Error("tools/call requires a tool name.");
    const authorization = this.authorization();
    const tools = await this.host.mcpTools(authorization);
    const tool = tools.find((candidate) => candidate.name === params.name);
    if (!tool || !isToolPermitted(tool, authorization)) throw new Error("Tool is disabled or unavailable.");
    const arguments_ = isRecord(params.arguments) ? withoutPermission(params.arguments) : {};
    const result = await this.host.callMcpTool(tool.name, arguments_, authorization);
    return { content: normalizeContent(result.content), isError: result.isError === true };
  }
}

function disabledConfig(): HttpMcpConfig {
  return { enabled: false, agentEnabled: false, internalEnabled: false, advancedEnabled: false, port: 0 };
}

function validateConfig(config: HttpMcpConfig): void {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) throw new Error("MCP port must be between 0 and 65535.");
}

function sameConfig(left: HttpMcpConfig | undefined, right: HttpMcpConfig): boolean {
  return Boolean(left && left.enabled === right.enabled && left.agentEnabled === right.agentEnabled && left.internalEnabled === right.internalEnabled && left.advancedEnabled === right.advancedEnabled && left.port === right.port);
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

function normalizeContent(content: unknown): Array<{ type: "text"; text: string }> {
  if (Array.isArray(content)) return content as Array<{ type: "text"; text: string }>;
  return [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content) }];
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

function readJson(request: IncomingMessage): Promise<unknown | Error> {
  return new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 1_048_576) request.destroy(new Error("Request body is too large."));
    });
    request.on("error", (error) => resolve(error));
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(new Error("Request body must be valid JSON."));
      }
    });
  });
}

function send(response: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) });
  response.end(body === undefined ? undefined : JSON.stringify(body));
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

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
