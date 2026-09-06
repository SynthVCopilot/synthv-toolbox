import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const read = relative => fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const synthv = read('../src/PiDesktop.Tauri/src-tauri/src/synthv.rs');
const commands = read('../src/PiDesktop.Tauri/src-tauri/src/commands.rs');
const main = read('../src/PiDesktop.Tauri/src/main.ts');
const modernBridge = read('../src/PiDesktop.Tauri/src-tauri/components/synthv-agent-bridge/synthv/SynthVAgentBridge.lua');
const stopBridge = read('../src/PiDesktop.Tauri/src-tauri/components/synthv-agent-bridge/synthv/StopSynthVAgentBridge.lua');
const sidebar = read('../src/PiDesktop.Tauri/src-tauri/components/synthv-agent-bridge/synthv/SynthVAgentSidebar.lua');
const legacyBridge = read('../src/PiDesktop.Tauri/src-tauri/components/synthv-agent-bridge/legacy-sv1/synthv/SynthVAgentBridgeSV1Legacy.lua');

assert.match(synthv, /synthesizer v studio flat/);
assert.doesNotMatch(synthv, /name\.contains\("synthesizer v"\)/);
assert.match(synthv, /BridgeProfile::Sv1 => run_bridge_script/);
assert.match(synthv, /BridgeProfile::Flat => install_bridge/);
assert.match(synthv, /unique_bridge_targets/);
assert.match(synthv, /directory\.join\("SynthV Agent Bridge SV1 Legacy\/SynthVAgentBridgeSV1Legacy\.lua"\)/);
assert.match(synthv, /directory\.join\("SynthV Agent Bridge"\)/);
assert.match(synthv, /BRIDGE_VERSION = \\\"\{COMPONENT_VERSION\}\\\"/);
assert.match(synthv, /SIDEBAR_VERSION = \\\"\{COMPONENT_VERSION\}\\\"/);
assert.match(modernBridge, /BRIDGE_VERSION = "0\.3\.1"/);
assert.match(modernBridge, /PROTOCOL_VERSION = 3/);
assert.match(stopBridge, /BRIDGE_NAME = "SynthV Agent Bridge"/);
assert.match(sidebar, /SIDEBAR_VERSION = "0\.3\.1"/);
assert.match(legacyBridge, /SCRIPT_NAME = "SynthV Agent Bridge SV1 Legacy"/);
assert.match(legacyBridge, /PROTOCOL_VERSION = 1/);
assert.match(commands, /targets: Vec<BridgeTarget>/);
assert.match(main, /data-bridge-batch/);
assert.match(main, /data-bridge-target/);
assert.match(main, /const instanceRefreshInterval = 3000/);
assert.doesNotMatch(main, /data-refresh-synthv-processes/);

const targetStart = main.indexOf('function bridgeTargetKey(');
const targetEnd = main.indexOf('function bridgeProfileLabel(', targetStart);
const batchStart = main.indexOf('async function runBridgeTargets(');
const batchEnd = main.indexOf('function renderBridge(', batchStart);
let refreshes = 0;
const context = vm.createContext({
  app: { platform: 'windows' },
  Map,
  bridgeTargetResults: new Map(),
  t: (key, params) => `${key}:${JSON.stringify(params ?? {})}`,
  refresh: async () => { refreshes += 1; },
  api: {
    installBridge: async targets => [
      { scriptsPath: targets[0].scriptsPath, bridgeProfile: targets[0].bridgeProfile, result: { succeeded: false } },
      { scriptsPath: targets[1].scriptsPath, bridgeProfile: targets[1].bridgeProfile, result: { succeeded: true } },
    ],
    diagnoseBridge: async () => [],
  },
});
vm.runInContext(stripTypeScriptTypes(main.slice(targetStart, targetEnd) + main.slice(batchStart, batchEnd)), context);
const targets = context.bridgeTargets([
  { scriptsPath: 'C:\\Scripts', bridgeProfile: 'sv1' },
  { scriptsPath: 'c:/scripts', bridgeProfile: 'flat' },
  { scriptsPath: 'C:/Scripts', bridgeProfile: 'sv2' },
]);
assert.equal(targets.length, 2, 'SV1 and modern installers retain the same directory as distinct targets');
assert.equal(targets.filter(target => target.bridgeProfile === 'sv1').length, 1);
assert.equal(targets.filter(target => target.bridgeProfile === 'flat').length, 1, 'Flat and SV2 share the modern installer target');
await context.runBridgeTargets('install', targets);
assert.equal(context.bridgeTargetResults.size, 2, 'a failed target does not prevent a later target result');
assert.equal(refreshes, 1);
context.app.platform = 'macos';
assert.notEqual(context.bridgeTargetKey('/Users/Test/Scripts', 'sv1'), context.bridgeTargetKey('/Users/Test/scripts', 'sv1'));

console.log('Bridge installation management contracts passed.');
