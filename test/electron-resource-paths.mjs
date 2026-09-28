import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const main = readFileSync(new URL("../src/PiDesktop.Tauri/electron/main.ts", import.meta.url), "utf8");

test("Electron uses packaged native icons for both the window and tray", () => {
  assert.match(main, /function desktopIconPath\(\): string/);
  assert.match(main, /join\(currentDirectory, "assets", process\.platform === "darwin" \? "icon\.icns" : "icon\.ico"\)/);
  assert.match(main, /nativeImage\.createFromPath\(desktopIconPath\(\)\)/);
  assert.match(main, /icon: desktopIconPath\(\)/);
});

test("Electron build emits native icons beside the compiled main process", () => {
  for (const icon of ["icon.ico", "icon.icns"]) {
    assert.equal(existsSync(new URL(`../src/PiDesktop.Tauri/dist/electron/assets/${icon}`, import.meta.url)), true, `${icon} must be present after build`);
  }
});

test("Electron build emits an app package.json so the unpackaged app reports its own name and version", () => {
  const appPackage = JSON.parse(readFileSync(new URL("../src/PiDesktop.Tauri/package.json", import.meta.url), "utf8"));
  const emitted = JSON.parse(readFileSync(new URL("../src/PiDesktop.Tauri/dist/electron/package.json", import.meta.url), "utf8"));
  assert.equal(emitted.name, appPackage.name);
  assert.equal(emitted.version, appPackage.version);
});

test("compiled preload script is CommonJS (Electron's sandboxed preload loader rejects ESM)", () => {
  const compiledUrl = new URL("../src/PiDesktop.Tauri/dist/electron/preload.js", import.meta.url);
  assert.equal(existsSync(compiledUrl), true, "dist/electron/preload.js must be present after build:host");
  const compiled = readFileSync(compiledUrl, "utf8");
  assert.doesNotMatch(compiled, /^\s*import /m);
  assert.match(compiled, /require\("electron"\)/);
});

test("compiled bridge module stays ESM (the preload build must not overwrite it)", () => {
  const compiledUrl = new URL("../src/PiDesktop.Tauri/dist/electron/bridge.js", import.meta.url);
  assert.equal(existsSync(compiledUrl), true, "dist/electron/bridge.js must be present after build:host");
  const compiled = readFileSync(compiledUrl, "utf8");
  // bridge.ts never imports "electron", so absence of that string proves nothing; assert the ESM shape
  // itself, which is what the preload build's shared-outDir regression actually overwrote it with (CJS).
  assert.match(compiled, /^export (function|const)/m);
  assert.doesNotMatch(compiled, /^\s*"use strict";|\bexports\.\w+\s*=|\brequire\(/m);
});

test("build:bridge emits a self-contained dist/src/embedded.js with no bare zod or MCP SDK imports", () => {
  const compiledUrl = new URL("../src/PiDesktop.Tauri/components/synthv-agent-bridge/dist/src/embedded.js", import.meta.url);
  assert.equal(existsSync(compiledUrl), true, "dist/src/embedded.js must be present after build:bridge");
  const compiled = readFileSync(compiledUrl, "utf8");
  assert.doesNotMatch(compiled, /from\s+"zod"/);
  assert.doesNotMatch(compiled, /from\s+"@modelcontextprotocol\//);
});

test("ensure-bridge.mjs lists dist/src/embedded.js among the bridge entries it verifies", () => {
  const ensureBridge = readFileSync(new URL("../src/PiDesktop.Tauri/scripts/ensure-bridge.mjs", import.meta.url), "utf8");
  assert.match(ensureBridge, /dist\/src\/embedded\.js/);
});

test("electron-builder.yml still ships the bridge component's dist directory", () => {
  const builderConfig = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(builderConfig, /components\/synthv-agent-bridge\/dist/);
});
