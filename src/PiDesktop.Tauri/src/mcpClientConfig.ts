import { BRAND } from "./brand";

export type McpClientId = "claude-code" | "codex" | "cursor" | "vscode";

export interface McpClientSnippet {
  id: McpClientId;
  label: string;
  /** Where the snippet goes: a terminal, or the client's config file. */
  target: string;
  language: "shell" | "toml" | "json";
  text: string;
}

/**
 * Ready-to-paste configurations for MCP clients that speak Streamable HTTP. The server key is the stable BRAND.slug,
 * so the configs users paste today keep working when the product name changes again.
 */
export function mcpClientSnippets(endpoint: string, token: string): McpClientSnippet[] {
  const name = BRAND.slug;
  const authorization = `Bearer ${token}`;
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  return [
    { id: "claude-code", label: "Claude Code", target: "terminal", language: "shell", text: `claude mcp add --transport http ${name} ${endpoint} --header "Authorization: ${authorization}"` },
    { id: "codex", label: "Codex", target: "~/.codex/config.toml", language: "toml", text: `[mcp_servers.${name}]\nurl = "${endpoint}"\nhttp_headers = { "Authorization" = "${authorization}" }\n# To keep the token out of this file, use instead:\n# bearer_token_env_var = "${name.toUpperCase()}_MCP_TOKEN"` },
    { id: "cursor", label: "Cursor", target: "~/.cursor/mcp.json", language: "json", text: json({ mcpServers: { [name]: { url: endpoint, headers: { Authorization: authorization } } } }) },
    { id: "vscode", label: "VS Code", target: ".vscode/mcp.json", language: "json", text: json({ servers: { [name]: { type: "http", url: endpoint, headers: { Authorization: authorization } } } }) },
  ];
}

/** Shows enough of the token to tell two apart without exposing it on screen. */
export function maskToken(token: string): string {
  return token.length <= 8 ? "••••••••" : `${token.slice(0, 4)}••••••••${token.slice(-4)}`;
}
