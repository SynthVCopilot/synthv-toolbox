import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { JSDOM } from '../src/PiDesktop.Tauri/node_modules/jsdom/lib/api.js';

const source = readFileSync(new URL('../src/PiDesktop.Tauri/src/main.ts', import.meta.url), 'utf8');
const require = createRequire(new URL('../src/PiDesktop.Tauri/package.json', import.meta.url));
const { createI18n } = require('vue-i18n');
const messagesSource = (name) => readFileSync(new URL(`../src/PiDesktop.Tauri/src/${name}`, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
const i18n = createI18n({ legacy: false, locale: 'en', fallbackLocale: 'zh-CN', messages: {} });
const addMessages = (language, messages) => i18n.global.mergeLocaleMessage(language, messages);
for (const name of ['i18nCommon.ts', 'i18nWorkflows.ts']) vm.runInNewContext(messagesSource(name), { addMessages });
const t = (key, params = {}) => {
  assert.ok(i18n.global.te(key), `Missing locale message: ${key}`);
  return i18n.global.t(key, params);
};
const functions = new Set(['escapeHtml', 'asObject', 'renderWorkflowPanel']);
const parser = require('@babel/parser');
const ast = parser.parse(source, { sourceType: 'module', plugins: ['typescript'] });
const implementations = ast.program.body
  .filter((node) => node.type === 'FunctionDeclaration' && functions.has(node.id.name))
  .map((node) => source.slice(node.start, node.end)).join('\n');
const state = {
  t,
  icon: () => '',
  app: { mode: 'ai', bridgeConnected: true },
  features: [{ id: 'cover', title: 'One-click Cover', description: 'Full-song Cover', accent: 'violet', icon: 'sparkles' }],
  toolGroups: [{ id: 'import', title: 'Import', featureIds: ['cover'] }],
  workflowResult: undefined,
  coverDraft: { source: '', voice: '', process: '', lyrics: '', track: '1', group: 'Toolbox Cover', rights: false },
  synthvProcesses: [],
  mediaTasks: [],
};
vm.createContext(state);
vm.runInContext(stripTypeScriptTypes(implementations, { mode: 'strip' }), state);
function rendered() {
  return new JSDOM(state.renderWorkflowPanel('cover')).window.document;
}

state.mediaTasks = [{
  id: 'cover-result', kind: 'cover', status: 'completed', stage: 'ai_tuning', progress: 100, detail: 'Done',
  repairConversationId: 'repair-chat', tuningConversationId: 'tuning-chat',
  result: {
    sourceAudioPath: '/managed/source.wav', vocalPath: '/managed/vocals.wav', instrumentalPath: '/managed/inst.wav',
    lyricsPath: '/managed/lyrics.txt', repairedScorePath: '/managed/score.mid', reportPath: '/managed/report.json',
    svpPath: '/managed/song.svp', saveVerified: true, renderStatus: 'not_rendered',
    recognition: { noteCount: 120, rawNoteCount: 110, inference: 'full-song', separationDevice: 'cpu' },
    repair: { noteCount: 120, changeCount: 14, unresolved: [{ note: 3 }] },
    tuning: { notesReviewed: 120, verifiedWrites: 3 },
  },
}];
const result = rendered();
assert.match(result.body.textContent, /Full-song recognition: 120 notes \(raw 110\) · inference full-song · separation device cpu/);
assert.match(result.body.textContent, /Notes repaired 120 · changes 14 · unresolved 1/);
assert.match(result.body.textContent, /AI tuning: reviewed 120 notes · verified writes 3/);
assert.match(result.body.textContent, /Project saved; audio has not been rendered/);
assert.equal(result.querySelector('#cover-voice').required, false);
assert.equal(result.querySelectorAll('[data-cover-copy-path]').length, 7);
assert.ok(result.querySelector('[data-conversation="repair-chat"]'));
assert.ok(result.querySelector('[data-conversation="tuning-chat"]'));

state.mediaTasks = [{ id: 'unsafe-retry', kind: 'cover', status: 'failed', retryable: false, progress: 70, detail: 'Stopped', result: null }];
const failed = rendered();
assert.equal(failed.querySelector('[data-retry-media-task]'), null);
assert.match(failed.body.textContent, /may already have written to SynthV/);
assert.match(failed.querySelector('#cover-lyrics').getAttribute('placeholder'), /recognize lyrics from the full-song vocals/);
assert.match(source, /function renderKeepingCoverDraft\(\)[\s\S]*?syncCoverDraftFromDom\(\)[\s\S]*?render\(\)[\s\S]*?setSelectionRange/);
assert.match(source, /page !== "convert" \|\| \(activeWorkflow !== "audio-preparation" && activeWorkflow !== "audio-to-project"\)/);
assert.doesNotMatch(source, /page === "import" && activeWorkflow === "audio-preparation"/);

console.log('Cover UI behavior contracts passed.');
