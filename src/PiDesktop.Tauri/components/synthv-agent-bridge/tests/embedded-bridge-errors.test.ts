import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { createEmbeddedBridge, type EmbeddedBridge } from "../src/embedded.js";
import {
  commandPolicyActionNames,
  commandPolicyFor,
} from "../src/v3-command-policy.js";

async function withBridge(run: (bridge: EmbeddedBridge) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synthv-embedded-errors-test-"));
  const config = loadConfig(
    { SYNTHV_AGENT_BRIDGE_DIR: directory, SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "2000" },
    directory,
  );
  const bridge = createEmbeddedBridge({ config, clientLabel: "embedded-test" });
  try {
    await run(bridge);
  } finally {
    await bridge.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function tool(bridge: EmbeddedBridge, name: string) {
  const found = bridge.tools.find((entry) => entry.name === name);
  assert.ok(found, `${name} must be exposed`);
  return found;
}

test("top-level argument validation failures report capped, field-level issues", async () => {
  await withBridge(async (bridge) => {
    const result = await tool(bridge, "sv_command").call({ action: 42, args: "nope" });
    assert.equal(result.isError, true);
    const envelope = JSON.parse(result.text);
    assert.equal(envelope.error.code, "INVALID_ARGUMENT");
    const issues = envelope.error.details.issues as { path: string[]; code: string; message: string }[];
    assert.ok(issues.length >= 2 && issues.length <= 8);
    assert.deepEqual(issues.map((issue) => issue.path[0]).sort(), ["action", "args"]);
    for (const issue of issues) {
      assert.equal(typeof issue.code, "string");
      assert.equal(typeof issue.message, "string");
    }
  });
});

test("unknown and wrong-category actions return nearest names and a describe hint", async () => {
  await withBridge(async (bridge) => {
    const unknown = await tool(bridge, "sv_query").call({ action: "listTrack", args: {} });
    assert.equal(unknown.isError, true);
    const details = JSON.parse(unknown.text).error.details;
    assert.ok(details.suggestions.length > 0 && details.suggestions.length <= 3);
    assert.equal(details.next, `call sv_describe with action=${details.suggestions[0]}`);

    const unknownDescribe = await tool(bridge, "sv_describe").call({ action: "listTrack" });
    assert.equal(unknownDescribe.isError, true);
    assert.ok(JSON.parse(unknownDescribe.text).error.details.suggestions.length > 0);

    const writeAction = commandPolicyActionNames().find(
      (name) => commandPolicyFor(name).category === "edit",
    );
    assert.ok(writeAction);
    const wrong = await tool(bridge, "sv_query").call({ action: writeAction, args: {} });
    assert.equal(wrong.isError, true);
    assert.match(JSON.parse(wrong.text).error.details.next, /sv_describe/);
  });
});

test("classification fails closed and sv_status is annotated destructive", async () => {
  await withBridge(async (bridge) => {
    assert.equal(bridge.classify("sv_command", {}).risk, "high");
    assert.equal(bridge.classify("sv_command", { action: "no_such_action_xyz", args: {} }).risk, "high");
    assert.equal(bridge.classify("sv_ui", { action: "no_such_action_xyz" }).risk, "high");
    assert.equal(tool(bridge, "sv_status").annotations.destructiveHint, true);
  });
});
