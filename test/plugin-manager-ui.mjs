import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const main = readFileSync(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/PiDesktop.Tauri/src/api.ts", import.meta.url), "utf8");

test("plugin manager exposes install, enable, disable, and uninstall controls", () => {
  for (const marker of ["data-install-plugin-archive", "data-install-plugin-directory", "data-toggle-plugin", "data-uninstall-plugin"]) {
    assert.match(main, new RegExp(marker));
  }
  for (const method of ["installAgentPlugin", "setAgentPluginEnabled", "uninstallAgentPlugin", "listInstalledPlugins"]) {
    assert.match(api, new RegExp(method));
  }
});

test("plugin changes reload both installed state and active runtime contributions", () => {
  assert.match(main, /async function reloadPluginState/);
  assert.match(main, /api\.discoverAgentPlugins/);
  assert.match(main, /pluginRegistry\.register/);
});
