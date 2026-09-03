import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("SV1 legacy Lua host executes standard operations with safe zero-based writes", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sv1-legacy-lua-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const result = spawnSync("lua", [path.resolve("test/sv1-legacy-mock-host.lua"), directory, path.resolve("legacy-sv1/synthv/SynthVAgentBridgeSV1Legacy.lua")], {
    encoding: "utf8",
    env: { ...process.env, SYNTHV_AGENT_SV1_LEGACY_DIR: directory },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /SV1_LEGACY_MOCK_OK/u);
});
