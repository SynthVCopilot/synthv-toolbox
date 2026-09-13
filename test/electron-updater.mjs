import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (filename) => readFileSync(join(root, filename), "utf8").replace(/\r\n/g, "\n");
const updater = read("src/PiDesktop.Tauri/electron/updater.ts");
const builder = read("electron-builder.yml");

assert.match(updater, /import electronUpdater from "electron-updater"/);
assert.match(updater, /const \{ autoUpdater \} = electronUpdater/);
assert.doesNotMatch(updater, /import \{ autoUpdater/);
assert.match(updater, /client\.autoDownload = true/);
assert.match(updater, /client\.autoInstallOnAppQuit = true/);
assert.match(updater, /checkForUpdates\(\)/);
assert.match(updater, /update-available/);
assert.match(updater, /download-progress/);
assert.match(updater, /update-downloaded[\s\S]*quitAndInstall\(false, true\)/);
assert.match(updater, /phase: "error"/);
assert.match(updater, /client\.channel = channel === "nightly" \? "nightly" : "latest"/);
assert.match(updater, /client\.allowPrerelease = channel === "nightly"/);

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
assert.match(builder, /buildResources: src\/PiDesktop\.Tauri\/electron\/assets/);
assert.match(builder, /icon: src\/PiDesktop\.Tauri\/electron\/assets\/icon\.ico/);
assert.match(builder, /icon: src\/PiDesktop\.Tauri\/electron\/assets\/icon\.icns/);
assert.match(builder, /license: src\/PiDesktop\.Tauri\/electron\/assets\/TERMS-OF-USE\.rtf/);
assert.match(builder, /from: src\/PiDesktop\.Tauri\/components\/synthv-agent-bridge\/dist/);
assert.doesNotMatch(builder, /src-tauri|resources\/node/);
for (const asset of ["icon.ico", "icon.icns", "TERMS-OF-USE.txt", "TERMS-OF-USE.rtf"]) {
  assert.equal(existsSync(join(root, "src/PiDesktop.Tauri/electron/assets", asset)), true, `${asset} must be packaged from Electron assets`);
}

const temporaryOutput = mkdtempSync(join(tmpdir(), "synthv-updater-contract-"));
try {
  execFileSync(process.execPath, [join(root, "src/PiDesktop.Tauri/node_modules/typescript/bin/tsc"), "--ignoreConfig", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--skipLibCheck", "--esModuleInterop", "true", "--outDir", temporaryOutput, join(root, "src/PiDesktop.Tauri/electron/updater.ts")], {
    cwd: join(root, "src/PiDesktop.Tauri"),
    stdio: "pipe",
  });
  const compiledUpdater = readFileSync(join(temporaryOutput, "updater.js"), "utf8");
  assert.match(compiledUpdater, /import electronUpdater from "electron-updater"/);
  assert.match(compiledUpdater, /const \{ autoUpdater \} = electronUpdater/);
  assert.doesNotMatch(compiledUpdater, /import \{ autoUpdater/);
} finally {
  rmSync(temporaryOutput, { recursive: true, force: true });
}

console.log("Electron updater and packaging contracts passed.");
