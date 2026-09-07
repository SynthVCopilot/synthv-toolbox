import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (filename) => readFileSync(join(root, filename), "utf8").replace(/\r\n/g, "\n");
const main = read("src/PiDesktop.Tauri/src/main.ts");
const about = read("src/PiDesktop.Tauri/src/about.ts");
const styles = read("src/PiDesktop.Tauri/src/styles.css");
const messages = read("src/PiDesktop.Tauri/src/i18nAbout.ts");
const shell = read("src/PiDesktop.Tauri/src/vue/shell.ts");
const viewport = read("src/PiDesktop.Tauri/src/vue/components/PageViewport.vue");

assert.match(main, /type Page = .*"about"/);
assert.match(main, /navItem\("about", t\("nav\.about"\), "info"\)/);
assert.match(main, /case "about": return renderAboutPage/);
assert.match(shell, /\| "about"/);
assert.match(viewport, /"about",/);
assert.doesNotMatch(main, /app-update-settings/);
assert.match(main, /api\.getToolboxUpdateDownload\(\)/);
assert.match(main, /api\.downloadToolboxUpdate\(\)/);
assert.match(main, /api\.cancelToolboxUpdateDownload\(\)/);
assert.match(main, /api\.installToolboxUpdate\(\)/);
assert.match(main, /return page === "about" \|\| toolboxUpdateDownload\?\.status === "downloading"/);
assert.match(about, /data-open-toolbox-project="project"/);
assert.match(about, /data-open-toolbox-project="guide"/);
assert.match(about, /data-open-toolbox-project="issues"/);
assert.match(about, /Apache-2\.0/);
assert.match(about, /about\.macInstallGuide/);
assert.match(about, /options\.busy \|\| updateAssetActive/);
assert.match(about, /options\.update\?\.installer/);
assert.match(styles, /\.fluent-select .*border-radius: 4px/);
assert.match(styles, /\.about-download-progress/);
assert.match(messages, /addMessages\("zh-CN", \{ about:/);
assert.match(messages, /addMessages\("en", \{ about:/);

console.log("About page and internal update UI contracts passed.");
