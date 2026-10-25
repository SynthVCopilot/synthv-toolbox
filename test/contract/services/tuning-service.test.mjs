import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compiled } from "../_lib/load.mjs";

const { createTuningService, parametersFromFeatures } = await compiled("services/tuning-service.js");
const { createCreativeBridge } = await compiled("services/creative-bridge.js");

const features = (overrides = {}) => ({ durationSec: 20, medianPitchMidi: 64, pitchRangeSemitones: 12, vibratoRateHz: 6, vibratoDepthCents: 100, dynamicRangeDb: 18, breathinessProxy: 0.18, brightnessHz: 2000, voicedRatio: 0.8, ...overrides });
const root = await mkdtemp(join(tmpdir(), "tuning-service-"));
const absolute = name => join(root, name);
let nextFeatures = features();
let datasets = 0;
const make = (extra = {}) => createTuningService({ dataRoot: join(root, `data-${datasets++}`), sourceStyle: async () => nextFeatures, checkpoint: async () => ({ snapshotPath: absolute("snapshot.svp") }), ...extra });

try {
  const dataRoot = join(root, "data");
  const service = make({ dataRoot });
  assert.deepEqual(await service.invoke("list_tuning_profiles", {}), []);
  await assert.rejects(service.invoke("get_tuning_profile", { voiceName: "Missing" }), /No tuning profile/);
  await assert.rejects(service.invoke("learn_tuning_profile", { voiceName: "Voice", audioPath: "relative.wav" }), /absolute/);

  // The first sample takes the suggested parameters verbatim; the second moves them halfway to the new suggestion.
  const first = await service.invoke("learn_tuning_profile", { voiceName: "  Aria  ", audioPath: absolute("a.wav") });
  assert.equal(first.voiceName, "Aria"); assert.equal(first.normalizedVoiceName, "aria");
  assert.equal(first.sourceSamples, 1); assert.equal(first.outcomeSamples, 0);
  assert.deepEqual(first.parameters, { loudness: 0, tension: 0, breathiness: 0, gender: 0, toneShift: 0, vibratoStrength: 1 });
  nextFeatures = features({ dynamicRangeDb: 28, vibratoDepthCents: 0 });
  const second = await service.invoke("learn_tuning_profile", { voiceName: "ARIA", audioPath: absolute("b.wav") });
  assert.equal(second.sourceSamples, 2); assert.equal(second.voiceName, "ARIA");
  assert.equal(second.parameters.loudness, (28 - 18) * 0.12 / 2);
  assert.equal(second.parameters.vibratoStrength, 0.5);
  assert.equal(second.averageFeatures.dynamicRangeDb, 23);
  assert.equal((await service.invoke("list_tuning_profiles", {})).length, 1, "voice names that differ only by case share one profile");

  // On disk: one JSON file named by the SHA-256 of the normalized voice name, readable by a fresh service.
  const files = await readdir(join(dataRoot, "tuning-profiles"));
  assert.deepEqual(files, [`${createHash("sha256").update("aria").digest("hex")}.json`]);
  const stored = JSON.parse(await readFile(join(dataRoot, "tuning-profiles", files[0]), "utf8"));
  assert.deepEqual(Object.keys(stored), ["voiceName", "normalizedVoiceName", "sourceSamples", "outcomeSamples", "averageFeatures", "parameters", "updatedAtUtc"]);
  assert.deepEqual(await make({ dataRoot }).invoke("get_tuning_profile", { voiceName: "aria" }), second);

  // A/B feedback: a win moves toward the candidate by |improvement| / 4, a loss moves away from it by the same weight.
  const candidate = { loudness: 2, tension: 0.4, breathiness: 0.2, gender: 0, toneShift: 0, vibratoStrength: 1 };
  const won = await service.invoke("record_tuning_outcome", { voiceName: "aria", candidate, improvement: 1 });
  assert.equal(won.outcomeSamples, 1);
  assert.equal(won.parameters.loudness, second.parameters.loudness + (2 - second.parameters.loudness) * 0.25);
  const lost = await service.invoke("record_tuning_outcome", { voiceName: "aria", candidate, improvement: -1 });
  assert.equal(lost.outcomeSamples, 2);
  assert.ok(lost.parameters.loudness < won.parameters.loudness, "a loss moves away from the rejected candidate");
  const neutral = await service.invoke("record_tuning_outcome", { voiceName: "aria", candidate, improvement: 0 });
  assert.deepEqual(neutral.parameters, lost.parameters);
  for (const improvement of [1.01, -1.5, Number.NaN, "1"]) await assert.rejects(service.invoke("record_tuning_outcome", { voiceName: "aria", candidate, improvement }), /between -1 and 1/);
  await assert.rejects(service.invoke("record_tuning_outcome", { voiceName: "aria", candidate: { ...candidate, loudness: 13 }, improvement: 0.5 }), /safe range/);
  await assert.rejects(service.invoke("record_tuning_outcome", { voiceName: "nobody", candidate, improvement: 0.5 }), /No tuning profile/);

  nextFeatures = features({ durationSec: 0 });
  await assert.rejects(service.invoke("learn_tuning_profile", { voiceName: "Bad", audioPath: absolute("c.wav") }), /invalid values/);
  nextFeatures = features({ vibratoRateHz: Number.POSITIVE_INFINITY });
  await assert.rejects(service.invoke("learn_tuning_profile", { voiceName: "Bad", audioPath: absolute("c.wav") }), /invalid/);
  nextFeatures = features();
  await assert.rejects(service.invoke("learn_tuning_profile", { voiceName: "x".repeat(201), audioPath: absolute("c.wav") }), /1 to 200/);
  assert.equal((await service.invoke("list_tuning_profiles", {})).length, 1, "rejected input leaves no profile behind");

  // A corrupt file is reported for the voice it belongs to and skipped by the list.
  await writeFile(join(dataRoot, "tuning-profiles", files[0]), "{ not json");
  await assert.rejects(service.invoke("get_tuning_profile", { voiceName: "aria" }), /cannot be parsed/);
  assert.deepEqual(await service.invoke("list_tuning_profiles", {}), []);

  // Concurrent learns of one voice are serialized, so no sample is lost.
  const concurrent = make();
  await Promise.all(Array.from({ length: 8 }, () => concurrent.invoke("learn_tuning_profile", { voiceName: "Race", audioPath: absolute("r.wav") })));
  assert.equal((await concurrent.invoke("get_tuning_profile", { voiceName: "race" })).sourceSamples, 8);

  // Apply writes the profile parameters and per-note vibrato through one fresh write context.
  const commands = [];
  const notes = [{ noteIndex: 1 }, { noteIndex: 2 }, { noteIndex: 4 }];
  const bridge = createCreativeBridge({ status: async () => ({ connected: true, status: { sessionToken: "s1", projectFile: absolute("song.svp") } }), tools: ["sv_query", "sv_command"].map(name => ({ name, async call(input) {
    if (name === "sv_query") {
      assert.equal(input.contextMode, "writeIntent"); assert.deepEqual(input.args, { trackIndex: 2, groupIndex: 3, offset: 0, limit: 512 });
      return { isError: false, text: JSON.stringify({ groups: [{ groupIndex: 3, contextId: "ctx_write_context_long_enough", notes }] }) };
    }
    commands.push(input);
    return { isError: false, text: JSON.stringify({ outcome: "changed", changedCount: 3 }) };
  } })) });
  const seeded = make({ bridge });
  nextFeatures = features({ vibratoDepthCents: 50 });
  await seeded.invoke("learn_tuning_profile", { voiceName: "Aria", audioPath: absolute("a.wav") });
  const applied = await seeded.invoke("apply_tuning_profile", { voiceName: "aria", trackIndex: 2, groupIndex: 3 });
  assert.equal(applied.kind, "learned-tuning-apply");
  assert.equal(commands.length, 1);
  assert.equal(commands[0].action, "apply_group_tuning"); assert.equal(commands[0].contextId, "ctx_write_context_long_enough");
  assert.deepEqual(commands[0].args.voice.parameters, { loudness: 0, tension: 0, breathiness: 0, gender: 0, toneShift: 0 });
  assert.deepEqual(commands[0].args.noteEdits.map(edit => edit.noteIndex), [1, 2, 4]);
  assert.ok(commands[0].args.noteEdits.every(edit => edit.changes.attributes.dF0VbrMod === 0.5));
  await assert.rejects(seeded.invoke("apply_tuning_profile", { voiceName: "aria", trackIndex: 0, groupIndex: 3 }), /positive integer/);
  await assert.rejects(seeded.invoke("apply_tuning_profile", { voiceName: "nobody", trackIndex: 1, groupIndex: 1 }), /No tuning profile/);
  assert.equal(commands.length, 1, "rejected applies write nothing");

  // Solo A/B iteration against a fake render pipeline.
  const solo = async ({ improves, undoRestores = true, mode = "solo", supported = true, projectFile = absolute("song.svp") }) => {
    await writeFile(absolute("song.svp"), "{}"); await writeFile(absolute("other.svp"), "{}");
    const events = [];
    const reference = features({ medianPitchMidi: 70, brightnessHz: 3000 });
    let tuned = false;
    const clips = new Map();
    const rendered = path => clips.get(path) === "baseline" || !tuned || !improves ? features({ medianPitchMidi: 50, brightnessHz: 1000 }) : features({ medianPitchMidi: 69, brightnessHz: 2900 });
    const service = make({
      workMode: () => mode, pause: async () => {},
      sourceStyle: async path => path === absolute("ref.wav") ? reference : rendered(path),
      checkpoint: async (path, label) => { events.push(["checkpoint", path, label]); return { snapshotPath: absolute("snapshot.svp") }; },
      bridge: { currentProject: async () => projectFile, applyTuning: async () => { tuned = true; events.push(["apply"]); return { applied: { changedCount: 3 } }; } },
      synthv: { listProcesses: async () => [{ processId: 7, processIdentity: "id-7" }], sendShortcut: async (id, identity, action) => { events.push(["shortcut", id, identity, action]); if (action === "undo" && undoRestores) tuned = false; return { succeeded: true }; } },
      audio: {
        capability: async () => ({ supported, detail: "no capture here" }),
        capture: async request => { const outputPath = absolute(`${request.label}-${clips.size}.wav`); clips.set(outputPath, request.label.replace("solo-", "")); events.push(["capture", request.label]); return { outputPath }; },
        compare: async () => ({ similarityPercent: undoRestores ? 99 : 80, loudnessDeltaDb: 0.1 }),
      },
    });
    return { events, service, request: { referenceAudioPath: absolute("ref.wav"), voiceName: "Aria", projectPath: absolute("song.svp"), processId: 7, trackIndex: 1, groupIndex: 1, startSeconds: 1, endSeconds: 6 } };
  };
  const shortcuts = events => events.filter(([kind]) => kind === "shortcut").map(event => event[3]);

  const accepted = await solo({ improves: true });
  const kept = await accepted.service.invoke("run_solo_tuning", { request: accepted.request });
  assert.equal(kept.accepted, true); assert.ok(kept.improvement >= 0.02);
  assert.deepEqual(shortcuts(accepted.events), ["save"]);
  assert.equal(kept.profile.outcomeSamples, 1);
  assert.equal(kept.checkpointPath, absolute("snapshot.svp"));

  const rejected = await solo({ improves: false });
  const undone = await rejected.service.invoke("run_solo_tuning", { request: rejected.request });
  assert.equal(undone.accepted, false); assert.equal(undone.rollbackVerified, true);
  assert.deepEqual(shortcuts(rejected.events), ["undo"]);
  assert.deepEqual(rejected.events.filter(([kind]) => kind === "capture").map(event => event[1]), ["solo-baseline", "solo-candidate", "solo-rollback"]);

  const stuck = await solo({ improves: false, undoRestores: false });
  await assert.rejects(stuck.service.invoke("run_solo_tuning", { request: stuck.request }), /Undo did not restore the baseline; use checkpoint/);

  const edit = await solo({ improves: true, mode: "edit" });
  await assert.rejects(edit.service.invoke("run_solo_tuning", { request: edit.request }), /Solo mode/);
  assert.deepEqual(edit.events, [], "nothing is touched outside Solo mode");
  const silent = await solo({ improves: true, supported: false });
  await assert.rejects(silent.service.invoke("run_solo_tuning", { request: silent.request }), /no capture here/);
  const other = await solo({ improves: true, projectFile: absolute("other.svp") });
  await assert.rejects(other.service.invoke("run_solo_tuning", { request: other.request }), /does not match/);
  assert.deepEqual(other.events, [], "a mismatched project is never checkpointed or written");
  for (const patch of [{ endSeconds: 40 }, { startSeconds: -1 }, { endSeconds: 1 }, { processId: 0 }]) await assert.rejects(accepted.service.invoke("run_solo_tuning", { request: { ...accepted.request, ...patch } }), /Solo A\/B clip|positive integer/);
  await assert.rejects(make({ workMode: () => "solo" }).invoke("run_solo_tuning", { request: accepted.request }), /capture is unavailable/);

  assert.deepEqual(parametersFromFeatures(features({ dynamicRangeDb: 1000, brightnessHz: 1e9, breathinessProxy: 9, medianPitchMidi: 1e6, vibratoDepthCents: 1e9 })), { loudness: 3, tension: 0.6, breathiness: 0.7, gender: 0, toneShift: 0.25, vibratoStrength: 1.5 });
  console.log("Tuning profile learning, feedback, persistence, Bridge apply and Solo iteration contracts passed.");
} finally { await rm(root, { recursive: true, force: true }); }
