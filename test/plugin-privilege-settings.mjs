import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const api = readFileSync(new URL("../src/PiDesktop.Tauri/src/api.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");
const types = readFileSync(new URL("../src/PiDesktop.Tauri/src/types.ts", import.meta.url), "utf8");
const config = readFileSync(new URL("../src/PiDesktop.Tauri/src-tauri/src/config.rs", import.meta.url), "utf8");
const commands = readFileSync(new URL("../src/PiDesktop.Tauri/src-tauri/src/agent_runtime_commands.rs", import.meta.url), "utf8");

test("plugin privilege settings default to disabled", () => {
  assert.match(config, /plugin_internal_functions_enabled:\s*false/);
  assert.match(config, /plugin_advanced_functions_enabled:\s*false/);
  assert.match(types, /pluginInternalFunctionsEnabled: boolean/);
  assert.match(types, /pluginAdvancedFunctionsEnabled: boolean/);
});

test("plugin privilege grants require global settings and expose dedicated API methods", () => {
  for (const method of [
    "setPluginInternalFunctionsEnabled",
    "setPluginAdvancedFunctionsEnabled",
    "setAgentPluginInternalFunctionsEnabled",
    "setAgentPluginAdvancedFunctionsEnabled",
  ]) assert.match(api, new RegExp(method));
  assert.match(commands, /plugin_internal_functions_enabled/);
  assert.match(commands, /plugin_advanced_functions_enabled/);
});

test("plugin manager disables individual grants until global permission is enabled", () => {
  assert.match(main, /data-plugin-internal-functions/);
  assert.match(main, /data-plugin-advanced-functions/);
  assert.match(main, /internalFunctionsAvailable \? "" : "disabled"/);
  assert.match(main, /advancedFunctionsAvailable \? "" : "disabled"/);
});
