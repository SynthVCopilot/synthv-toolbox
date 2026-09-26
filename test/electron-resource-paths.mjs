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

test("compiled preload script is CommonJS (Electron's sandboxed preload loader rejects ESM)", () => {
  const compiledUrl = new URL("../src/PiDesktop.Tauri/dist/electron/preload.js", import.meta.url);
  if (!existsSync(compiledUrl)) return;
  const compiled = readFileSync(compiledUrl, "utf8");
  assert.doesNotMatch(compiled, /^\s*import /m);
  assert.match(compiled, /require\("electron"\)/);
});
