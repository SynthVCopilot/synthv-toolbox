import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { instanceAccount } from '../src/PiDesktop.Tauri/src/sv2Instances.ts';

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
const list = { innerHTML: 'old rows' };
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
console.log('Concurrent instance mapping and refresh behaviors passed.');
