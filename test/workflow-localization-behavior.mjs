import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { JSDOM } from '../src/PiDesktop.Tauri/node_modules/jsdom/lib/api.js';
const require = createRequire(new URL('../src/PiDesktop.Tauri/package.json', import.meta.url));
const { parse } = require('@babel/parser');
const { createI18n } = require('vue-i18n');
const read = (name) => readFileSync(new URL('../src/PiDesktop.Tauri/src/' + name, import.meta.url), 'utf8');
const i18n = createI18n({ legacy: false, locale: 'en', fallbackLocale: 'zh-CN', messages: {} });
const addMessages = (language, messages) => i18n.global.mergeLocaleMessage(language, messages);
for (const name of ['i18nCommon.ts', 'i18nWorkflows.ts', 'i18nCopilot.ts']) vm.runInNewContext(read(name).replace(/^import .*;\r?\n/gm, ''), { addMessages });
const t = (key, params = {}) => {
  assert.ok(i18n.global.te(key), `Missing ${i18n.global.locale.value} message: ${key}`);
  return i18n.global.t(key, params);
};
const source = read('main.ts');
const apiSource = read('api.ts');
assert.match(source, /event\.payload\.position\.toLogical\(window\.devicePixelRatio\)/, 'Native drops target the field under the pointer');
assert.match(source, /data-clear-pipeline-instrumental/, 'Optional instrumental input can be cleared');
assert.match(apiSource, /instrumentalPath: string \| null/);
assert.match(apiSource, /outputDirectory: string \| null/);
const functions = new Set(['escapeHtml', 'formatAudioNumber', 'isTerminalAudioJob', 'asObject', 'resultMetric', 'renderDiagnosticResult', 'renderBatchResult', 'renderScalarResult', 'renderAbAudioResult', 'sourceDirectory', 'renderWorkflowPanel', 'renderAudioPlanDialog', 'renderCopilot', 'renderMessage']);
const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
const implementations = ast.program.body.filter((node) => node.type === 'FunctionDeclaration' && functions.has(node.id.name)).map((node) => source.slice(node.start, node.end)).join('\n');
assert.doesNotMatch(implementations, /\p{Script=Han}/u, 'Static workflow wording must come from the dictionaries');
assert.doesNotMatch(implementations, /t\(['"]['"]\)/, 'No empty lookups');
const ids = ['audio-preparation', 'cover', 'tuning-learning', 'media-import', 'source-separation', 'audio-insight', 'score-to-synthv', 'project-tools', 'audio-to-project', 'project-doctor', 'batch-recipes', 'selective-sync', 'retake-compare', 'ab-audition', 'pronunciation-doctor', 'render-review', 'future-tool'];
const state = {
  t, locale: () => i18n.global.locale.value, icon: () => '', busy: false,
  conversation: undefined, conversations: [], fileApprovals: [], activeAiProvider: () => undefined, aiProviderDisplayName: (provider) => provider.displayName,
  app: { mode: 'ai', bridgeConnected: true, components: [], downloads: [] }, features: [], toolGroups: [], workflowResult: undefined,
  audioRuntime: { available: true, version: '8', detail: 'Runtime detail', source: 'system' },
  audioStartInFlight: false, audioJob: undefined, audioPlanRequestInFlight: false, audioLoudnessAnalysisInFlight: false,
  audioProbe: undefined, audioLoudness: undefined, audioPrepareForm: { inputPath: '', sampleFormat: 's24' },
  audioNormalizeForm: { integratedLufs: -16, truePeakDbtp: -1.5, loudnessRange: 11 }, audioUiNotice: '', audioUiError: '',
  audioInputGeneration: 0, audioArtifactActionInFlight: false, audioPreviewUrl: '', audioSourcePreviewUrl: '', audioCancelInFlight: false,
  synthvProcesses: [], mediaTasks: [], tuningProfiles: [], mediaSourcePreview: undefined, mediaSourceInput: '', audioToProjectVocalPath: '', audioToProjectInstrumentalPath: '', audioToProjectOutputDirectory: '', audioToProjectOutputDirectoryWasChosen: false, audioToProjectOutputName: 'audio_to_project.mid', audioToProjectTolerance: 0.08, audioToProjectAdvanced: true, audioToProjectImportToSynthv: false, audioToProjectRightsConfirmed: false, audioToProjectTrackIndex: 1, audioToProjectGroupName: 'Toolbox Audio Import',
  profiles: { slots: [] }, syncSourceSlotId: '', syncTargetSlotId: '', syncCategories: [], syncSelectedCategories: [], syncManifest: undefined, syncOverwrite: false,
  workflowRecipes: [], audioCaptureCapability: undefined, audioCaptureTargets: [], abProcessId: undefined,
  abStartSeconds: 0, abEndSeconds: 5, abPreRollSeconds: 0, abPostRollSeconds: 0, abBaselinePath: '', abCandidatePath: '', pendingAudioPlan: undefined,
};
vm.createContext(state);
vm.runInContext(stripTypeScriptTypes(implementations, { mode: 'strip' }), state);
function rendered(id) {
  const html = state.renderWorkflowPanel(id);
  assert.doesNotMatch(html, /workflowCopy\.|workflowTaskStatus\.|workflowRecipes\.|workflowSyncCategories\.|\$\{t\(/, id);
  const document = new JSDOM(html).window.document;
  assert.ok(document.querySelector('.workflow-panel'), id);
  if (i18n.global.locale.value === 'en') assert.doesNotMatch(document.body.textContent, /\p{Script=Han}/u, id);
  return document;
}
let renders = 0;
for (const language of ['en', 'zh-CN']) {
  i18n.global.locale.value = language;
  for (const mode of ['ai', 'toolbox']) for (const connected of [false, true]) {
    state.app = { mode, bridgeConnected: connected, components: [], downloads: [] };
    for (const id of ids) { rendered(id); renders++; }
  }
}
i18n.global.locale.value = 'en';
state.app = { mode: 'ai', bridgeConnected: true, components: [], downloads: [] };
state.profiles.slots = [{ id: 'a', displayName: 'Slot A', isActive: true }, { id: 'b', displayName: 'Slot B' }];
state.syncCategories = ['userDictionaries', 'scripts', 'presets', 'safeSettings'].map((id) => ({ id, label: '后端标签', description: '后端描述' }));
state.syncManifest = { overwrite: true, entries: [{ action: 'copy', relativePath: 'presets/default', sourceSize: 20 }] };
state.workflowRecipes = ['project-doctor', 'pronunciation-check', 'render-quality-check', 'project-probe', 'project-no-params'].map((id) => ({ id, title: '后端标题', description: '后端描述', supportsBatch: true }));
assert.deepEqual([...rendered('batch-recipes').querySelectorAll('option')].map((option) => option.value), state.workflowRecipes.map((recipe) => recipe.id));
assert.deepEqual([...rendered('selective-sync').querySelectorAll('[name=sync-category]')].map((input) => input.value), state.syncCategories.map((category) => category.id));
state.synthvProcesses = [{ processId: 123, name: 'SynthV' }, { processId: 456, name: 'SynthV' }];
state.tuningProfiles = [{ voiceName: 'Mai 2', sourceSamples: 4, outcomeSamples: 3, parameters: { loudness: 1, tension: 1, breathiness: 1, vibratoStrength: 1 } }];
state.mediaSourcePreview = { platform: 'youtube', title: 'Track', uploader: 'Creator', durationSeconds: 15, canonicalUrl: 'https://example.com' };
state.audioCaptureCapability = { supported: true };
state.audioCaptureTargets = [{ processId: 123, name: 'SynthV' }];
for (const status of ['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled']) {
  state.mediaTasks = ['cover', 'media-import', 'source-separation'].map((kind) => ({ kind, id: kind, status, detail: 'Task detail', progress: 40, result: { midi: { outputPath: 'output.mid' }, voiceAssignment: { requiresHostSelection: true }, requestedVoice: 'Mai 2', svpPath: 'project.svp', saveVerified: true, audioPath: 'audio.wav', vocalsPath: 'vocals.wav', instrumentalPath: 'inst.wav' } }));
  state.audioJob = { id: 'job', status, operation: 'loudness-normalize', progressPercent: 40, outputPath: 'result.wav', artifactId: 'artifact', loudnessReport: { integratedLufs: -16, truePeakDbtp: -1.5, loudnessRange: 11 } };
  for (const id of ['cover', 'media-import', 'source-separation', 'audio-preparation']) { rendered(id); renders++; }
}
state.audioProbe = { codec: 'PCM', container: 'WAV', durationSeconds: 4, channels: 2, sampleRate: 48000, bitDepth: 24, sourceArtifactId: 'source', sourceMimeType: 'audio/wav' };
state.audioLoudness = { integratedLufs: -16, truePeakDbtp: -1.5, loudnessRange: 11 };
for (const preview of ['', 'blob:preview']) { state.audioPreviewUrl = preview; state.audioSourcePreviewUrl = preview; rendered('audio-preparation'); }
for (const id of ['tuning-learning', 'ab-audition']) rendered(id);
assert.equal(rendered('audio-preparation').querySelector('#audio-prep-format').value, 's24');
assert.match(rendered('batch-recipes').querySelector('#batch-options').placeholder, /For example \{"suffix":"_delivery"\}/);
const audioToProject = rendered('audio-to-project');
assert.equal(audioToProject.querySelector('#pipeline-inst').required, false, 'Instrumental input is optional');
assert.equal(audioToProject.querySelector('[data-pick-pipeline-vocal]').tagName, 'BUTTON');
assert.equal(audioToProject.querySelector('[data-pick-pipeline-output-directory]').tagName, 'BUTTON');
assert.equal(audioToProject.querySelector('#pipeline-vocal').getAttribute('data-pipeline-drop-target'), 'vocal');
assert.equal(audioToProject.querySelector('#pipeline-vocal').readOnly, false, 'Vocal path remains pasteable');
assert.equal(audioToProject.querySelector('[data-clear-pipeline-instrumental]').disabled, true, 'Empty optional instrumental can be cleared safely');
assert.equal(state.sourceDirectory('/song.wav'), '/');
assert.equal(state.sourceDirectory('C:\\song.wav'), 'C:\\');
state.pendingAudioPlan = { kind: 'prepare', plan: { inputPath: 'C:/项目/<source>.wav', outputPath: 'output.wav', expiresAt: '2026-09-06T12:00:00Z', parameters: [], warnings: [] } };
const dialog = new JSDOM(state.renderAudioPlanDialog()).window.document;
assert.equal(dialog.querySelector('#audio-plan-title').textContent, 'Confirm: Generate PCM WAV');
assert.match(dialog.body.textContent, /C:\/项目\/<source>\.wav/);
assert.equal(dialog.querySelector('source'), null, 'User paths remain escaped');
for (const [fn, data] of [
 ['renderScalarResult', { duration_sec: 3, key_guess: 'C', peak_dbfs: -1, clipped_sample_ratio: 0.1, silent_frame_ratio: 0.1, brightness_trend: 'stable' }],
 ['renderAbAudioResult', { requestedStartSeconds: 0, requestedEndSeconds: 3, metrics: { durationSeconds: 3 } }],
 ['renderAbAudioResult', { correlation: 0.99, similarityPercent: 99, classification: 'near-identical' }],
 ['renderDiagnosticResult', { ok: true, issues: [], inspectedItems: 3 }],
 ['renderDiagnosticResult', { ok: false, issues: [{ severity: 'warning', message: '<raw diagnostic>' }], inspectedItems: 3 }],
 ['renderBatchResult', { completed: 1, failed: 1, items: [{ status: 'completed' }, { status: 'failed' }] }],
]) { const html = state[fn](data); assert.doesNotMatch(html, /\p{Script=Han}|workflowCopy\./u); }
for (const language of ['zh-CN', 'en']) {
  i18n.global.locale.value = language;
  const visit = (object, prefix = '') => Object.entries(object).forEach(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object') visit(value, path); else { const result = t(path, { count: 2, completed: 1, failed: 0, copied: 1, updated: 0, skipped: 0, conflicts: 0, voice: 'Mai', title: 'Title', file: 'file.wav', operation: 'PCM', references: 2, feedback: 1 }); assert.notEqual(result, path); }
  });
  visit(i18n.global.getLocaleMessage(language).workflowCopy, 'workflowCopy');
}
for (const language of ['en', 'zh-CN']) {
  i18n.global.locale.value = language;
  const document = new JSDOM(state.renderCopilot()).window.document;
  if (language === 'en') assert.doesNotMatch(document.body.textContent, /\p{Script=Han}/u);
  assert.equal(document.querySelector('[data-prompt]').dataset.prompt, t('copilot.audioPrompt'));
  assert.equal(document.querySelector('[data-open-ai-provider-picker]').getAttribute('aria-label'), t('copilot.chooseProviderModel', { provider: t('copilot.noProvider'), model: t('copilot.chooseModel') }));
  assert.deepEqual([...document.querySelectorAll('[data-agent-work-mode]')].map((button) => button.dataset.agentWorkMode), ['edit', 'solo']);
}
i18n.global.locale.value = 'en';
state.activeAiProvider = () => ({ displayName: 'Provider <name>', model: 'Model <id>', accounts: [{ authorized: true }], apiKeys: [] });
state.conversation = { id: 'chat', title: '原始标题 <title>', messages: [{ role: 'user', content: '原始内容 <script>hello</script>' }, { role: 'assistant', content: 'Original answer' }] };
state.conversations = [{ id: 'chat', title: state.conversation.title, messageCount: 2, updatedAt: '2026-09-06' }];
const chat = new JSDOM(state.renderCopilot()).window.document;
assert.equal(chat.querySelector('.chat-title strong').textContent, state.conversation.title);
assert.equal(chat.querySelector('.message.user p').textContent, state.conversation.messages[0].content);
assert.equal(chat.querySelector('.message.user small').textContent, 'You');
assert.equal(chat.querySelector('.session-item small').textContent, '2 messages · 2026-09-06');
assert.equal(chat.querySelector('script'), null);
assert.match(chat.querySelector('[data-open-ai-provider-picker]').getAttribute('aria-label'), /Provider <name> Model <id>/);
console.log(`Workflow and Copilot localization behavior passed (${renders} workflow branch renders, populated states, dictionaries, option values, and escaped data).`);

