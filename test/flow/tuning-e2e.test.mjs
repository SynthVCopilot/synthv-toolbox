import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compiled } from "../contract/_lib/load.mjs";

const { ElectronCommandRegistry } = await compiled("services/command-registry.js");
const { createCreativeService } = await compiled("services/creative-service.js");

const root = await mkdtemp(join(tmpdir(), "tuning-e2e-"));
const audio = join(root, "reference.wav");
const sourceStyle = { tool: "pi-audio/source-style", audio, durationSec: 12, medianPitchMidi: 67, pitchRangeSemitones: 14, vibratoRateHz: 5.5, vibratoDepthCents: 60, dynamicRangeDb: 20, breathinessProxy: 0.25, breathinessProxyNote: "proxy", brightnessHz: 2400, voicedRatio: 0.7 };
const writes = [];
const bridge = {
  status: async () => ({ connected: true, status: { sessionToken: "session", projectFile: join(root, "song.svp") } }),
  tools: ["sv_query", "sv_command"].map(name => ({ name, async call(input) {
    if (name === "sv_query") return { isError: false, text: JSON.stringify({ groups: [{ groupIndex: 1, contextId: "ctx_write_context_long_enough", notes: [{ noteIndex: 1 }] }] }) };
    writes.push(input);
    return { isError: false, text: JSON.stringify({ outcome: "changed", changedCount: 1 }) };
  } })),
};
const tasks = [];
const creative = createCreativeService(join(root, "creative"), async (command, args) => {
  tasks.push([command, args]);
  if (command !== "run_source_style") throw new Error(`Unexpected component command ${command}`);
  return { kind: "source-style", summary: "Reference vocal features extracted.", data: { ...sourceStyle, command } };
}, bridge);
const inertHost = { async load() { return {}; }, async contributions() { return []; }, runtime: { dispose: async () => {} } };
const inert = {};
const registry = new ElectronCommandRegistry(inertHost, { ai: inert, creative, desktop: { synthvEnabled: () => true }, synthv: inert, componentAudio: { dataRoot: root, run: async () => ({ stdout: "", stderr: "" }) } });

try {
  assert.deepEqual(await registry.invoke("list_tuning_profiles"), []);
  const learned = await registry.invoke("learn_tuning_profile", { audioPath: audio, voiceName: "Eleanor Forte" });
  assert.deepEqual(tasks, [["run_source_style", { audioPath: audio }]], "features come from the bundled audio component");
  assert.equal(learned.sourceSamples, 1);
  assert.equal(learned.averageFeatures.medianPitchMidi, 67);
  assert.equal(Object.hasOwn(learned.averageFeatures, "tool"), false, "component bookkeeping fields are not stored");
  assert.deepEqual((await registry.invoke("list_tuning_profiles")).map(profile => profile.voiceName), ["Eleanor Forte"]);

  const updated = await registry.invoke("record_tuning_outcome", { voiceName: "eleanor forte", candidate: learned.parameters, improvement: 0.5 });
  assert.equal(updated.outcomeSamples, 1);
  assert.deepEqual(updated.parameters, learned.parameters, "feedback toward the current parameters changes nothing");

  const applied = await registry.invoke("apply_tuning_profile", { voiceName: "Eleanor Forte", trackIndex: 1, groupIndex: 1 });
  assert.equal(applied.kind, "learned-tuning-apply");
  assert.equal(writes.length, 1); assert.equal(writes[0].action, "apply_group_tuning");
  const [history] = await registry.invoke("list_creative_history", {});
  assert.equal(history.kind, "learned-tuning-apply");

  await assert.rejects(registry.invoke("run_solo_tuning", { request: {} }), /Solo mode/);
  await assert.rejects(registry.invoke("apply_tuning_profile", { voiceName: "Nobody", trackIndex: 1, groupIndex: 1 }), /No tuning profile/);
  assert.equal(writes.length, 1);
  console.log("Tuning commands reach the audio component, the profile store and the Bridge through the command registry.");
} finally { creative.dispose(); await rm(root, { recursive: true, force: true }); }
