import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rust = join(root, "src", "PiDesktop.Tauri", "src-tauri", "src");
const read = (path) => readFileSync(path, "utf8");
const unified = read(join(rust, "synthv_unified.rs"));
const manager = read(join(rust, "mcp.rs"));
const agent = read(join(rust, "audio_capture.rs"));
const bundle = JSON.parse(read(join(root, "src", "PiDesktop.Tauri", "src-tauri", "tauri.conf.json")));

for (const tool of [
  "synthv_hosts",
  "synthv_connect",
  "synthv_disconnect",
  "synthv_capabilities",
  "synthv_read",
  "synthv_write",
  "synthv_export",
]) {
  assert.match(unified, new RegExp(`"${tool}"`));
}

assert.match(agent, /tools\.extend\(synthv_unified::definitions\(\)\)/);
assert.match(agent, /synthv_unified::is_mutation/);
assert.match(manager, /filter\(\|\(id, _\)\| !id\.starts_with\("synthv"\)\)/);
assert.match(manager, /connect_http/);
assert.match(unified, /HostKind::OfficialSv1/);
assert.match(unified, /HostKind::Flat/);
assert.match(unified, /HostKind::OfficialSv2/);
assert.match(unified, /writeIntent/);
assert.match(unified, /normalize_sv2/);
assert.match(unified, /normalize_direct/);
assert.match(unified, /BridgeShortcutAction::Start/);
assert.match(unified, /BridgeShortcutAction::Stop/);
assert.match(unified, /capture_playback/);
assert.match(unified, /synthv-snapshots/);
assert.doesNotMatch(unified, /http:\/\/0\.0\.0\.0/);
assert.equal(
  bundle.bundle.resources["../../../external/synthv-agent-bridge/legacy-sv1"],
  "synthv-agent-bridge/legacy-sv1",
);

console.log("Unified SynthV Agent contracts passed.");
