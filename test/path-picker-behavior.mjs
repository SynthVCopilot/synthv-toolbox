import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { JSDOM } from "../src/PiDesktop.Tauri/node_modules/jsdom/lib/api.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, "src", "PiDesktop.Tauri", "src", "main.ts"), "utf8");
const apiSource = readFileSync(join(root, "src", "PiDesktop.Tauri", "src", "api.ts"), "utf8");
assert.match(apiSource, /pickProjectFile:[\s\S]*?filters:\s*\[\{\s*name:\s*"Synthesizer V Project",\s*extensions:\s*\["svp"\]/, "project picker constrains the native dialog to SVP files");
assert.doesNotMatch(apiSource, /pickFile:/, "generic project picker was removed");
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
  api: { pickProjectFile: async () => undefined, pickAudioFile: async () => undefined, pickDirectory: async () => undefined },
  t: (key) => key, icon: (name) => `<svg data-icon="${name}"></svg>`, escapeHtml: (value) => String(value),
});
vm.runInContext(stripTypeScriptTypes(`${extract("pathPickerButton")}\n${extract("pickPathIntoInput")}`), context);
const path = dom.window.document.querySelector("#path");
path.addEventListener("input", () => calls.push("input"));
path.addEventListener("change", () => calls.push("change"));

await context.pickPathIntoInput("path", "project");
assert.equal(path.value, "old", "cancel preserves the existing value");
assert.deepEqual(calls, []);

context.api.pickProjectFile = async () => "C:/picked.svp";
await context.pickPathIntoInput("path", "project");
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
context.api.pickProjectFile = () => new Promise((next) => { resolve = next; });
const replacement = context.pickPathIntoInput("path", "project");
const next = dom.window.document.createElement("input"); next.id = "path"; next.value = "replacement";
path.replaceWith(next); resolve("C:/stale.svp"); await replacement;
assert.equal(next.value, "replacement", "a replaced input rejects a stale picker result");

next.disabled = true;
context.api.pickProjectFile = async () => "C:/disabled.svp";
await context.pickPathIntoInput("path", "project");
assert.equal(next.value, "replacement", "disabled input is not changed");

for (const [kind, glyph] of [["project", "file"], ["audio", "file"], ["directory", "folder"]]) {
  const buttonDom = new JSDOM(context.pathPickerButton("target", kind)).window.document.querySelector("button");
  assert.equal(buttonDom.textContent.trim(), "", "picker has no visible text");
  assert.ok(buttonDom.getAttribute("aria-label")); assert.ok(buttonDom.getAttribute("title"));
  assert.equal(buttonDom.querySelector("svg").dataset.icon, glyph);
}

const midiContext = vm.createContext({ audioToProjectVocalPath: "", audioToProjectInstrumentalPath: "", audioToProjectOutputDirectory: "", audioToProjectOutputDirectoryWasChosen: false, render() {} });
vm.runInContext(stripTypeScriptTypes(`${extract("sourceDirectory")}\n${extract("setAudioToProjectVocalPath")}\n${extract("setAudioToProjectInstrumentalPath")}`), midiContext);
midiContext.setAudioToProjectVocalPath("C:/songs/first.wav");
assert.equal(midiContext.audioToProjectOutputDirectory, "C:/songs", "vocal selection defaults output to its source directory");
midiContext.audioToProjectOutputDirectory = "D:/exports";
midiContext.audioToProjectOutputDirectoryWasChosen = true;
midiContext.setAudioToProjectVocalPath("C:/songs/second.wav");
assert.equal(midiContext.audioToProjectOutputDirectory, "D:/exports", "explicit output directory survives a new vocal selection");
midiContext.setAudioToProjectInstrumentalPath("C:/songs/inst.wav");
assert.equal(midiContext.audioToProjectInstrumentalPath, "C:/songs/inst.wav", "instrumental selection updates its independent optional field");

console.log("Path picker behavior passed.");
