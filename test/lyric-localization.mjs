import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const require = createRequire(new URL("../src/PiDesktop.Tauri/package.json", import.meta.url));
await import(pathToFileURL(require.resolve("vue-i18n")).href);
const source = name => readFileSync(new URL(`../src/PiDesktop.Tauri/src/${name}.ts`, import.meta.url), "utf8");
const moduleUrl = text => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(text)).toString("base64")}`;
globalThis.localStorage = { getItem: () => "en", setItem() {} };
globalThis.document = { documentElement: { lang: "" } };
const i18nUrl = moduleUrl(source("i18n").replace('from "vue-i18n"', `from ${JSON.stringify(pathToFileURL(require.resolve("vue-i18n")).href)}`));
const { t, locale, setLocale } = await import(i18nUrl);
for (const name of ["i18nCommon", "i18nLyrics"]) await import(moduleUrl(source(name).replace('from "./i18n"', `from ${JSON.stringify(i18nUrl)}`)));
const main = source("main");
const names = ["escapeHtml", "createLyricSection", "createLyricPreset", "lyricWorkspaceSnapshot", "lyricProjectHasUnsavedChanges", "renderLyricStudio", "renderLyricCandidates", "renderLyricBridgeFit", "renderRhymeLookupResult", "renderLyricTemplateResult", "renderLyricsPage", "renderHistoryPage", "formatHistoryTime"];
const functions = names.map(name => {
  const start = main.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name);
  return main.slice(start, main.indexOf("\n}", start) + 2);
});
assert.equal(functions.length, names.length);
for (const fn of functions) assert.doesNotMatch(fn, /[\p{Script=Han}]/u, "Hard-coded UI");
const context = vm.createContext({ t, locale, icon: () => "", console,
  asObject: value => value && typeof value === "object" && !Array.isArray(value) ? value : undefined,
  resultMetric: (label, value) => `${label}: ${value}`,
  app: { mode: "ai" }, workflowResult: undefined,
  lyricSectionCounter: 0, lyricSongTitle: "私の歌 <title>", lyricDraft: "原文 unchanged <script>\n第二行", lyricRhymeTargets: { A: "ang" },
  lyricSections: [{ id: "one", kind: "verse", label: "用户段落 <verse>", lineCount: 4, rhymeScheme: "ABAB" }],
  lyricCandidateSection: "用户段落 <verse>", lyricCandidateBrief: "自定义意图", lyricCandidateImagery: "雨", lyricCandidateTone: "温柔", lyricCandidateRhyme: "ang", lyricCandidateCount: 4,
  lyricCandidates: undefined, lyricCandidateHistory: [], lyricBridgeSelection: undefined, lyricBridgePreview: undefined, lyricBridgeSlots: [], lyricRhymeResult: undefined, lyricRhymeQuery: "ang", lyricRhymeMode: "family",
  lyricProjects: [{ id: "saved", title: "已保存标题", lineCount: 2, revision: 1 }], lyricProjectId: "saved", lyricProjectRevision: 1, lyricProjectVersions: [], lyricSavedSnapshot: "",
  creativeHistory: [], projectCheckpoints: [], projectBackupState: undefined, historyLoadState: "ready", historyLoadError: "",
});
vm.runInContext(stripTypeScriptTypes(functions.join("\n")), context);
const snapshot = context.lyricWorkspaceSnapshot();
context.lyricSavedSnapshot = snapshot;
const english = context.renderLyricStudio(true);
for (const text of ["Song title", "Lyric draft", "Section name", "Add section", "Suggest some lines", "Number of suggestions", "Find rhyming characters", "2 lines", "Move up", "Copy", "Clear", "Export TXT"]) assert.ok(english.includes(text), text);
assert.ok(english.includes("原文 unchanged &lt;script&gt;"));
assert.ok(english.includes("用户段落 &lt;verse&gt;"));
assert.ok(english.includes('value="family"')); assert.ok(english.includes('value="ABAB"'));
assert.ok(context.renderLyricStudio(false).includes("Enable Copilot"));
assert.ok(context.renderLyricsPage().includes("Focus on your lyrics"));
context.lyricBridgeSelection = { selectionToken: "s", sessionToken: "x", target: { trackIndex: 2, groupIndex: 3 }, noteCount: 2, notes: [{ noteIndex: 4, lyric: "旧" }, { noteIndex: 7, lyric: "词" }] };
context.lyricBridgeSlots = ["新", "词"];
context.lyricBridgePreview = { previewToken: "p", slotCount: 2, notes: [{ noteIndex: 4, currentLyric: "旧", text: "新" }, { noteIndex: 7, currentLyric: "词", text: "词" }] };
const bridge = context.renderLyricBridgeFit();
for (const text of ["Track 2 · group 3", "4: 旧 → 新", "7: 词 → 词", "Confirm write", "Fill from draft selection"]) assert.ok(bridge.includes(text), text);
setLocale("zh-CN");
assert.ok(context.renderLyricStudio(true).includes("段落名称"));
assert.equal(context.lyricWorkspaceSnapshot(), snapshot);
assert.equal(context.lyricProjectHasUnsavedChanges(), false);
assert.equal(context.createLyricPreset("blank")[0].label, "段落 1");
setLocale("en");
assert.equal(context.createLyricPreset("blank")[0].label, "Section 1");
for (const preset of ["compact", "pop", "rap", "blank"]) {
  const englishPreset = context.createLyricPreset(preset);
  setLocale("zh-CN"); const chinesePreset = context.createLyricPreset(preset); setLocale("en");
  assert.equal(JSON.stringify(englishPreset.map(({ kind, lineCount, rhymeScheme }) => ({ kind, lineCount, rhymeScheme }))), JSON.stringify(chinesePreset.map(({ kind, lineCount, rhymeScheme }) => ({ kind, lineCount, rhymeScheme }))));
}
context.lyricCandidates = { candidates: [{ text: "原创 <line>", rhymeMatched: true }, { text: "another", rhymeMatched: false }, { text: "free" }] };
const candidates = context.renderLyricCandidates();
for (const text of ["Rhyme: target rhyme", "Ending does not match", "No rhyme constraint", "原创 &lt;line&gt;", "Add to draft"]) assert.ok(candidates.includes(text), text);
context.lyricRhymeResult = { matchMode: "family", rhymeKeys: ["ang"], queryPinyin: ["guang"], total: 1, characters: [{ character: "光", pinyin: ["guang"] }], coverageNote: "字典说明" };
const rhyme = context.renderRhymeLookupResult();
assert.ok(rhyme.includes("Rhyme family")); assert.ok(rhyme.includes('data-rhyme-character="光"')); assert.ok(rhyme.includes("字典说明"));
const template = { language: "zh-CN", sections: [{ lines: [{ lineNumber: 1 }] }], totalLines: 1 };
assert.ok(context.renderLyricTemplateResult(template).includes("Untitled section"));
assert.ok(context.renderLyricTemplateResult(template).includes("Write lyrics"));
assert.equal(context.renderLyricTemplateResult({ ...template, language: "en" }), undefined);
context.projectCheckpoints = [{ id: "checkpoint", label: "用户快照", sourcePath: "song.svp", sourceSha256: "1234567890abcdef", createdAtUtc: "2026-09-06T12:00:00Z" }];
assert.ok(context.renderHistoryPage().includes("Restore copy"));
context.historyLoadState = "error";
assert.ok(context.renderHistoryPage().includes("Could not read history"));
for (const match of main.matchAll(/t\("(lyrics\.[^"]+)"/g)) assert.notEqual(t(match[1], { count: 2, lines: 2, characters: 4, sections: 1, revision: 1, title: "title", rhyme: "ang" }), match[1]);
assert.notEqual(t("lyrics.copyFailed"), t("lyrics.copy"));
console.log("Lyric controls, history, presets, results, and content preservation passed in both locales.");
