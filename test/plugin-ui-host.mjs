import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(path, "utf8");
const registry = read(join(root, "src", "PiDesktop.Tauri", "src", "vue", "pluginRegistry.ts"));
const frame = read(join(root, "src", "PiDesktop.Tauri", "src", "vue", "components", "PluginPageFrame.vue"));
const main = read(join(root, "src", "PiDesktop.Tauri", "src", "main.ts"));
const viewport = read(join(root, "src", "PiDesktop.Tauri", "src", "vue", "components", "PageViewport.vue"));

assert.match(registry, /export type PluginLoadStatus = "discovered" \| "loading" \| "active" \| "disabled" \| "failed"/);
assert.match(registry, /export interface PluginPageContribution/);
assert.match(registry, /export interface PluginActionContribution/);
assert.match(registry, /record\.status === "active"/);
assert.match(registry, /new CustomEvent<PluginActionInvocation>\("plugin-ui:action"/);
assert.match(registry, /new CustomEvent<PluginFrameRequest>\("plugin-ui:request"/);
assert.match(frame, /sandbox="allow-scripts allow-forms"/);
assert.match(frame, /referrerpolicy="no-referrer"/);
assert.match(frame, /event\.source !== frame\.value\?\.contentWindow/);
assert.doesNotMatch(frame, /@tauri-apps\/api|invoke\(/);
assert.match(main, /pluginRegistry\.pages\(\)/);
assert.match(main, /renderPluginActions\(page\)/);
assert.match(main, /data-plugin-action=/);
assert.match(viewport, /PluginPageFrame/);

console.log("Plugin UI host contracts passed.");
