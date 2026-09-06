import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire, stripTypeScriptTypes } from "node:module";

const require = createRequire(new URL("../src/PiDesktop.Tauri/package.json", import.meta.url));
const { JSDOM } = require("jsdom");
const { createI18n } = require("vue-i18n");
const source = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");
const start = source.indexOf("function renderAuthorizedVoice(");
const end = source.indexOf("function renderAccountManager(", start);
const document = new JSDOM("<main></main>").window.document;
const context = vm.createContext({
  document, Date, JSON, Number, Math, createI18n,
  localStorage: { getItem: () => "zh-CN", setItem() {} },
  profiles: { slots: [{ id: "fixture-slot", installedVoiceIds: ["fixture-product"] }, { id: "other-slot", installedVoiceIds: [] }] },
  sv2VoiceCatalog: undefined, sv2VoiceCatalogLoading: false,
  api: { sv2VoiceCatalog: async () => [{ imageDataUrl: "data:image/png;base64,fixture", vendor: "Fixture" }] },
  findVoiceMetadata: (_voice, _ids, catalog) => catalog[0],
  icon: () => "",
  escapeHtml: value => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
});
for (const name of ["i18n", "i18nAccounts"]) {
  const text = fs.readFileSync(new URL(`../src/PiDesktop.Tauri/src/${name}.ts`, import.meta.url), "utf8");
  vm.runInContext(stripTypeScriptTypes(text.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "")), context);
}
vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
const trial = { id: "fixture-product", name: "Fixture Voice", isTrial: true, expiresAtUtc: "2099-12-31T23:59:59Z" };
document.body.innerHTML = context.renderAuthorizedVoice(trial.name, [trial], "fixture-slot");
assert.equal(document.querySelector(".voice-trial-badge").textContent, "限时试用");
assert.match(document.querySelector(".voice-license-expiry").textContent, /2099/);
assert.equal(document.querySelector(".voice-installed-badge").getAttribute("aria-label"), "已安装", "installed product is indicated even before artwork loads");
context.loadSv2VoiceCatalog();
await new Promise(resolve => setImmediate(resolve));
assert.ok(document.querySelector(".voice-cover[src]"), "artwork loads asynchronously");
assert.equal(document.querySelector(".voice-trial-badge").textContent, "限时试用", "artwork replacement retains the trial label");
assert.match(document.querySelector(".voice-license-expiry").textContent, /2099/, "artwork replacement retains the expiry");
assert.ok(document.querySelector(".voice-installed-badge"), "artwork replacement retains the installed indicator");
context.profiles.slots[0].installedVoiceIds = [];
context.refreshAuthorizedVoiceEntries();
assert.equal(document.querySelector(".voice-installed-badge"), null, "uninstall removes the indicator when slot state refreshes");
context.profiles.slots[0].installedVoiceIds = [trial.id.toUpperCase()];
context.refreshAuthorizedVoiceEntries();
assert.ok(document.querySelector(".voice-installed-badge"), "install appears on slot refresh, with UUID case normalized");
document.body.innerHTML = context.renderAuthorizedVoice(trial.name, [trial], "other-slot");
assert.equal(document.querySelector(".voice-installed-badge"), null, "installation in a different slot does not count");
document.body.innerHTML = context.renderAuthorizedVoice(trial.name, [{ ...trial, id: "different-product" }], "fixture-slot");
assert.equal(document.querySelector(".voice-installed-badge"), null, "matching names and artwork do not prove a product is installed");
document.body.innerHTML = context.renderAuthorizedVoice(trial.name, [], "fixture-slot");
assert.equal(document.querySelector(".voice-installed-badge"), null, "a missing product ID does not invent an installation");
document.body.innerHTML = context.renderAuthorizedVoice(trial.name, [{ ...trial, isTrial: false, expiresAtUtc: null }]);
assert.equal(document.querySelector(".voice-trial-badge"), null, "permanent ownership is not advertised as a trial");
document.body.innerHTML = context.renderAuthorizedVoice(trial.name, [{ ...trial, expiresAtUtc: null }]);
assert.equal(document.querySelector(".voice-trial-badge").textContent, "限时试用");
assert.equal(document.querySelector(".voice-license-expiry"), null, "unknown expiry does not invent a deadline");
document.body.innerHTML = context.renderAuthorizedVoice(trial.name, [{ ...trial, expiresAtUtc: "2000-01-01T00:00:00Z" }]);
assert.equal(document.querySelector(".voice-trial-badge").textContent, "试用已到期");
console.log("Voice license rendering and asynchronous artwork passed.");
