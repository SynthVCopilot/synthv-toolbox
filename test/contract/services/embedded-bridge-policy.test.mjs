import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../../../src/PiDesktop.Tauri/components/synthv-agent-bridge/dist/src/config.js";
import { createEmbeddedBridge } from "../../../src/PiDesktop.Tauri/components/synthv-agent-bridge/dist/src/embedded.js";

test("known writes fail closed on classification errors while rejected actions need no approval", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-policy-"));
  const bridge = createEmbeddedBridge({ config: loadConfig({ SYNTHV_AGENT_BRIDGE_DIR: directory }, directory), clientLabel: "policy-test" });
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const args = { get sharedGroupPolicy() { throw new Error("Classification failed"); } };
  assert.equal(bridge.classify("sv_command", { action: "edit_notes", args }).risk, "high");
  assert.equal(bridge.classify("sv_command", { action: "unknown_action", args }).risk, "normal");
  const tool = bridge.tools.find((tool) => tool.name === "sv_command");
  assert.ok(tool);
  assert.equal((await tool.call({ action: "unknown_action", args: {} })).isError, true);
});
