import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { JSDOM } from "../src/PiDesktop.Tauri/node_modules/jsdom/lib/api.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, "src", "PiDesktop.Tauri", "src", "main.ts"), "utf8");
const extract = (name) => {
  const functionStart = source.indexOf(`function ${name}(`);
  const start = source.lastIndexOf("async ", functionStart) === functionStart - 6 ? functionStart - 6 : functionStart;
  assert.notEqual(start, -1, `missing ${name}`);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
};

const dom = new JSDOM(`<form><input id="path" value="old" /><input id="other" value="keep" /></form>`);
const calls = [];
const context = vm.createContext({
  document: dom.window.document, Event: dom.window.Event, page: "import",
  api: { pickFile: async () => undefined, pickAudioFile: async () => undefined, pickDirectory: async () => undefined },
  t: (key) => key, icon: (name) => `<svg data-icon="${name}"></svg>`, escapeHtml: (value) => String(value),
});
vm.runInContext(stripTypeScriptTypes(`${extract("pathPickerButton")}\n${extract("pickPathIntoInput")}`), context);
const path = dom.window.document.querySelector("#path");
path.addEventListener("input", () => calls.push("input"));
path.addEventListener("change", () => calls.push("change"));

await context.pickPathIntoInput("path", "file");
assert.equal(path.value, "old", "cancel preserves the existing value");
assert.deepEqual(calls, []);

context.api.pickFile = async () => "C:/picked.svp";
await context.pickPathIntoInput("path", "file");
assert.equal(path.value, "C:/picked.svp");
assert.equal(dom.window.document.querySelector("#other").value, "keep", "picker does not alter sibling form draft");
assert.deepEqual(calls, ["input", "change"]);

context.api.pickAudioFile = async () => "C:/late.wav";
const late = context.pickPathIntoInput("path", "audio");
context.page = "quality";
await late;
assert.equal(path.value, "C:/picked.svp", "navigation while chooser is open discards its result");
context.page = "import";

let resolve;
context.api.pickFile = () => new Promise((next) => { resolve = next; });
const replacement = context.pickPathIntoInput("path", "file");
const next = dom.window.document.createElement("input"); next.id = "path"; next.value = "replacement";
path.replaceWith(next); resolve("C:/stale.svp"); await replacement;
assert.equal(next.value, "replacement", "a replaced input rejects a stale picker result");

next.disabled = true;
context.api.pickFile = async () => "C:/disabled.svp";
await context.pickPathIntoInput("path", "file");
assert.equal(next.value, "replacement", "disabled input is not changed");

for (const [kind, glyph] of [["file", "file"], ["audio", "file"], ["directory", "folder"]]) {
  const buttonDom = new JSDOM(context.pathPickerButton("target", kind)).window.document.querySelector("button");
  assert.equal(buttonDom.textContent.trim(), "", "picker has no visible text");
  assert.ok(buttonDom.getAttribute("aria-label")); assert.ok(buttonDom.getAttribute("title"));
  assert.equal(buttonDom.querySelector("svg").dataset.icon, glyph);
}

console.log("Path picker behavior passed.");
