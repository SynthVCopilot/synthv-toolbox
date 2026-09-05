import assert from "node:assert/strict";
import fs from "node:fs";

const types = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/types.ts", import.meta.url), "utf8");
const api = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/api.ts", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/styles.css", import.meta.url), "utf8");

assert.match(types, /export interface HttpApiStatus[\s\S]*enabled: boolean;[\s\S]*agentEnabled: boolean;[\s\S]*running: boolean;[\s\S]*port: number;[\s\S]*endpoint: string \| null;[\s\S]*agentEndpoint: string \| null;[\s\S]*lastError: string \| null;/);
assert.match(api, /getHttpApiStatus: \(\) => call<HttpApiStatus>\("get_http_api_status"\)/);
assert.match(api, /configureHttpApi: \(enabled: boolean, agentEnabled: boolean, port: number\) =>[\s\S]*call<HttpApiStatus>\("configure_http_api", \{ enabled, agentEnabled, port \}\)/);
assert.match(main, /id="http-api-enabled"[\s\S]*type="checkbox"/);
assert.match(main, /id="http-agent-enabled"[\s\S]*name="agentEnabled"[\s\S]*允许本地 HTTP 连接 Agent/);
assert.match(main, /id="http-api-port"[\s\S]*type="number"[\s\S]*value="\$\{httpApiStatus\.port \|\| 17831\}"/);
assert.match(main, /getHttpApiStatus\(\)/);
assert.match(main, /configureHttpApi\(enabled, agentEnabled, port\)/);
assert.match(styles, /\.http-api-settings/);
assert.match(styles, /\.fluent-switch\.large/);

console.log("HTTP MCP UI contracts passed.");
