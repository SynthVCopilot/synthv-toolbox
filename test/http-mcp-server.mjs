import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const rust = readFileSync(join(root, "src/PiDesktop.Tauri/src-tauri/src/http_api.rs"), "utf8");
const config = readFileSync(join(root, "src/PiDesktop.Tauri/src-tauri/src/config.rs"), "utf8");
const commands = readFileSync(join(root, "src/PiDesktop.Tauri/src-tauri/src/commands.rs"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "src/PiDesktop.Tauri/package.json"), "utf8"));

assert.match(rust, /TcpListener::bind\(\("127\.0\.0\.1", context\.port\)\)/);
assert.match(rust, /route\("\/health", get\(health\)\)/);
assert.match(rust, /route\(ENDPOINT_PATH, get\(get_mcp\)\.post\(post_mcp\)\)/);
assert.match(rust, /route\(AGENT_ENDPOINT_PATH, post\(post_agent\)\)/);
assert.match(rust, /PROTOCOL_VERSION: &str = "2025-06-18"/);
assert.match(rust, /"initialize"/);
assert.match(rust, /"tools\/list"/);
assert.match(rust, /"tools\/call"/);
assert.match(rust, /text\/event-stream/);
assert.match(rust, /METHOD_NOT_ALLOWED/);
assert.match(rust, /ToolboxAudioToolExecutor::new/);
assert.match(rust, /notifications\/initialized/);
assert.match(config, /DEFAULT_HTTP_API_PORT: u16 = 17_831/);
assert.match(config, /http_api_enabled/);
assert.match(config, /http_agent_enabled/);
assert.match(config, /http_api_port/);
assert.match(commands, /pub async fn get_http_api_status/);
assert.match(commands, /pub async fn configure_http_api\([\s\S]*enabled: bool,[\s\S]*agent_enabled: bool,[\s\S]*port: u16/);
assert.match(commands, /validate_port\(port\)/);
assert.match(commands, /pub\(crate\) async fn run_agent_message/);
assert.match(packageJson.scripts["test:contracts"], /http-mcp-server\.mjs/);

console.log("HTTP MCP server contract checks passed");
