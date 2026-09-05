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
assert.match(types, /"workbuddy"/);
assert.match(types, /"traecode"/);
assert.match(types, /models:\s*string\[\]/);
assert.match(types, /interface AiApiKeySummary/);
assert.match(types, /apiKeys:\s*AiApiKeySummary\[\]/);
assert.match(api, /selectAiProvider: \(provider: AiProviderId, model: string\)/);
assert.match(api, /addAiApiKey:/);
assert.match(api, /removeAiApiKey: \(provider: AiProviderId, credentialId: string\)/);
assert.match(main, /data-choose-ai-auth-method="oauth"/);
assert.match(main, /data-choose-ai-auth-method="api-key"/);
assert.match(main, /aiProviderPickerStep:|aiProviderPickerStep/);
assert.match(main, /oauthModels/);
assert.match(main, /apiKeyModels/);
assert.match(main, /authMethods\.includes\(authMethod\)/);
assert.match(main, /catalogStatus/);
assert.match(types, /catalogSource:\s*ModelCatalogSource/);
assert.match(main, /refreshAiCatalogLive/);
assert.match(main, /data-refresh-ai-catalog/);
assert.match(main, /可用提供商/);
assert.match(main, /当前不可用/);
assert.doesNotMatch(main, /role="option"/);
assert.match(main, /aiProviderMark\(/);
assert.match(main, /traecode/);
assert.match(main, /data-authorize-ai-provider="traecode"/);
assert.match(main, /完成 TraeCode CLI 登录后/);
assert.match(main, /labelInput\.value = ""/);
assert.match(api, /id: "workbuddy"/);
assert.match(api, /"glm-5\.2"/);
assert.match(api, /trae-account-default/);
assert.match(main, /unavailableReason/);
assert.match(main, /data-ai-credential-id/);
assert.match(main, /data-ai-api-key-form/);
assert.match(main, /data-ai-credential-id/);
assert.match(main, /个 API Key/);
assert.doesNotMatch(types, /apiKeyConfigured/);
assert.doesNotMatch(types, /authMethod:\s*AiAuthMethod/);
assert.match(main, /input\.value = ""/);
assert.match(main, /data-toggle-ai-api-key/);
assert.match(main, /aiProviderPickerAuthMethod/);
assert.match(main, /aiProviderSearchRenderTimer/);
assert.match(main, /window\.setTimeout\(\(\) => \{[\s\S]*aiProviderPickerStep !== "provider-list"[\s\S]*\}, 120\)/);
assert.match(styles, /\.ai-provider-search \{ grid-column: 1 \/ -1/);
assert.match(styles, /\.fluent-dialog\.ai-provider-picker-dialog/);
assert.match(styles, /\.ai-auth-method-card/);
assert.match(styles, /\.ai-api-key-input/);

console.log("dual-auth-ui contracts passed");
