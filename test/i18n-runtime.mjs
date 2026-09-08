import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../src/PiDesktop.Tauri/package.json", import.meta.url));
const runtimeUrl = pathToFileURL(require.resolve("vue-i18n")).href;
await import(runtimeUrl);
const source = name => readFileSync(new URL(`../src/PiDesktop.Tauri/src/${name}.ts`, import.meta.url), "utf8");
const moduleUrl = text => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(text)).toString("base64")}`;
const values = new Map([["synthv-toolbox.locale", "en"]]);
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
globalThis.document = { documentElement: { lang: "" } };
const i18nSource = source("i18n").replace('from "vue-i18n"', `from ${JSON.stringify(runtimeUrl)}`);
const i18nUrl = moduleUrl(i18nSource);
const { t, locale, setLocale, i18n } = await import(i18nUrl);
for (const name of ["i18nCommon", "i18nAccounts", "i18nBridge", "i18nHome", "i18nLyrics", "i18nWorkflows", "i18nCopilot", "i18nSystem"]) {
  await import(moduleUrl(source(name).replace('from "./i18n"', `from ${JSON.stringify(i18nUrl)}`)));
}
const literalKeys = [...source("main").matchAll(/\bt\("([^"`]+)"/g)].map(match => match[1]);
for (const language of ["zh-CN", "en"]) {
  for (const key of new Set(literalKeys)) assert.ok(i18n.global.te(key, language), `Missing ${language} message: ${key}`);
}
assert.equal(locale(), "en");
assert.equal(document.documentElement.lang, "en");
assert.equal(t("nav.settings"), "Settings");
assert.equal(t("connections.configurations", { count: 3 }), "3 configured");

const featureMessagesUrl = moduleUrl(source("featureMessages"));
const catalogSource = source("featureCatalog")
  .replace('from "./i18n"', `from ${JSON.stringify(i18nUrl)}`)
  .replace('from "./featureMessages"', `from ${JSON.stringify(featureMessagesUrl)}`);
const { featureCatalog, toolGroups } = await import(moduleUrl(catalogSource));
const vocalFeature = featureCatalog.find(feature => feature.id === "audio-preparation");
assert.equal(vocalFeature.title, "Audio preparation");
for (const feature of featureCatalog) {
  for (const text of [feature.title, feature.description, ...feature.base, ...feature.ai, ...feature.requirements]) {
    assert.doesNotMatch(text, /[\p{Script=Han}]/u, `Untranslated feature: ${feature.id}`);
    assert.doesNotMatch(text, /^features\./, `Missing feature message: ${text}`);
  }
}
assert.deepEqual(toolGroups.map(group => group.title), ["Import", "Convert", "Analyze", "Quality check"]);
setLocale("zh-CN");
assert.equal(document.documentElement.lang, "zh-CN");
assert.equal(values.get("synthv-toolbox.locale"), "zh-CN");
assert.equal(vocalFeature.title, "音频准备");
assert.deepEqual(toolGroups.map(group => group.title), ["导入", "转换", "分析", "质检"]);
setLocale("en");
assert.equal(vocalFeature.title, "Audio preparation");
assert.equal(values.get("synthv-toolbox.locale"), "en");
const reloaded = await import(moduleUrl(`${i18nSource}\nexport const reloaded = true;`));
assert.equal(reloaded.locale(), "en");
values.set("synthv-toolbox.locale", "invalid");
const invalid = await import(moduleUrl(`${i18nSource}\nexport const invalid = true;`));
assert.equal(invalid.locale(), "zh-CN");
globalThis.localStorage = { getItem() { throw new Error("Storage unavailable"); }, setItem() { throw new Error("Storage unavailable"); } };
const unavailable = await import(moduleUrl(`${i18nSource}\nexport const unavailable = true;`));
assert.equal(unavailable.locale(), "zh-CN");
assert.doesNotThrow(() => unavailable.setLocale("en"));
assert.equal(unavailable.t("nav.settings"), "Settings");
console.log("Language persistence, translation key coverage, interpolation, and live catalog translations passed.");
