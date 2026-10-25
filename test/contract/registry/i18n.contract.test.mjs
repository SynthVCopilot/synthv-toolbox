import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { appRoot, rendererModuleUrl, rendererSource, vueI18nUrl } from "../_lib/load.mjs";

// vue-i18n pulls in runtime-dom, which needs the real (absent) document, so the stubs come after it.
await import(vueI18nUrl());

const values = new Map([["synthv-toolbox.locale", "en"]]);
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
globalThis.document = { documentElement: { lang: "" } };

const { baseCompile } = createRequire(createRequire(new URL("package.json", appRoot)).resolve("@intlify/core-base"))("@intlify/message-compiler");

const srcDirectory = fileURLToPath(new URL("src/", appRoot));
const sourceFiles = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []);
const dictionaries = sourceFiles(srcDirectory)
  .filter(file => readFileSync(file, "utf8").includes("addMessages("))
  .map(file => relative(srcDirectory, file).replaceAll("\\", "/").replace(/\.ts$/, ""));

const i18nModule = await import(rendererModuleUrl("i18n"));
for (const name of dictionaries) await import(rendererModuleUrl(name));
const { i18n } = i18nModule;

const LANGUAGES = ["zh-CN", "en"];

/** Flattens nested objects and arrays to dotted keys; a message is a string leaf. */
function flatten(node, prefix = "", out = new Map()) {
  if (typeof node === "string") out.set(prefix, node);
  else if (node && typeof node === "object") for (const [key, child] of Object.entries(node)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  else if (prefix) out.set(prefix, node);
  return out;
}

const catalogs = Object.fromEntries(LANGUAGES.map(language => [language, flatten(i18n.global.getLocaleMessage(language))]));
const allKeys = [...new Set(LANGUAGES.flatMap(language => [...catalogs[language].keys()]))].sort();

/** Named and list placeholders and linked keys the compiled message refers to. */
function placeholders(ast) {
  const found = [];
  const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    if (node.type === 4) found.push(`{${node.key}}`);
    else if (node.type === 5) found.push(`{${node.index}}`);
    else if (node.type === 6) found.push(`@${node.key?.value ?? ""}`);
    for (const child of Object.values(node)) if (child && typeof child === "object") visit(child);
  };
  visit(ast.body);
  return [...new Set(found)].sort();
}

function compileMessage(text) {
  const errors = [];
  const result = baseCompile(text, { onError: error => errors.push(`${error.message}`), location: false });
  return { errors, placeholders: placeholders(result.ast) };
}

test("renderer dictionaries were discovered", () => {
  assert.ok(dictionaries.includes("i18nCommon") && dictionaries.includes("featureCatalog"), `found: ${dictionaries.join(", ")}`);
  assert.ok(allKeys.length > 100);
});

test("every key exists in zh-CN and en with a non-empty string", () => {
  const problems = [];
  for (const key of allKeys) for (const language of LANGUAGES) {
    const message = catalogs[language].get(key);
    if (message === undefined) problems.push(`${language} is missing ${key}`);
    else if (typeof message !== "string" || !message.trim()) problems.push(`${language} ${key} is not a non-empty string`);
  }
  assert.deepEqual(problems, []);
});

test("every message compiles in vue-i18n and keeps its literal braces", () => {
  const problems = [];
  for (const language of LANGUAGES) for (const [key, message] of catalogs[language]) {
    if (typeof message !== "string") continue;
    const { errors } = compileMessage(message);
    if (errors.length) problems.push(`${language} ${key}: ${errors.join("; ")}`);
    // The compiler drops a lone "{" without an error, so the message would render with text missing.
    const stray = message.replace(/\{\s*[\w.]+\s*\}/g, "").replace(/\{'[^']*'\}/g, "");
    if (/[{}]/.test(stray)) problems.push(`${language} ${key}: stray brace in ${JSON.stringify(message)}`);
  }
  assert.deepEqual(problems, []);
});

test("both languages use the same interpolation placeholders for every key", () => {
  const problems = [];
  for (const key of allKeys) {
    const [chinese, english] = LANGUAGES.map(language => catalogs[language].get(key));
    if (typeof chinese !== "string" || typeof english !== "string") continue;
    const [a, b] = [chinese, english].map(message => compileMessage(message).placeholders);
    if (a.join() !== b.join()) problems.push(`${key}: zh-CN ${a.join(" ") || "-"} vs en ${b.join(" ") || "-"}`);
  }
  assert.deepEqual(problems, []);
});

test("literal t(\"...\") keys used in main.ts resolve in both languages", () => {
  const literalKeys = new Set([...rendererSource("main").matchAll(/\bt\("([^"`]+)"/g)].map(match => match[1]));
  const missing = [...literalKeys].flatMap(key => LANGUAGES.filter(language => !i18n.global.te(key, language)).map(language => `${language} ${key}`));
  assert.deepEqual(missing, []);
});

test("locale persistence survives invalid and unavailable storage", async () => {
  const { t, locale, setLocale } = i18nModule;
  assert.equal(locale(), "en");
  assert.equal(document.documentElement.lang, "en");
  assert.equal(t("nav.settings"), "Settings");
  assert.equal(t("connections.configurations", { count: 3 }), "3 configured");
  setLocale("zh-CN");
  assert.equal(document.documentElement.lang, "zh-CN");
  assert.equal(values.get("synthv-toolbox.locale"), "zh-CN");
  setLocale("en");
  assert.equal(values.get("synthv-toolbox.locale"), "en");

  const reload = marker => import(`${rendererModuleUrl("i18n")}#${marker}`);
  values.set("synthv-toolbox.locale", "invalid");
  assert.equal((await reload("invalid")).locale(), "zh-CN");
  globalThis.localStorage = { getItem() { throw new Error("Storage unavailable"); }, setItem() { throw new Error("Storage unavailable"); } };
  const unavailable = await reload("unavailable");
  assert.equal(unavailable.locale(), "zh-CN");
  assert.doesNotThrow(() => unavailable.setLocale("en"));
  assert.equal(unavailable.t("nav.settings"), "Settings");
});

test("the feature catalog shows no untranslated text in English or Chinese", async () => {
  const { featureCatalog, toolGroups } = await import(rendererModuleUrl("featureCatalog"));
  const { setLocale } = i18nModule;
  setLocale("en");
  for (const feature of featureCatalog) {
    for (const text of [feature.title, feature.description, ...feature.base, ...feature.ai, ...feature.requirements]) {
      assert.doesNotMatch(text, /[\p{Script=Han}]/u, `Untranslated feature: ${feature.id}`);
      assert.doesNotMatch(text, /^features\./, `Missing feature message: ${text}`);
    }
  }
  assert.deepEqual(toolGroups.map(group => group.title), ["Import", "Convert", "Analyze", "Quality check"]);
  setLocale("zh-CN");
  assert.deepEqual(toolGroups.map(group => group.title), ["导入", "转换", "分析", "质检"]);
  setLocale("en");
});
