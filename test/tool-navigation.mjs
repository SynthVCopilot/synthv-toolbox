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
  import: ["cover", "media-import", "score-to-synthv"],
  convert: ["audio-to-project", "audio-preparation", "source-separation", "project-tools"],
  analysis: ["audio-insight"],
  quality: ["project-doctor", "pronunciation-doctor", "render-review", "batch-recipes"],
})) {
  assert.match(catalog, new RegExp(`id: "${group}"[\\s\\S]*?featureIds: \\[${ids.map((id) => `"${id}"`).join(", ")}\\]`));
}

for (const hidden of ["tuning-learning", "ab-audition", "retake-compare", "selective-sync"]) {
  assert.doesNotMatch(catalog.match(/const groupDefinitions:[\s\S]*?\n\];/)?.[0] ?? "", new RegExp(`"${hidden}"`));
}
assert.doesNotMatch(catalog.match(/const pendingFeatures = new Set\(\[[^\]]*\]\);/)?.[0] ?? "", /"(?:cover|media-import|source-separation)"/);

assert.match(catalog, /export const guiFeatureIds = new Set\(groupDefinitions\.flatMap/);
assert.match(catalog, /export const guiFeatureCatalog = featureCatalog\.filter/);
assert.match(main, /const features: Feature\[\] = guiFeatureCatalog;/);
assert.match(main, /toolGroups\.map\(\(group\) => navItem\(group\.id, group\.title, group\.icon\)\)/);
assert.match(main, /case "convert": return renderToolCategory\("convert"\);/);
assert.match(main, /case "analysis": return renderToolCategory\("analysis"\);/);
assert.match(main, /if \(feature\.id === "cover" && current\.mode !== "ai"\) return false;/);
assert.match(main, /return feature && app && featureVisible\(feature, app\) \? \[feature\] : \[\];/);
assert.match(main, /feature\.homePriority !== undefined && featureVisible\(feature, current\)/, "home quick-start must apply the same visibility rule as tool tabs");

// SynthV-only tools carry the integration tag; every group must keep a generic tool so turning SynthV off never empties it.
// Batch stays visible: its audio recipe (render review) needs no SynthV, and its project recipes are filtered out instead.
// Each backend recipe needs a label in both locales; the batch form looks them up by recipe id.
{
  const creative = readFileSync(new URL("../src/PiDesktop.Tauri/electron/services/creative-service.ts", import.meta.url), "utf8");
  const workflows = readFileSync(new URL("../src/PiDesktop.Tauri/src/i18nWorkflows.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const ids = [...creative.slice(creative.indexOf("const recipes = ["), creative.indexOf("].map(([id, title, inputKind])")).matchAll(/\["([a-z-]+)", "/g)].map((match) => match[1]);
  assert.ok(ids.includes("render-review") && ids.length >= 5, `recipe ids not found: ${ids}`);
  for (const id of ids) assert.equal(workflows.split(`    "${id}": {\n      "title"`).length - 1, 2, `recipe ${id} needs a title in both locales`);
}
const synthvOnly = new Set(["cover", "score-to-synthv", "project-tools", "project-doctor", "tuning-learning", "ab-audition", "retake-compare", "selective-sync"]);
for (const line of catalog.split(/\r?\n/).filter((value) => /^  \{ id: "/.test(value))) {
  const id = line.match(/id: "([^"]+)"/)[1];
  assert.equal(/integration: "synthv"/.test(line), synthvOnly.has(id), `${id} integration tag`);
}
for (const match of catalog.matchAll(/featureIds: \[([^\]]*)\]/g)) {
  const ids = [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
  assert.ok(ids.some((id) => !synthvOnly.has(id)), `group ${ids.join(",")} would be empty with SynthV off`);
}
assert.match(main, /const enteringToolCategory = toolGroups\.some\(\(group\) => group\.id === targetPage\);/);
assert.match(main, /if \(!feature \|\| !group\) return;/);
assert.match(messages, /convert: \{ title: "Convert"/);
assert.match(messages, /analysis: \{ title: "Analyze"/);
assert.match(i18n, /convert: \["转换"/);
assert.match(i18n, /analysis: \["分析"/);
assert.match(i18n, /convert: \["Convert"/);
assert.match(i18n, /analysis: \["Analyze"/);

console.log("Tool navigation contracts passed.");
