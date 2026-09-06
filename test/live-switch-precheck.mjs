import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync(new URL('../src/PiDesktop.Tauri/src/main.ts', import.meta.url), 'utf8');
const start = source.indexOf('async function launchSv2ProfileAfterLiveCheck(');
const end = source.indexOf('async function prepareConcurrentSlotsWhenEnabled(', start);
assert.notEqual(start, -1, 'live switch precheck helper exists');
assert.notEqual(end, -1, 'live switch precheck helper has a boundary');
const helper = stripTypeScriptTypes(source.slice(start, end));

const state = (activeSlotId, blockers = []) => ({ activeSlotId, blockers, slots: [] });

function createContext(states) {
  const launches = [];
  let profileStateCalls = 0;
  const context = vm.createContext({
    profiles: state('old', [{ name: 'stale' }]),
    pendingBlockedSwitchSlot: undefined,
    setFeedback: () => {},
    api: {
      sv2ProfileState: async () => {
        const next = states[profileStateCalls++];
        if (next instanceof Error) throw next;
        return next;
      },
      launchSv2Profile: async (slotId) => {
        launches.push(slotId);
        return { succeeded: true };
      },
      sv2AccountPrecheck: () => { throw new Error('account precheck must not run'); },
    },
  });
  vm.runInContext(helper, context);
  return { context, launches, profileStateCalls: () => profileStateCalls };
}

let fixture = createContext([state('old', []), state('target', [])]);
await fixture.context.launchSv2ProfileAfterLiveCheck('target');
assert.deepEqual(fixture.launches, ['target'], 'a stale blocker does not prevent launch after it closes');
assert.equal(fixture.context.pendingBlockedSwitchSlot, undefined);

fixture = createContext([state('old', [{ name: 'new process' }])]);
fixture.context.profiles = state('old', []);
await fixture.context.launchSv2ProfileAfterLiveCheck('target');
assert.deepEqual(fixture.launches, [], 'a newly detected blocker prevents launch');
assert.equal(fixture.context.pendingBlockedSwitchSlot, 'target');
assert.equal(fixture.profileStateCalls(), 1);

fixture = createContext([state('target', [{ name: 'same slot process' }]), state('target', [])]);
await fixture.context.launchSv2ProfileAfterLiveCheck('target');
assert.deepEqual(fixture.launches, ['target'], 'the active target slot can launch another normal instance');

fixture = createContext([new Error('process check unavailable')]);
await assert.rejects(() => fixture.context.launchSv2ProfileAfterLiveCheck('target'), /process check unavailable/);
assert.deepEqual(fixture.launches, [], 'launch is skipped when the live check fails');

console.log('Live switch precheck behaviors passed.');
