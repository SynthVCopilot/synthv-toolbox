import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const yaml = createRequire(path.join(root, "src/PiDesktop.Tauri/node_modules/electron-updater/package.json"))("js-yaml");
const builder = yaml.load(readFileSync(path.join(root, "electron-builder.yml"), "utf8"));
const exists = (relative) => existsSync(path.join(root, relative));

test("the application is packaged as asar with native modules unpacked, and ships installers for Windows and macOS", () => {
  assert.equal(builder.asar, true);
  assert.ok(builder.asarUnpack.includes("**/*.node"));
  assert.deepEqual(builder.win.target, ["nsis"]);
  assert.deepEqual(builder.mac.target, ["dmg"]);
  assert.equal(builder.mac.hardenedRuntime, true);
});

test("updates are published as GitHub releases on the latest channel", () => {
  assert.equal(builder.publish.provider, "github");
  assert.equal(builder.publish.channel, "latest");
});

test("every file the packaging config points at exists", () => {
  for (const relative of [builder.directories.app, builder.directories.buildResources, builder.win.icon, builder.mac.icon, builder.nsis.include]) assert.ok(exists(relative), relative);
  for (const asset of ["icon.ico", "icon.icns", "TERMS-OF-USE.txt"]) assert.ok(exists(path.posix.join(builder.directories.buildResources, asset)), asset);
  for (const resource of builder.extraResources) assert.ok(exists(resource.from), `${resource.from} must exist before packaging`);
  // Platform resources are native build outputs, so only the host platform's can exist here.
  const platformResources = { win32: builder.win.extraResources, darwin: builder.mac.extraResources }[process.platform] ?? [];
  for (const resource of platformResources) assert.ok(exists(resource.from), `${resource.from} must exist before packaging`);
});
