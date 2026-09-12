import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(path, "utf8");
const registry = read(join(root, "src", "PiDesktop.Tauri", "src", "vue", "pluginRegistry.ts"));
const protocol = read(join(root, "packages", "runtime-protocol", "src", "index.ts"));
const frame = read(join(root, "src", "PiDesktop.Tauri", "src", "vue", "components", "PluginPageFrame.vue"));
const main = read(join(root, "src", "PiDesktop.Tauri", "src", "main.ts"));
const viewport = read(join(root, "src", "PiDesktop.Tauri", "src", "vue", "components", "PageViewport.vue"));

assert.match(registry, /export type PluginLoadStatus = "discovered" \| "loading" \| "active" \| "disabled" \| "failed"/);
assert.match(registry, /PluginManifest[\s\S]+@synthv-toolbox\/runtime-protocol/);
assert.match(protocol, /export interface PluginPageContribution/);
assert.match(protocol, /export interface PluginActionContribution/);
assert.match(protocol, /entry: string/);
assert.match(protocol, /location: PluginActionLocation/);
assert.match(registry, /return `toolbox-plugin:\/\/localhost\/\$\{pluginId\}\/\$\{entry\}`/);
assert.match(registry, /case "project\.toolbar":/);
assert.match(registry, /record\.status === "active"/);
assert.match(registry, /new CustomEvent<PluginActionInvocation>\("plugin-ui:action"/);
assert.match(registry, /new CustomEvent<PluginFrameRequest>\("plugin-ui:request"/);
assert.match(frame, /sandbox="allow-scripts allow-forms"/);
assert.match(frame, /referrerpolicy="no-referrer"/);
assert.match(frame, /event\.source !== frame\.value\?\.contentWindow/);
assert.match(frame, /plugin-ui:response/);
assert.match(frame, /plugin-ui:event/);
assert.doesNotMatch(frame, /@tauri-apps\/api|invoke\(/);
assert.match(main, /pluginRegistry\.pages\(\)/);
assert.match(main, /renderPluginActions\(page\)/);
assert.match(main, /data-plugin-action=/);
assert.match(viewport, /PluginPageFrame/);

console.log("Plugin UI host contracts passed.");
