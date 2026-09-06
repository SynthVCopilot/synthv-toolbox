import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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

console.log('Bridge installation management contracts passed.');
