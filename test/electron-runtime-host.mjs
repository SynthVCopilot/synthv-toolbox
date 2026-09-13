import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/PiDesktop.Tauri/electron/services/runtime-host.ts", import.meta.url), "utf8");

test("Electron runtime host keeps privileged MCP tools server-assigned", () => {
  assert.match(source, /toolbox_internal/);
  assert.match(source, /toolbox_advanced/);
  assert.match(source, /"permission" in args/);
  assert.match(source, /mcpInternalFunctionsEnabled/);
  assert.match(source, /mcpAdvancedFunctionsEnabled/);
  assert.match(source, /pluginInternalFunctionsEnabled/);
  assert.match(source, /pluginAdvancedFunctionsEnabled/);
  assert.match(source, /Plugin host requests require pluginId/);
  assert.match(source, /pluginPermissionLevel\(manifest, permission\) === "none"/);
});
