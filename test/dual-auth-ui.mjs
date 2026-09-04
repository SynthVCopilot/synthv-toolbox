import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const [types, api, main, styles] = await Promise.all([
  readFile(new URL("src/PiDesktop.Tauri/src/types.ts", root), "utf8"),
  readFile(new URL("src/PiDesktop.Tauri/src/api.ts", root), "utf8"),
  readFile(new URL("src/PiDesktop.Tauri/src/main.ts", root), "utf8"),
  readFile(new URL("src/PiDesktop.Tauri/src/styles.css", root), "utf8"),
]);

assert.match(types, /AiAuthMethod\s*=\s*"oauth"\s*\|\s*"api-key"/);
assert.match(types, /authMethod:\s*AiAuthMethod/);
assert.match(types, /apiKeyConfigured:\s*boolean/);
assert.match(api, /selectAiProvider: \(provider: AiProviderId, model: string, authMethod: AiAuthMethod\)/);
assert.match(api, /configureAiApiKey:/);
assert.match(api, /removeAiApiKey:/);
assert.match(main, /data-select-ai-auth-method="oauth"/);
assert.match(main, /data-select-ai-auth-method="api-key"/);
assert.match(main, /data-ai-api-key-form/);
assert.match(main, /input\.value = ""/);
assert.match(main, /data-toggle-ai-api-key/);
assert.match(main, /authMethod === "api-key"/);
assert.match(styles, /\.ai-provider-search \{ grid-column: 1 \/ -1/);
assert.match(styles, /\.ai-auth-method-tabs/);
assert.match(styles, /\.ai-api-key-input/);

console.log("dual-auth-ui contracts passed");
