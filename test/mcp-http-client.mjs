import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  new URL("../src/PiDesktop.Tauri/src-tauri/src/mcp/http_client.rs", import.meta.url),
  "utf8",
);

assert.match(source, /http:\/\/127\.0\.0\.1:\{port\}\/mcp/);
assert.match(source, /MCP-Protocol-Version/);
assert.match(source, /PROTOCOL_VERSION: &str = "2025-06-18"/);
assert.match(source, /result\.get\("protocolVersion"\)/);
assert.match(source, /\.redirects\(0\)/);
assert.match(source, /8 \* 1_048_576/);
assert.match(source, /text\/event-stream/);
assert.match(source, /仅支持包含单个 data 事件/);
assert.match(source, /Content-Length/);
assert.match(source, /transfer-encoding/);
assert.match(source, /ureq::Error::Status/);

console.log("Flat HTTP MCP client contracts passed.");
