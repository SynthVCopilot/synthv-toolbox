import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rustRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src-tauri", "src");
const webRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src");
const read = (path) => readFileSync(path, "utf8");

const control = read(join(rustRoot, "synthv_control.rs"));
const commands = read(join(rustRoot, "commands.rs"));
const library = read(join(rustRoot, "lib.rs"));
const agent = read(join(rustRoot, "audio_capture.rs"));
const api = read(join(webRoot, "api.ts"));
const main = read(join(webRoot, "main.ts"));

assert.match(control, /BRIDGE_START_KEY: &str = "F13"/);
assert.match(control, /BRIDGE_STOP_KEY: &str = "F14"/);
assert.match(control, /list_processes/);
assert.match(control, /start_bridge_and_connect/);
assert.match(control, /System Events/);
assert.match(control, /SendInput/);
assert.match(commands, /auto_connect_synthv_bridge/);
assert.match(library, /commands::auto_connect_synthv_bridge/);
assert.doesNotMatch(agent, /name: "list_synthv_processes"/);
assert.doesNotMatch(agent, /name: "read_synthv_bridge_shortcuts"/);
assert.doesNotMatch(agent, /name: "send_synthv_bridge_shortcut"/);
assert.doesNotMatch(agent, /name: "auto_connect_synthv_bridge"/);
assert.match(api, /autoConnectSynthvBridge/);
assert.match(main, /data-auto-connect-synthv/);
assert.match(main, /data-send-synthv-stop/);

console.log("SynthV Bridge control contracts passed.");
