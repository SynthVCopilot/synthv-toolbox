import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src/PiDesktop.Tauri");
const built = path.join(desktop, "dist/electron");

test("the build emits the native icons beside the compiled main process", () => {
  for (const icon of ["icon.ico", "icon.icns"]) assert.equal(existsSync(path.join(built, "assets", icon)), true, `${icon} must be present after build`);
});

test("the build emits an app package.json so the unpackaged app reports its own name and version", () => {
  const source = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8"));
  const emitted = JSON.parse(readFileSync(path.join(built, "package.json"), "utf8"));
  assert.equal(emitted.name, source.name);
  assert.equal(emitted.version, source.version);
});

test("the preload script is a classic script, which Electron's sandboxed preload loader requires", () => {
  assert.doesNotThrow(() => new vm.Script(readFileSync(path.join(built, "preload.js"), "utf8"), { filename: "preload.js" }));
});

test("the desktop bridge module stays ESM, so the preload build cannot overwrite it", async () => {
  const bridge = await import(pathToFileURL(path.join(built, "bridge.js")).href);
  for (const name of ["hasDesktopBridge", "invokeDesktop", "listenDesktop", "openDesktopDialog", "listenForDesktopFileDrops"]) assert.equal(typeof bridge[name], "function", name);
});

test("the embedded bridge bundle loads without any sibling node_modules", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "toneshuttle-embedded-"));
  try {
    cpSync(path.join(desktop, "components/synthv-agent-bridge/dist/src/embedded.js"), path.join(directory, "embedded.js"));
    await import(pathToFileURL(path.join(directory, "embedded.js")).href);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
