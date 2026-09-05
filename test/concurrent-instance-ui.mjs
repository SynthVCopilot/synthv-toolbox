import assert from 'node:assert/strict';
import './instance-title.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { stripTypeScriptTypes } from 'node:module';
import { instanceAccount, instanceProjectTitle } from '../src/PiDesktop.Tauri/src/sv2Instances.ts';
const { JSDOM } = createRequire(new URL('../src/PiDesktop.Tauri/package.json', import.meta.url))('jsdom');

const slot = (id, pids) => ({ id, displayName: id, concurrent: { runningPids: pids } });
const profiles = { activeSlotId: 'first', slots: [slot('first', [10, 11]), slot('second', [20])] };
const process = (pid, isSv2 = true, sandboxed = true) => ({ processId: pid, isSv2, sandboxed });
assert.equal(instanceAccount(process(10), profiles).slot.id, 'first');
assert.equal(instanceAccount(process(11), profiles).slot.id, 'first');
profiles.activeSlotId = 'second';
assert.equal(instanceAccount(process(10), profiles).slot.id, 'first');
assert.equal(instanceAccount(process(30, true, false), profiles).slot.id, 'second');
for (const item of [process(99), process(99, true, null), process(99, false, false)]) {
  assert.equal(instanceAccount(item, profiles).slot, undefined);
}
profiles.slots[1].concurrent.runningPids.push(10);
assert.equal(instanceAccount(process(10), profiles).slot, undefined);

const source = fs.readFileSync(new URL('../src/PiDesktop.Tauri/src/main.ts', import.meta.url), 'utf8');
const start = source.indexOf('async function refreshVisibleSynthvInstances(');
const end = source.indexOf('function scheduleDownloadPoll', start);
const poll = stripTypeScriptTypes(source.slice(start, end));
let resolveProcesses;
let resolveProfiles;
let calls = 0;
const list = new JSDOM('<div id="instances">old rows</div>').window.document.querySelector('#instances');
const context = vm.createContext({
  busy: false, page: 'accounts', instanceRefreshInFlight: false, instanceRefreshGeneration: 0,
  synthvProcesses: [{ processId: 30 }], profiles: { activeSlotId: 'first' },
  document: { hidden: false, querySelector: () => list },
  api: {
    listSynthvProcesses() { calls++; return new Promise(resolve => { resolveProcesses = resolve; }); },
    sv2ProfileState() { return new Promise(resolve => { resolveProfiles = resolve; }); },
  },
});
vm.runInContext('function renderSv2InstanceRows() { return profiles.activeSlotId; } function renderBridgeProcessRows() { return JSON.stringify(synthvProcesses); }' + poll, context);
let request = context.refreshVisibleSynthvInstances();
await context.refreshVisibleSynthvInstances();
assert.equal(calls, 1);
resolveProcesses([{ processId: 30 }]); resolveProfiles({ activeSlotId: 'second' }); await request;
assert.equal(list.innerHTML, 'second', 'account changes update rows even when PIDs do not change');
request = context.refreshVisibleSynthvInstances();
context.instanceRefreshGeneration++;
resolveProcesses([{ processId: 99 }]); resolveProfiles({ activeSlotId: 'stale' }); await request;
assert.equal(list.innerHTML, 'second');
assert.equal(context.synthvProcesses[0].processId, 30);
context.document.hidden = true;
await context.refreshVisibleSynthvInstances();
assert.equal(calls, 2);

context.document.hidden = false;
list.innerHTML = '<article class="synthv-process-row" data-process-id="30"><details open><summary>详情</summary></details></article>';
vm.runInContext('function renderSv2InstanceRows() { return `<article class="synthv-process-row" data-process-id="30"><details><summary>详情</summary></details></article>`; }', context);
request = context.refreshVisibleSynthvInstances();
resolveProcesses([{ processId: 30 }]); resolveProfiles({ activeSlotId: 'second' }); await request;
assert.equal(list.querySelector('details').open, true, 'polling preserves expanded instance details');

const renderStart = source.indexOf('function renderSv2InstanceRows(');
const renderEnd = source.indexOf('function supportsWindowsSv2Extensions', renderStart);
const sample = {
  processId: 55, processIdentity: 'windows:55:unique', productName: 'SVStudio2 Pro', version: '2.3.0',
  name: 'synthv-studio.exe', command: 'C:\\Fixture\\Synthesizer V Studio 2 Pro\\synthv-studio.exe',
  windowTitle: 'Example.svp - Synthesizer V Studio 2 Pro', isSv2: true, sandboxed: false,
};
const renderContext = vm.createContext({
  busy: false, synthvProcesses: [sample], profiles: { activeSlotId: 'sample', slots: [slot('sample', [])] },
  instanceAccount, instanceProjectTitle,
  escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
});
vm.runInContext(stripTypeScriptTypes(source.slice(renderStart, renderEnd)), renderContext);
const rows = () => new JSDOM(renderContext.renderSv2InstanceRows()).window.document;
let rendered = rows();
assert.equal(rendered.querySelector('strong').textContent, 'SVStudio2 Pro 2.3.0 · sample · Example.svp');
assert.equal(rendered.querySelector('details').open, false);
assert.equal(rendered.querySelector('details code').textContent, sample.command);
assert.equal(rendered.querySelector('[data-focus-sv2]').disabled, false);
assert.equal(rendered.querySelector('[data-terminate-sv2]').dataset.processIdentity, sample.processIdentity);
renderContext.busy = true;
assert.equal(rows().querySelector('[data-focus-sv2]').disabled, true);
renderContext.busy = false;
renderContext.synthvProcesses = [{ ...sample, processIdentity: '' }];
assert.equal(rows().querySelector('[data-terminate-sv2]').disabled, true);
console.log('Concurrent instance mapping and refresh behaviors passed.');
