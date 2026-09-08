import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const [packageJson, api, main, types, commands, lib] = await Promise.all([
  readFile(new URL("src/PiDesktop.Tauri/package.json", root), "utf8"),
  readFile(new URL("src/PiDesktop.Tauri/src/api.ts", root), "utf8"),
  readFile(new URL("src/PiDesktop.Tauri/src/main.ts", root), "utf8"),
  readFile(new URL("src/PiDesktop.Tauri/src/types.ts", root), "utf8"),
  readFile(new URL("src/PiDesktop.Tauri/src-tauri/src/commands.rs", root), "utf8"),
  readFile(new URL("src/PiDesktop.Tauri/src-tauri/src/lib.rs", root), "utf8"),
]);

assert.match(packageJson, /https:\/\/github\.com\/lsy-404\/platform-kit\/releases\/download\/v0\.3\.1\/model-auth-vue-0\.4\.1\.tgz/);
assert.doesNotMatch(packageJson, /\.platform-kit-private/);
assert.match(api, /浏览器预览不执行 OAuth 授权/);
assert.doesNotMatch(api, /previewAiAccountSequence|preview-anthropic-1/);
assert.match(main, /registerModelAuthElement\(\)/);
assert.match(main, /registerModelConnectionPanelElement\(\)/);
assert.match(main, /mountModelAuthDialog/);
assert.match(main, /model-connection-panel/);
assert.match(main, /initialConnection: modelAuthInitialConnection/);
assert.match(main, /panel\.addEventListener\("manage"/);
assert.match(main, /panel\.addEventListener\("refresh"/);
assert.match(main, /oauthCredentials/);
assert.match(main, /apiKeyCredentials/);
assert.match(main, /update-provider-strategy/);
assert.match(types, /AiLoadStrategy/);
assert.match(types, /oauthEnabled: boolean/);
assert.match(types, /enabled: boolean/);
assert.match(api, /updateAiCredential/);
assert.match(commands, /pub async fn update_ai_credential/);
assert.match(commands, /pub async fn update_ai_provider_strategy/);
assert.match(lib, /commands::update_ai_credential/);

console.log("shared model-auth integration contracts passed");
