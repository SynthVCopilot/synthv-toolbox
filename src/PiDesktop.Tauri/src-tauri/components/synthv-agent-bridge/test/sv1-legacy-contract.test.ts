import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadLegacyConfig } from "../legacy-sv1/src/config.js";
import { LegacyIpcClient } from "../legacy-sv1/src/ipc.js";
import { legacyToolNames } from "../legacy-sv1/src/server.js";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("SV1 legacy executor is isolated and declares exactly the SV1 1.11.2 gate", async () => {
  const executor = await readFile(path.join(root, "legacy-sv1", "synthv", "SynthVAgentBridgeSV1Legacy.lua"), "utf8");
  assert.match(executor, /MIN_EDITOR_VERSION = 0x010B02/u);
  assert.match(executor, /synthv-agent-bridge-sv1-legacy/u);
  assert.doesNotMatch(executor, /synthv-agent-bridge\.request/u);
  for (const unsupported of ["singer.list", "part.assign_singer", "getRetakes", "getComputedPitchForGroup"]) assert.doesNotMatch(executor, new RegExp(unsupported.replaceAll(".", "\\."), "u"));
  for (const operation of ["studio.get_status", "project.get", "sequence.get", "transport.seek", "track.create", "part.delete", "note.update"]) assert.match(executor, new RegExp(`handlers\\["${operation.replaceAll(".", "\\.")}"\\]`, "u"));
  for (const field of ["trackIndex=i", "partIndex=i", "noteIndex=i", "deleted=true, trackIndex=index", "deleted=true, trackIndex=payload.trackIndex, partIndex=index", "deleted=true, trackIndex=payload.trackIndex, partIndex=payload.partIndex, noteIndex=index"]) assert.match(executor, new RegExp(field.replaceAll(".", "\\."), "u"));
  assert.doesNotMatch(executor, /return \{ index=i,/u);
});

test("SV1 legacy public MCP surface uses zero-based standard tools only", () => {
  assert.equal(legacyToolNames.includes("singer.list" as never), false);
  assert.equal(legacyToolNames.includes("part.assign_singer" as never), false);
  assert.equal(legacyToolNames.includes("note.create"), true);
  assert.equal(legacyToolNames.includes("transport.seek"), true);
  assert.equal(legacyToolNames.includes("studio.disconnect"), true);
  assert.equal(legacyToolNames.every((name) => !name.startsWith("sv_")), true);
});

test("SV1 legacy client exchanges requests only through its own IPC prefix", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sv1-legacy-ipc-test-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const config = loadLegacyConfig({ SYNTHV_AGENT_SV1_LEGACY_DIR: directory, SYNTHV_AGENT_SV1_LEGACY_TIMEOUT_MS: "1000", SYNTHV_AGENT_SV1_LEGACY_POLL_MS: "5" });
  const client = new LegacyIpcClient(config);
  const pending = client.call("track.list", {});
  let request = "";
  for (let attempt = 0; attempt < 50 && request === ""; attempt += 1) {
    request = await readFile(config.requestFile, "utf8").catch(() => "");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.notEqual(request, "");
  const parsed = JSON.parse(request) as { id: string; a: string; v: number };
  assert.equal(parsed.a, "track.list");
  assert.equal(parsed.v, 1);
  assert.match(config.requestFile, /synthv-agent-bridge-sv1-legacy\.request/u);
  await writeFile(config.responseFile, JSON.stringify({ v: 1, id: parsed.id, ok: true, result: [] }), "utf8");
  assert.deepEqual(await pending, []);
  assert.deepEqual(await client.disconnect(), { requested: true });
  await access(config.stopFile);
});
