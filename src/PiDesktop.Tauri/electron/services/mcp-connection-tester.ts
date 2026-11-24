import { spawn } from "node:child_process";

type McpServer = Record<string, unknown>;
export interface McpConnectionResult { succeeded: boolean; summary: string; detail: string; }

export async function testMcpConnection(server: McpServer, timeoutMs = 5_000): Promise<McpConnectionResult> {
  if (server.enabled === false) return { succeeded: false, summary: "MCP server is disabled.", detail: "Enable the saved server before testing it." };
  try {
    if (typeof server.url === "string" && server.url.trim()) await testHttp(server.url, timeoutMs);
    else await testStdio(requiredText(server.command, "server.command"), stringArray(server.args), timeoutMs);
    return { succeeded: true, summary: "MCP initialize and ping succeeded.", detail: requiredText(server.id, "server.id") };
  } catch (error) {
    return { succeeded: false, summary: "MCP connection failed.", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function testHttp(url: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: "toolbox-test", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "SynthV Toolbox", version: "0" } } }), signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP MCP server returned ${response.status}.`);
    const body = await response.text();
    if (!body.includes("toolbox-test") && !body.includes("protocolVersion")) throw new Error("HTTP MCP server did not return an initialize response.");
  } finally { clearTimeout(timer); }
}

async function testStdio(command: string, args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    let output = ""; let stderr = ""; let stage: "initialize" | "ping" = "initialize";
    const timer = setTimeout(() => finish(new Error(`MCP stdio server timed out during ${stage}.`)), timeoutMs);
    const finish = (error?: Error) => { clearTimeout(timer); child.kill(); error ? reject(error) : resolvePromise(); };
    child.once("error", error => finish(new Error(`Unable to start MCP server: ${error.message}`)));
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.stdout.on("data", chunk => {
      output += String(chunk);
      const lines = output.split(/\r?\n/); output = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const response = JSON.parse(line) as { id?: string; result?: unknown; error?: { message?: string } };
          if (response.id !== "toolbox-test") continue;
          if (response.error) return finish(new Error(response.error.message ?? `MCP ${stage} failed.`));
          if (!response.result) return finish(new Error(`MCP ${stage} returned no result.`));
          if (stage === "initialize") { stage = "ping"; child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "toolbox-test", method: "ping" })}\n`); } else return finish();
        } catch { /* Ignore non-JSON diagnostic lines. */ }
      }
    });
    child.once("exit", code => { if (code !== 0) finish(new Error(`MCP server exited (${code}): ${stderr.trim() || "no diagnostic"}`)); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "toolbox-test", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "SynthV Toolbox", version: "0" } } })}\n`);
  });
}
function requiredText(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`); return value; }
function stringArray(value: unknown): string[] { return Array.isArray(value) && value.every(item => typeof item === "string") ? value : []; }
