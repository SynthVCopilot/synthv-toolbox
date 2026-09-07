import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { JSDOM } from "../src/PiDesktop.Tauri/node_modules/jsdom/lib/api.js";

const repositoryRoot = process.env.LYRIC_UI_TEST_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(repositoryRoot, "src", "PiDesktop.Tauri", "src", "main.ts"), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function handler(name) {
  const start = source.indexOf(`document.addEventListener("${name}"`);
  assert.notEqual(start, -1, `missing ${name} listener`);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 3);
  }
  throw new Error(`unterminated ${name} listener`);
}

function harness(api) {
  const dom = new JSDOM(`<div class="lyric-workbench-grid"><input data-lyric-bridge-slot="0" value="旧" /><input data-lyric-bridge-slot="1" value="词" /><div data-lyric-bridge-preview><button data-confirm-lyric-bridge-fit>confirm</button></div><button data-preview-lyric-bridge-fit>preview</button><button data-read-lyric-bridge-selection>read</button><button data-select-lyric-history="0">history</button></div>`);
  const document = dom.window.document;
  const code = `
    let lyricBridgeSelection = { selectionToken: "old", sessionToken: "session", noteCount: 2, notes: [{ lyric: "旧" }, { lyric: "词" }] };
    let lyricBridgePreview = { previewToken: "preview" };
    let lyricBridgeSlots = ["旧", "词"];
    let lyricBridgeGeneration = 0;
    let lyricCandidateHistory = [{ candidates: [{ text: "saved" }] }];
    let lyricCandidates;
    let lyricPersistTimer;
    let notice = "";
    let error = "";
    let busy = false;
    const page = "lyrics";
    const window = __window;
    const document = __document;
    const api = __api;
    const render = () => {};
    const t = (key, values = {}) => key === "lyrics.writtenToSynthv" ? String(values.count) : key;
    const syncLyricDraftFromDom = () => {};
    const lyricProjectHasUnsavedChanges = () => false;
    const startNewLyricProject = () => { lyricBridgeGeneration += 1; lyricBridgeSelection = undefined; lyricBridgePreview = undefined; };
    const applyLyricProject = startNewLyricProject;
    const run = async (task) => { if (busy) return; busy = true; try { await task(); } finally { busy = false; } };
    ${handler("input")}
    ${handler("click")}
    module.exports = { state: () => ({ lyricBridgeSelection, lyricBridgePreview, lyricBridgeSlots, lyricBridgeGeneration, lyricCandidates, notice }), document };
  `;
  const module = { exports: {} };
  vm.runInNewContext(stripTypeScriptTypes(code), { module, __api: api, __document: document, __window: dom.window, console, setTimeout, clearTimeout, HTMLMediaElement: dom.window.HTMLMediaElement, navigator: dom.window.navigator });
  return module.exports;
}

function click(document, selector) {
  document.querySelector(selector).dispatchEvent(new document.defaultView.MouseEvent("click", { bubbles: true }));
}

{
  const ui = harness({});
  const input = ui.document.querySelector('[data-lyric-bridge-slot="0"]');
  input.focus();
  input.value = "新";
  input.dispatchEvent(new ui.document.defaultView.Event("input", { bubbles: true }));
  assert.equal(ui.state().lyricBridgePreview, undefined);
  assert.equal(ui.document.querySelector("[data-confirm-lyric-bridge-fit]"), null);
  assert.equal(ui.document.activeElement, input, "editing a slot must keep focus without a full render");
}

{
  const pending = deferred();
  const ui = harness({
    previewLyricBridgeFit: () => pending.promise,
    readLyricBridgeSelection: async () => ({ selectionToken: "new", sessionToken: "session", noteCount: 2, notes: [{ lyric: "新" }, { lyric: "词" }] }),
  });
  click(ui.document, "[data-preview-lyric-bridge-fit]");
  click(ui.document, "[data-read-lyric-bridge-selection]");
  pending.resolve({ previewToken: "late" });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(ui.state().lyricBridgePreview, undefined, "a late preview must not overwrite a newer selection");
}

{
  const pending = deferred();
  const ui = harness({ previewLyricBridgeFit: () => pending.promise });
  click(ui.document, "[data-preview-lyric-bridge-fit]");
  pending.resolve({ previewToken: "current-preview" });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(ui.state().lyricBridgePreview?.previewToken, "current-preview", "the current preview response must remain confirmable");
}

{
  const pending = deferred();
  const ui = harness({ previewLyricBridgeFit: () => pending.promise });
  click(ui.document, "[data-preview-lyric-bridge-fit]");
  const input = ui.document.querySelector('[data-lyric-bridge-slot="0"]');
  input.value = "改";
  input.dispatchEvent(new ui.document.defaultView.Event("input", { bubbles: true }));
  pending.resolve({ previewToken: "stale-after-edit" });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(ui.state().lyricBridgePreview, undefined, "editing a slot must invalidate an in-flight preview response");
}

{
  let confirmations = 0;
  const ui = harness({ confirmLyricBridgeFit: async () => { confirmations += 1; return { noteCount: 2 }; } });
  click(ui.document, "[data-confirm-lyric-bridge-fit]");
  click(ui.document, "[data-confirm-lyric-bridge-fit]");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(confirmations, 1, "a preview token may be confirmed only once from the UI");
}

{
  const ui = harness({});
  click(ui.document, "[data-select-lyric-history]");
  assert.equal(JSON.stringify(ui.state().lyricCandidates), JSON.stringify({ candidates: [{ text: "saved" }] }));
}

console.log("Lyric Bridge UI behavior passed.");
