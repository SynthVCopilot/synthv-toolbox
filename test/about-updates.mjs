import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (filename) => readFileSync(join(root, filename), "utf8").replace(/\r\n/g, "\n");
const require = createRequire(new URL("../src/PiDesktop.Tauri/package.json", import.meta.url));
const { JSDOM } = require("jsdom");
const main = read("src/PiDesktop.Tauri/src/main.ts");
const source = read("src/PiDesktop.Tauri/src/about.ts");
const styles = read("src/PiDesktop.Tauri/src/styles.css");
const messages = read("src/PiDesktop.Tauri/src/i18nAbout.ts");
const shell = read("src/PiDesktop.Tauri/src/vue/shell.ts");
const pluginRegistry = read("src/PiDesktop.Tauri/src/vue/pluginRegistry.ts");
const viewport = read("src/PiDesktop.Tauri/src/vue/components/PageViewport.vue");

assert.match(main, /type Page = HostPageId \| PluginPageId/);
assert.match(pluginRegistry, /export type HostPageId = .*"about"/);
assert.match(main, /navItem\("about", t\("nav\.about"\), "info"\)/);
assert.match(main, /case "about": return renderAboutPage/);
assert.match(shell, /\| "about"/);
assert.match(viewport, /"about",/);
assert.doesNotMatch(main, /app-update-settings/);
assert.match(main, /api\.getToolboxUpdateDownload\(\)/);
assert.match(main, /api\.downloadToolboxUpdate\(\)/);
assert.match(main, /api\.cancelToolboxUpdateDownload\(\)/);
assert.match(main, /api\.installToolboxUpdate\(\)/);
assert.match(main, /api\.openToolboxReleases\(toolboxUpdate\?\.releaseUrl\)/);
assert.match(main, /return page === "about" \|\| toolboxUpdateDownload\?\.status === "downloading"/);
assert.match(styles, /\.fluent-select .*border-radius: 4px/);
assert.match(styles, /\.about-download-progress/);
assert.match(styles, /\.about-layout \{ display: grid; grid-template-columns: minmax\(240px,\.72fr\) minmax\(420px,1\.28fr\)/);
assert.match(messages, /addMessages\("zh-CN", \{ about:/);
assert.match(messages, /addMessages\("en", \{ about:/);
assert.doesNotMatch(messages, /officialRelease/);

const context = vm.createContext({});
const moduleSource = stripTypeScriptTypes(
  source.replace(/^import type .*;\n/gm, "").replace("export function renderAboutPage", "function renderAboutPage"),
  { mode: "transform" },
);
vm.runInContext(moduleSource, context);
const render = (download, installer = { name: "Toolbox.exe", url: "https://example.test/toolbox.exe", sha256: "a".repeat(64), size: 1024 }, updateOverrides = {}) => {
  const html = vm.runInContext("renderAboutPage", context)({
    app: { platform: "windows", appVersion: "0.1.7", updateChannel: "stable" },
    update: { channel: "stable", currentVersion: "0.1.7", latestVersion: "0.1.8", updateAvailable: true, releaseName: "Toolbox 0.1.8", releaseUrl: "https://example.test/release", releaseNotes: "Release notes", checkedAtUtc: "2026-09-06T20:00:00Z", installer, ...updateOverrides },
    download,
    busy: false,
    locale: "en",
    translate: (key) => key,
    escapeHtml: String,
    icon: () => "<svg></svg>",
  });
  return new JSDOM(html).window.document;
};

const ready = render({ status: "ready", downloadedBytes: 1024, totalBytes: 1024, fileName: "Toolbox.exe" });
assert.equal(ready.querySelector("#update-channel").disabled, true);
assert.ok(ready.querySelector("[data-install-toolbox-update]"));
assert.ok(ready.querySelector("[data-cancel-toolbox-update]"), "ready download can be discarded");

const cancelled = render({ status: "cancelled", downloadedBytes: 0 });
assert.equal(cancelled.querySelector("#update-channel").disabled, false);
assert.equal(cancelled.querySelector("[data-cancel-toolbox-update]"), null);
assert.ok(cancelled.querySelector("[data-download-toolbox-update]"));

const downloading = render({ status: "downloading", downloadedBytes: 256, totalBytes: 1024, fileName: "Toolbox.exe" });
assert.equal(downloading.querySelector("#update-channel").disabled, true);
assert.ok(downloading.querySelector("[data-cancel-toolbox-update]"));
assert.equal(downloading.querySelector("[role=progressbar]").getAttribute("aria-valuenow"), "25");

const unsupported = render({ status: "idle", downloadedBytes: 0 }, null);
assert.equal(unsupported.querySelector("[data-download-toolbox-update]"), null);
assert.match(unsupported.body.textContent, /about\.noInstaller/);
assert.ok(unsupported.querySelector("[data-open-toolbox-releases]"), "official release remains available without an installer");
assert.doesNotMatch(unsupported.body.textContent, /officialRelease/);

const newer = render({ status: "idle", downloadedBytes: 0 }, null, { currentVersion: "0.2.0", latestVersion: "0.1.9", updateAvailable: false });
assert.equal(newer.querySelector("[data-open-toolbox-releases]"), null, "a lower release is not recommended");
assert.equal(newer.querySelector(".about-notes"), null, "a lower release does not show downgrade notes");

console.log("About page rendering covers ready discard, cancelled unlock, download progress, and unsupported installers.");
