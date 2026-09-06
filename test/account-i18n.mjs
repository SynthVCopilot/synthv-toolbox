import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire, stripTypeScriptTypes } from 'node:module';
const require = createRequire(new URL('../src/PiDesktop.Tauri/package.json', import.meta.url));
const { createI18n } = require('vue-i18n');
const { parse } = require('@babel/parser');
const read = name => fs.readFileSync(new URL(`../src/PiDesktop.Tauri/src/${name}`, import.meta.url), 'utf8');
const source = read('main.ts');
const names = new Set(['renderConcurrentDisclaimer', 'renderAccountIndicatorConsent', 'renderProfileDeletionDialog', 'renderBlockedSwitchDialog', 'renderSvpRouteDialog', 'renderSvpRouteCandidate', 'accountProbeSessionLabel', 'accountProbeIssueRules', 'accountProbeIssue', 'accountProbeEnvironments', 'accountProbeEnvironmentSummary', 'environmentDefinitelyUnavailable', 'accountProbeBadge', 'officialAuthorizationBadge', 'accountProbeIdentity', 'officialAccountIdentity', 'accountUseStateForSlot', 'accountUseDot', 'renderAccounts', 'renderAuthorizedVoice', 'renderAccountManager', 'renderToolboxUpdateResult', 'aiConnectionSummary', 'fallbackAiProviders', 'aiProviders', 'activeAiProvider', 'isActiveAiProvider', 'aiProviderDisplayName', 'supportsWindowsSv2Extensions', 'renderAiProviderSettings', 'renderSettings']);
const functions = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program.body.filter(node => node.type === 'FunctionDeclaration' && names.has(node.id.name));
assert.equal(functions.length, names.size);
for (const fn of functions) assert.doesNotMatch(source.slice(fn.start, fn.end), /[\u4e00-\u9fff]/u, `${fn.id.name} contains untranslated UI text`);
const context = vm.createContext({ createI18n, document: { documentElement: {} }, localStorage: { getItem: () => null, setItem() {} }, icon: () => '<svg></svg>', escapeHtml: value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]), cachedAccountProfiles: null, renderSv2InstanceList: () => '', resultMetric: (name, value) => `${name}: ${value}`, findVoiceMetadata: () => undefined, sv2VoiceCatalog: [], busy: false });
const evaluate = value => vm.runInContext(value, context);
const stripModule = value => stripTypeScriptTypes(value.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), { mode: 'transform' });
evaluate(stripModule(read('i18n.ts')));
evaluate(stripModule(read('i18nAccounts.ts')));
evaluate(stripModule(read('accountStatus.ts')));
evaluate(stripTypeScriptTypes(functions.map(fn => source.slice(fn.start, fn.end)).join('\n'), { mode: 'transform' }));
const zhKeys = evaluate('Object.keys(i18n.global.getLocaleMessage("zh-CN").accountUi).sort().join("|")');
assert.equal(zhKeys, evaluate('Object.keys(i18n.global.getLocaleMessage("en").accountUi).sort().join("|")'));
const calls = [...source.matchAll(/"(account(?:Ui|Notice)\.[^"]+)"/g)].map(match => match[1]);
for (const lang of ['en', 'zh-CN']) {
  evaluate(`setLocale(${JSON.stringify(lang)})`);
  for (const key of calls) assert.equal(evaluate(`i18n.global.te(${JSON.stringify(key)})`), true, key);
}
evaluate('setLocale("en")');
assert.equal(evaluate('t("accountNotice.globalSavedPrepared", { count: 3 })'), 'Global settings saved. Isolated environments prepared automatically: 3.');
assert.match(evaluate('t("settings.aiDisabledDescription")'), /own local MCP service remains available/);
assert.match(source, /error = probe\.detail \|\| t\("accountNotice\.authorizationUnknown"\)/);
const hostile = '<img src=x onerror=alert(1)> & "name"';
const probe = { sessionStatus: 'ready', remoteUse: 'clear', authorizationStatus: 'verified', authorizedVoiceCount: 2, authorizedVoices: [], authorizedVoiceProducts: [], accountDisplayName: hostile, accountEmail: hostile, detail: '原始诊断', };
const slot = { id: 'slot', displayName: hostile, color: '#123456', sessionCached: true, isActive: true, dataPath: hostile, accountProbe: probe, concurrentAccountProbe: { ...probe }, concurrent: { ready: true, runningPids: [21] }, sessionProtection: { status: 'ready' }, concurrentSessionProtection: { status: 'ready' }, installedVoiceIds: [] };
context.profiles = { supported: true, slots: [slot], blockers: [{ name: hostile, reason: '原始诊断', pid: 33 }], concurrentProvider: { available: true, name: hostile, detail: '原始诊断' }, canImportCurrent: true };
context.app = { platform: 'windows', sv2AccountIndicatorEnabled: true, sv2ConcurrentEnabled: true, mode: 'toolbox', svpAssociation: { supported: true, detail: '原始诊断' }, appVersion: '1.0', configPath: hostile };
context.pendingConcurrentLaunchSlot = 'slot';
context.pendingBlockedSwitchSlot = 'slot';
context.pendingProfileDeletionId = 'slot';
context.managedProfileSlotId = 'slot';
context.toolboxUpdate = null;
context.pendingSvpRoute = { projectPath: hostile, requiredVoices: [{ name: hostile }], candidates: [{ slotId: 'slot', displayName: hostile, idle: true, remoteUse: 'clear', sessionStatus: 'ready', launchMode: 'concurrent', authorizationSource: 'session', exactAuthorizationMatch: true, matchedVoices: [hostile], missingOrUnknownVoices: [], reason: '原始诊断' }], summary: '原始诊断', detail: hostile, requiresConfirmation: true };
const renderers = ['renderConcurrentDisclaimer', 'renderAccountIndicatorConsent', 'renderProfileDeletionDialog', 'renderBlockedSwitchDialog', 'renderSvpRouteDialog', 'renderAccounts', 'renderSettings'];
for (const lang of ['en', 'zh-CN', 'en']) {
  evaluate(`setLocale(${JSON.stringify(lang)})`);
  const status = evaluate('accountProbeIssue([{sessionStatus:"offline"}]).cardLabel');
  assert.equal(status, lang === 'en' ? 'Account service temporarily offline' : '账号服务暂时离线');
  assert.equal(evaluate('accountProbeSessionLabel("ready")'), lang === 'en' ? 'Cached session available' : '缓存会话可用');
  for (const renderer of renderers) {
    const html = evaluate(`${renderer}()`);
    assert.doesNotMatch(html, /<img src=x|accountUi\./, renderer);
  }
  for (const section of ['profile', 'global', 'add']) {
    context.accountManagerSection = section;
    const html = evaluate('renderAccountManager()');
    assert.doesNotMatch(html, /<img src=x|accountUi\./);
    if (lang === 'en') assert.doesNotMatch(html, /[\u4e00-\u9fff]/);
  }
}
assert.match(evaluate('renderBlockedSwitchDialog()'), /&lt;img/);
assert.match(evaluate('renderSvpRouteDialog()'), /原始诊断/);
assert.match(evaluate('renderSvpRouteDialog()'), /matches all required voices/);
context.app.platform = 'macos';
assert.match(evaluate('renderBlockedSwitchDialog()'), /macOS v1 does not terminate processes/);
context.accountManagerSection = 'global';
assert.match(evaluate('renderAccountManager()'), /sequential data-slot switching/);
context.toolboxUpdate = { latestVersion: '2.0', currentVersion: '1.0', updateAvailable: true, releaseName: hostile, releaseNotes: '原始发布说明 ' + hostile, checkedAtUtc: '2026-09-06T12:00:00Z' };
const updateHtml = evaluate('renderToolboxUpdateResult()');
assert.match(updateHtml, /Update available/);
assert.match(updateHtml, /原始发布说明/);
assert.doesNotMatch(updateHtml, /<img src=x/);
const header = read('vue/components/PageHeader.vue');
assert.match(header, /useI18n/);
assert.doesNotMatch(header, /[\u4e00-\u9fff]/);
console.log('Account and settings translations switch live, cover bounded UI, and preserve escaping and backend diagnostics.');
