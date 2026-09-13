import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const main = readFileSync(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");
const types = readFileSync(new URL("../src/PiDesktop.Tauri/src/types.ts", import.meta.url), "utf8");
const messages = readFileSync(new URL("../src/PiDesktop.Tauri/src/i18nPlugins.ts", import.meta.url), "utf8");

test("plugin manifests expose permission levels as a record", () => {
  assert.match(types, /PluginPermissionLevel = "none" \| "optional" \| "required"/);
  assert.match(types, /permissions: Record<string, PluginPermissionLevel>/);
});

test("plugin privilege controls honor declared levels and required grants", () => {
  assert.match(main, /manifest\.permissions\["host\.internal"\] \?\? "none"/);
  assert.match(main, /manifest\.permissions\["host\.advanced"\] \?\? "none"/);
  assert.match(main, /internalFunctionsLevel === "required"/);
  assert.match(main, /advancedFunctionsLevel === "required"/);
  assert.match(main, /!enabled && missingRequiredGrant \? "disabled" : ""/);
  assert.match(main, /plugins\.requiredGrantMissing/);
  assert.match(main, /setPluginInternalFunctionsEnabled\(enabled\);\s*await reloadPluginState\(\)/);
  assert.match(main, /setPluginAdvancedFunctionsEnabled\(enabled\);\s*await reloadPluginState\(\)/);
});

test("plugin permission labels are localized", () => {
  assert.match(messages, /permissionLevel: \{ none:/);
  assert.match(messages, /requiredGrantMissing:/);
});
