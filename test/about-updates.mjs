import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = filename => readFileSync(join(root, filename), "utf8").replace(/\r\n/g, "\n");
const require = createRequire(new URL("../src/PiDesktop.Tauri/package.json", import.meta.url));
const { JSDOM } = require("jsdom");
const main = read("src/PiDesktop.Tauri/src/main.ts");
const source = read("src/PiDesktop.Tauri/src/about.ts");
const messages = read("src/PiDesktop.Tauri/src/i18nAbout.ts");

assert.match(main, /api\.checkToolboxUpdate\(\)/);
assert.doesNotMatch(main, /data-download-toolbox-update/);
assert.doesNotMatch(main, /data-cancel-toolbox-update/);
assert.doesNotMatch(main, /data-install-toolbox-update/);
assert.match(messages, /自动下载、安装并重启应用/);
assert.match(messages, /downloads, installs, and restarts automatically/);

const context = vm.createContext({});
const moduleSource = stripTypeScriptTypes(source.replace(/^import type .*;\n/gm, "").replace("export function renderAboutPage", "function renderAboutPage"), { mode: "transform" });
vm.runInContext(moduleSource, context);
const html = vm.runInContext("renderAboutPage", context)({ app: { appVersion: "0.2.0" }, update: { updateAvailable: true, releaseName: "Version 0.2.1" }, busy: false, translate: key => key, escapeHtml: String, icon: () => "" });
const document = new JSDOM(html).window.document;
assert.ok(document.querySelector("[data-check-toolbox-update]"));
assert.equal(document.querySelectorAll("[data-download-toolbox-update], [data-cancel-toolbox-update], [data-install-toolbox-update]").length, 0);
assert.match(document.body.textContent, /Version 0\.2\.1/);

console.log("About page exposes one automatic update action.");
