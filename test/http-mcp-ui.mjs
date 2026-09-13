import assert from "node:assert/strict";
import fs from "node:fs";

const types = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/types.ts", import.meta.url), "utf8");
const api = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/api.ts", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/styles.css", import.meta.url), "utf8");
const i18n = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/i18n.ts", import.meta.url), "utf8");

assert.match(types, /export interface HttpApiStatus[\s\S]*enabled: boolean;[\s\S]*agentEnabled: boolean;[\s\S]*internalFunctionsEnabled: boolean;[\s\S]*advancedFunctionsEnabled: boolean;[\s\S]*running: boolean;[\s\S]*port: number;[\s\S]*endpoint: string \| null;[\s\S]*agentEndpoint: string \| null;[\s\S]*lastError: string \| null;/);
assert.match(api, /getHttpApiStatus: \(\) => call<HttpApiStatus>\("get_http_api_status"\)/);
assert.match(api, /configureHttpApi: \(enabled: boolean, agentEnabled: boolean, internalFunctionsEnabled: boolean, advancedFunctionsEnabled: boolean, port: number\) =>[\s\S]*call<HttpApiStatus>\("configure_http_api", \{ enabled, agentEnabled, internalFunctionsEnabled, advancedFunctionsEnabled, port \}\)/);
assert.match(main, /id="http-api-enabled"[\s\S]*type="checkbox"/);
assert.match(main, /id="http-agent-enabled"[\s\S]*name="agentEnabled"[\s\S]*connections\.agentChat/);
assert.match(main, /id="http-internal-functions-enabled"[\s\S]*name="internalFunctionsEnabled"[\s\S]*connections\.internalFunctionsDescription/);
assert.match(main, /id="http-advanced-functions-enabled"[\s\S]*name="advancedFunctionsEnabled"[\s\S]*connections\.advancedFunctionsDescription/);
assert.match(main, /id="http-api-port"[\s\S]*type="number"[\s\S]*value="\$\{httpApiStatus\.port \|\| 17831\}"/);
assert.match(main, /getHttpApiStatus\(\)/);
assert.match(main, /configureHttpApi\(enabled, agentEnabled, internalFunctionsEnabled, advancedFunctionsEnabled, port\)/);
assert.match(main, /pages\.\$\{target\}\.0/);
assert.match(main, /navItem\("connections", t\("nav\.connections"\), "server"\)/);
assert.match(main, /case "connections": return renderMcp\(\)/);
assert.match(main, /connections\.aiOnly[\s\S]*connections\.aiOnlyDescription/);
assert.match(main, /connections\.localService[\s\S]*id="http-api-form"/);
assert.match(main, /http-api-access-group[\s\S]*connections\.endpointAccess[\s\S]*http-api-endpoint-grid/);
assert.match(main, /http-api-access-group[\s\S]*connections\.privilegedAccess[\s\S]*http-api-privilege-grid/);
assert.doesNotMatch(main.slice(main.indexOf("function renderSettings"), main.indexOf("function wireForms")), /id="http-api-form"/);
assert.match(styles, /\.http-api-settings/);
assert.match(styles, /\.connections-layout/);
assert.match(styles, /\.fluent-switch\.large/);
assert.match(styles, /\.http-api-endpoint-grid, \.http-api-privilege-grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0,1fr\)\);/);
assert.match(styles, /@media \(max-width: 720px\) \{ \.http-api-endpoint-grid, \.http-api-privilege-grid \{ grid-template-columns: 1fr;/);
assert.match(styles, /\.http-api-privilege\.danger/);
assert.match(i18n, /chineseConnections\.internalFunctionsDescription[\s\S]*尚未完整包装为公开 API/);
assert.match(i18n, /chineseConnections\.advancedFunctionsDescription[\s\S]*不限制网络请求[\s\S]*插件数据目录外/);
assert.match(i18n, /englishConnections\.advancedFunctionsDescription[\s\S]*unrestricted network requests[\s\S]*outside plugin data directories/);
assert.match(i18n, /privilegesRequireMcp/);

console.log("HTTP MCP UI contracts passed.");
