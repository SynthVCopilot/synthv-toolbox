import assert from "node:assert/strict";
import fs from "node:fs";

const i18n = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/i18n.ts", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");
const shell = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/vue/shell.ts", import.meta.url), "utf8");

assert.match(i18n, /createI18n/);
assert.match(i18n, /localStorage\.getItem\(storageKey\) === "en" \? "en" : fallbackLocale/);
assert.match(i18n, /localStorage\.setItem\(storageKey, next\)/);
assert.match(i18n, /document\.documentElement\.lang = next/);
assert.match(i18n, /"zh-CN"[\s\S]*connections:[\s\S]*localService/);
assert.match(i18n, /en:[\s\S]*connections:[\s\S]*localService/);
assert.match(shell, /\.use\(i18n\)\.mount\(element\)/);
assert.match(main, /id="language-select"[\s\S]*value="zh-CN"[\s\S]*value="en"/);
assert.match(main, /setLocale\(\(event\.currentTarget as HTMLSelectElement\)\.value === "en" \? "en" : "zh-CN"\)[\s\S]*render\(\)/);

console.log("I18n UI contracts passed.");
