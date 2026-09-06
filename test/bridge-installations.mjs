import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = relative => fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const synthv = read('../src/PiDesktop.Tauri/src-tauri/src/synthv.rs');
const commands = read('../src/PiDesktop.Tauri/src-tauri/src/commands.rs');
const main = read('../src/PiDesktop.Tauri/src/main.ts');

assert.match(synthv, /synthesizer v studio flat/);
assert.doesNotMatch(synthv, /name\.contains\("synthesizer v"\)/);
assert.match(synthv, /BridgeProfile::Sv1 => run_bridge_script/);
assert.match(synthv, /BridgeProfile::Flat => install_bridge/);
assert.match(synthv, /unique_bridge_targets/);
assert.match(synthv, /SynthVAgentBridge\.lua", "StopSynthVAgentBridge\.lua", "SynthVAgentSidebar\.lua/);
assert.match(commands, /targets: Vec<BridgeTarget>/);
assert.match(main, /data-bridge-batch/);
assert.match(main, /data-bridge-target/);
assert.match(main, /const instanceRefreshInterval = 3000/);
assert.doesNotMatch(main, /data-refresh-synthv-processes/);

console.log('Bridge installation management contracts passed.');
