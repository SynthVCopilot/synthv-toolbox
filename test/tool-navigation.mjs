import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(path, "utf8");
const catalog = read(join(root, "src", "PiDesktop.Tauri", "src", "featureCatalog.ts"));
const main = read(join(root, "src", "PiDesktop.Tauri", "src", "main.ts"));
const messages = read(join(root, "src", "PiDesktop.Tauri", "src", "featureMessages.ts"));
const i18n = read(join(root, "src", "PiDesktop.Tauri", "src", "i18n.ts"));

for (const [group, ids] of Object.entries({
  import: ["cover"],
  convert: ["source-separation", "audio-to-project", "audio-preparation"],
  analysis: ["tuning-learning", "audio-insight"],
  quality: ["project-doctor", "pronunciation-doctor", "render-review"],
})) {
  assert.match(catalog, new RegExp(`id: "${group}"[\\s\\S]*?featureIds: \\[${ids.map((id) => `"${id}"`).join(", ")}\\]`));
}

for (const hidden of ["media-import", "score-to-synthv", "project-tools", "ab-audition", "retake-compare", "batch-recipes", "selective-sync"]) {
  assert.doesNotMatch(catalog.match(/const groupDefinitions:[\s\S]*?\n\];/)?.[0] ?? "", new RegExp(`"${hidden}"`));
}

assert.match(catalog, /export const guiFeatureIds = new Set\(groupDefinitions\.flatMap/);
assert.match(catalog, /export const guiFeatureCatalog = featureCatalog\.filter/);
assert.match(main, /const features: Feature\[\] = guiFeatureCatalog;/);
assert.match(main, /toolGroups\.map\(\(group\) => navItem\(group\.id, group\.title, group\.icon\)\)/);
assert.match(main, /case "convert": return renderToolCategory\("convert"\);/);
assert.match(main, /case "analysis": return renderToolCategory\("analysis"\);/);
assert.match(main, /const enteringToolCategory = toolGroups\.some\(\(group\) => group\.id === targetPage\);/);
assert.match(main, /if \(!feature \|\| !group\) return;/);
assert.match(messages, /convert: \{ title: "Convert"/);
assert.match(messages, /analysis: \{ title: "Analyze"/);
assert.match(i18n, /convert: \["转换"/);
assert.match(i18n, /analysis: \["分析"/);
assert.match(i18n, /convert: \["Convert"/);
assert.match(i18n, /analysis: \["Analyze"/);

console.log("Tool navigation contracts passed.");
