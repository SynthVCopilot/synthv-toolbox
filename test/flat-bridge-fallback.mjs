import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rust = join(root, "src", "PiDesktop.Tauri", "src-tauri", "src");
const unified = readFileSync(join(rust, "synthv_unified.rs"), "utf8");
const manager = readFileSync(join(rust, "mcp.rs"), "utf8");
const control = readFileSync(join(rust, "synthv_control.rs"), "utf8");

assert.match(unified, /prefer_native_flat/);
assert.match(unified, /connect_http/);
assert.match(unified, /connect_legacy_bridge/);
assert.match(unified, /SynthVConnectionProfile::NativeFlat/);
assert.match(unified, /SynthVConnectionProfile::LegacyBridge/);
assert.match(unified, /legacy_write_arguments/);
assert.match(unified, /writeIntent/);
assert.match(unified, /flat_fallback_scripts_directory/);
assert.match(unified, /reserve_legacy_synthv_host/);
assert.match(manager, /pub enum SynthVConnectionProfile/);
assert.match(manager, /synthv_connection_profile/);
assert.match(control, /is_flat_executable_name/);
assert.match(control, /"synthesizer v flat\.exe"/);
assert.match(control, /"synthesizer-v-flat\.exe"/);
assert.match(control, /BridgeShortcutAction::StartLegacy/);
assert.doesNotMatch(control, /contains\("flat"\)/);

console.log("Flat Bridge fallback contracts passed.");
