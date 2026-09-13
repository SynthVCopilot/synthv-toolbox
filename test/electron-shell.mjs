import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../src/PiDesktop.Tauri/package.json", import.meta.url), "utf8"));
const electronMain = readFileSync(new URL("../src/PiDesktop.Tauri/electron/main.ts", import.meta.url), "utf8");
const preload = readFileSync(new URL("../src/PiDesktop.Tauri/electron/preload.ts", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/PiDesktop.Tauri/electron/bridge.ts", import.meta.url), "utf8");
const updater = readFileSync(new URL("../src/PiDesktop.Tauri/electron/updater.ts", import.meta.url), "utf8");
const runtimeHost = readFileSync(new URL("../src/PiDesktop.Tauri/electron/services/runtime-host.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/PiDesktop.Tauri/src/api.ts", import.meta.url), "utf8");
const rendererMain = readFileSync(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");
const builder = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");

test("Electron shell enables the secure window boundary and single instance lock", () => {
  for (const marker of ["contextIsolation: true", "sandbox: true", "nodeIntegration: false", "requestSingleInstanceLock", "second-instance"]) {
    assert.match(electronMain, new RegExp(marker));
  }
  assert.match(electronMain, /ELECTRON_RENDERER_URL/);
  assert.match(electronMain, /loadFile\(resolve\(currentDirectory, "\.\.\/\.\.\/dist\/index\.html"\)\)/);
});

test("Electron shell removes the default application menu", () => {
  assert.match(electronMain, /\bMenu\b/);
  assert.match(electronMain, /app\.whenReady\(\)\.then\(async \(\) => \{\s*Menu\.setApplicationMenu\(null\);/);
});

test("preload exposes only the typed desktop bridge", () => {
  assert.match(preload, /contextBridge\.exposeInMainWorld\("toolboxDesktop", bridge\)/);
  assert.match(preload, /ipcRenderer\.invoke\("toolbox:invoke"/);
  assert.match(preload, /ipcRenderer\.invoke\("toolbox:open-dialog"/);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^\n]+ipcRenderer/);
  for (const marker of ["invokeDesktop", "listenDesktop", "openDesktopDialog", "onFileDrop"]) {
    assert.match(bridge, new RegExp(marker));
  }
});

test("renderer API uses the Electron bridge while browser preview remains available", () => {
  assert.match(api, /const preview = !hasDesktopBridge\(\)/);
  assert.match(api, /return invokeDesktop<T>\(command, args\)/);
  assert.match(api, /openDesktopDialog/);
  assert.doesNotMatch(api, /@tauri-apps/);
  assert.doesNotMatch(rendererMain, /@tauri-apps/);
  assert.match(rendererMain, /listenForDesktopFileDrops/);
});

test("Electron build and launch scripts compile the shell", () => {
  assert.equal(typeof packageJson.scripts["build:electron"], "string");
  assert.equal(typeof packageJson.scripts["electron:dev"], "string");
  assert.equal(typeof packageJson.scripts["electron:start"], "string");
  assert.equal(typeof packageJson.devDependencies.electron, "string");
  assert.equal(typeof packageJson.dependencies["electron-updater"], "string");
  assert.equal(typeof packageJson.devDependencies["electron-builder"], "string");
  assert.equal(packageJson.dependencies["@tauri-apps/api"], undefined);
  assert.match(builder, /^asar: true$/m);
});

test("Electron host routes updater, runtime, plugin, and MCP commands through registered services", () => {
  for (const command of ["updater.check", "updater.restart", "updater.state", "check_toolbox_update"]) assert.match(electronMain, new RegExp(command.replace(".", "\\.")));
  assert.match(electronMain, /webContents\.send\("toolbox:event"/);
  assert.match(updater, /autoUpdater/);
  assert.match(runtimeHost, /class ElectronRuntimeHost/);
  assert.match(electronMain, /new ElectronCommandRegistry\(runtimeHost, \{ ai, creative, desktop, synthv, componentAudio:/);
});
