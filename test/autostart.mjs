import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const main = fs.readFileSync(path.join(root, "src/PiDesktop.Tauri/src/main.ts"), "utf8");
const api = fs.readFileSync(path.join(root, "src/PiDesktop.Tauri/src/api.ts"), "utf8");
const lib = fs.readFileSync(path.join(root, "src/PiDesktop.Tauri/src-tauri/src/lib.rs"), "utf8");
const commands = fs.readFileSync(path.join(root, "src/PiDesktop.Tauri/src-tauri/src/commands.rs"), "utf8");

assert.match(main, /api\.getAutostart\(\)/);
assert.match(main, /app\.autostartEnabled == null/);
assert.match(main, /api\.setAutostart\(enabled\)/);
assert.match(main, /autostartError/);
assert.match(api, /set_autostart/);
assert.match(api, /get_autostart/);
assert.match(lib, /arg == "--autostart"/);
assert.match(lib, /else if autostart_launch/);
assert.match(lib, /if args\.iter\(\)\.any\(\|arg\| arg == "--autostart"\)/);
assert.match(commands, /pub fn get_autostart/);
assert.match(lib, /MacosLauncher/);

console.log("autostart UI, fresh-status, and hidden-startup guards are covered");
