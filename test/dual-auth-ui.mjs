import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const [types, api, main] = await Promise.all([
  readFile(new URL("src/PiDesktop.Tauri/src/types.ts", root), "utf8"),
  readFile(new URL("src/PiDesktop.Tauri/src/api.ts", root), "utf8"),
  readFile(new URL("src/PiDesktop.Tauri/src/main.ts", root), "utf8"),
]);
assert.match(types, /AiLoadStrategy/);
assert.match(types, /oauthEnabled: boolean/);
assert.match(api, /cancelAiAuthorization/);
assert.match(main, /authorize-oauth/);
assert.match(main, /reconnect-oauth/);
assert.match(main, /activeModelAuthAuthorization/);
assert.doesNotMatch(main, /data-ai-api-key-form/);
assert.doesNotMatch(main, /aiProviderPickerStep/);
console.log("dual-auth-ui contracts passed");
