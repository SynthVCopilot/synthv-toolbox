import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (filename) => readFileSync(join(root, filename), "utf8").replace(/\r\n/g, "\n");
const updater = read("src/PiDesktop.Tauri/electron/updater.ts");
const builder = read("electron-builder.yml");

assert.match(updater, /from "electron-updater"/);
assert.match(updater, /client\.autoDownload = true/);
assert.match(updater, /client\.autoInstallOnAppQuit = true/);
assert.match(updater, /checkForUpdates\(\)/);
assert.match(updater, /update-available/);
assert.match(updater, /download-progress/);
assert.match(updater, /update-downloaded[\s\S]*quitAndInstall\(false, true\)/);
assert.match(updater, /phase: "error"/);

assert.match(builder, /^asar: true$/m);
assert.match(builder, /^asarUnpack:$/m);
assert.match(builder, /\*\*\/\*\.node/);
assert.match(builder, /^  - dist\/\*\*\/\*$/m);
assert.doesNotMatch(builder, /electron\/dist|packages\/agent-runtime\/node_modules|resources\/node/);
assert.match(builder, /^win:[\s\S]*^  target:[\s\S]*^    - nsis$/m);
assert.match(builder, /^mac:[\s\S]*^  target:[\s\S]*^    - dmg$/m);
assert.match(builder, /hardenedRuntime: true/);
assert.match(builder, /identity: "\$\{env\.CSC_NAME\}"/);
assert.match(builder, /^publish:[\s\S]*^  provider: github$/m);
assert.match(builder, /^  channel: latest$/m);
const extraResources = builder.slice(builder.indexOf("extraResources:"), builder.indexOf("win:"));
assert.doesNotMatch(extraResources, /packages\/agent-runtime|resources\/node/);
assert.match(builder, /from: src\/PiDesktop\.Tauri\/src-tauri\/components\/synthv-agent-bridge\/dist/);

console.log("Electron updater and packaging contracts passed.");
