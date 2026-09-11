import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), "utf8");
const main = read("src/PiDesktop.Tauri/src/main.ts");
const api = read("src/PiDesktop.Tauri/src/api.ts");
const types = read("src/PiDesktop.Tauri/src/types.ts");
const i18n = read("src/PiDesktop.Tauri/src/i18nAi.ts");
const settings = main.slice(main.indexOf("function renderSettings"), main.indexOf("async function refreshAutostartStatus"));

assert.match(main, /type Page = .*"ai"/);
assert.match(main, /navItem\("ai", t\("nav\.ai"\)/);
assert.match(main, /case "ai": return renderAiPage\(\)/);
assert.match(main, /<model-connection-panel><\/model-connection-panel>/);
assert.match(main, /data-refresh-ai-usage/);
assert.match(main, /ai-usage-table/);
assert.match(main, /queryUsage: \(\) => refreshAiUsage\(true\)/);
assert.match(main, /panel\.addEventListener\("query-usage"/);
assert.match(main, /usage: aiUsage/);
assert.doesNotMatch(settings, /model-connection-panel|renderAiProviderSettings/);
assert.match(api, /aiProviderUsage: \(\) => call<AiProviderUsageSnapshot>\("ai_provider_usage"\)/);
assert.match(api, /command === "ai_provider_usage"/);
assert.match(types, /interface AiProviderUsageSnapshot/);
assert.match(types, /channel: "oauth" \| "api-key" \| "preview"/);
assert.match(i18n, /addMessages\("zh-CN"/);
assert.match(i18n, /addMessages\("en"/);

console.log("AI page navigation, connection projection, usage table, refresh entry, and bilingual contracts passed.");
