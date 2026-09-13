import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire, stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync(new URL('../src/PiDesktop.Tauri/src/main.ts', import.meta.url), 'utf8');
const start = source.indexOf('function renderAccounts(');
const end = source.indexOf('function renderSv2InstanceList(', start);
assert.notEqual(start, -1, 'account renderer exists');
assert.notEqual(end, -1, 'account renderer has a boundary');
const renderer = stripTypeScriptTypes(source.slice(start, end));
const { JSDOM } = createRequire(new URL('../src/PiDesktop.Tauri/package.json', import.meta.url))('jsdom');

const slot = concurrent => ({
  id: 'slot', displayName: 'Account', color: '#abcdef', isActive: true,
  lastActivatedAtUtc: undefined, accountProbe: {}, concurrentAccountProbe: {},
  concurrent, installedVoiceIds: [],
});

function render(concurrent, { providerAvailable = true, concurrentEnabled = true, windowsExtensions = true } = {}) {
  const context = vm.createContext({
    profiles: {
      supported: true, slots: [slot(concurrent)], blockers: [],
      concurrentProvider: { available: providerAvailable, detail: 'Provider ready' },
    },
    app: { platform: 'windows', sv2ConcurrentEnabled: concurrentEnabled },
    cachedAccountProfiles: null,
    supportsWindowsSv2Extensions: () => windowsExtensions,
    accountUseStateForSlot: () => ({ tone: 'unknown', label: 'Unknown' }),
    accountUseDot: () => '', accountProbeBadge: () => '', officialAuthorizationBadge: () => '', officialAccountIdentity: () => ({}),
    renderSv2InstanceList: () => '',
    icon: () => '<svg></svg>',
    escapeHtml: value => String(value),
    locale: () => 'en-US',
    t: key => key,
  });
  vm.runInContext(renderer, context);
  return new JSDOM(context.renderAccounts()).window.document;
}

let document = render({ ready: true, dataPath: 'C:\\slot', runningPids: [], detail: '', content: {} });
const actions = document.querySelector('.account-launch-actions');
assert.equal(actions.children[0].dataset.profileLaunch, 'slot', 'normal launch is always the first action');
assert.equal(actions.children[0].disabled, false, 'normal launch is not disabled by isolation availability');
assert.equal(actions.children[1].dataset.profileConcurrentLaunch, 'slot', 'ready isolation remains a secondary action');

document = render({ ready: true, dataPath: 'C:\\slot', runningPids: [], detail: '', content: {} }, { providerAvailable: false });
const unavailableActions = document.querySelector('.account-launch-actions');
assert.equal(unavailableActions.children[0].disabled, false, 'normal launch remains enabled when isolation is unavailable');
assert.equal(unavailableActions.children[1].disabled, true, 'only the unavailable isolation action is disabled');

document = render({ ready: false, dataPath: '', runningPids: [], detail: 'Loading', content: {} });
const loadingActions = document.querySelector('.account-launch-actions');
assert.equal(loadingActions.children[0].dataset.profileLaunch, 'slot', 'normal launch remains available while isolation state loads');
assert.equal(loadingActions.children[0].disabled, false);
assert.equal(loadingActions.children[1].getAttribute('role'), 'status', 'isolation loading is announced as status');
assert.match(loadingActions.children[1].textContent, /readingIsolationState/);
assert.equal(loadingActions.querySelector('[data-profile-concurrent-launch], [data-profile-concurrent-prepare]'), null, 'loading isolation state does not expose an actionable isolation control');

document = render({ ready: false, dataPath: 'C:\\slot', runningPids: [], detail: '', content: {} });
const preparationActions = document.querySelector('.account-launch-actions');
assert.equal(preparationActions.children[0].dataset.profileLaunch, 'slot');
assert.equal(preparationActions.children[1].dataset.profileConcurrentPrepare, 'slot', 'completed isolation state exposes preparation after normal launch');

document = render({ ready: true, dataPath: 'C:\\slot', runningPids: [], detail: '', content: {} }, { windowsExtensions: false });
const standardActions = document.querySelector('.account-launch-actions');
assert.equal(standardActions.children.length, 1, 'platforms without isolation retain the normal launch control only');
assert.equal(standardActions.children[0].dataset.profileLaunch, 'slot');
console.log('Account launch action order and isolation loading behavior passed.');
