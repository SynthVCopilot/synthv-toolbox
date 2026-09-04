import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(path, "utf8");
const bridgeScript = read(join(root, "src", "PiDesktop.Tauri", "scripts", "ensure-bridge.mjs"));
const downloads = read(join(root, "src", "PiDesktop.Tauri", "src-tauri", "src", "downloads.rs"));
const workflows = read(join(root, "src", "PiDesktop.Tauri", "src-tauri", "src", "workflows.rs"));
const mediaTasks = read(join(root, "src", "PiDesktop.Tauri", "src-tauri", "src", "media_tasks.rs"));
const synthvControl = read(join(root, "src", "PiDesktop.Tauri", "src-tauri", "src", "synthv_control.rs"));
const synthvHosts = read(join(root, "src", "PiDesktop.Tauri", "src-tauri", "src", "synthv_hosts.rs"));

assert.match(bridgeScript, /dist\/src\/cli\.js/);
assert.match(bridgeScript, /dist\/legacy-sv1\/src\/cli\.js/);
assert.match(bridgeScript, /process\.env\.CI === "true" && bridgeEntries\.every/);
assert.match(bridgeScript, /node_modules\/typescript\/bin\/tsc/);
assert.match(bridgeScript, /node_modules\/@types\/node\/package\.json/);
assert.match(bridgeScript, /!buildDependencies\.every\(\(entry\) => existsSync\(entry\)\)/);
assert.match(bridgeScript, /run\(\["ci", "--include=dev", "--no-audit", "--no-fund"\]\)/);
assert.doesNotMatch(bridgeScript, /if \(!existsSync\(resolve\(componentDirectory, "node_modules"\)\)\)/);
assert.match(downloads, /if let Some\(item\) = queue\.items\.iter_mut\(\)\.find/);
assert.doesNotMatch(downloads, /\.map\(\|item\| \*item = previous\)/);
assert.match(workflows, /pub struct GameToMidiRequest/);
assert.match(workflows, /pub async fn game_to_midi_cancellable\(\s*request: GameToMidiRequest,/s);
assert.match(mediaTasks, /workflows::game_to_midi_cancellable\(workflows::GameToMidiRequest/);
assert.match(synthvControl, /use windows_sys::core::BOOL;/);
assert.match(synthvControl, /use windows_sys::Win32::Foundation::\{HWND, LPARAM\};/);
assert.match(synthvControl, /unsafe extern "system" fn find_visible_window\(hwnd: HWND,/);
assert.doesNotMatch(synthvControl, /Foundation::\{BOOL, LPARAM\}/);
assert.match(synthvHosts, /use std::os::windows::fs::MetadataExt;/);
assert.match(synthvHosts, /metadata\.file_attributes\(\) & FILE_ATTRIBUTE_REPARSE_POINT != 0/);
assert.doesNotMatch(synthvHosts, /FileTypeExt|is_reparse_point\(\)/);

console.log("Actions build fix contracts passed.");
