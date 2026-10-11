import assert from "node:assert/strict";
import { createCreativeBridge } from "../src/PiDesktop.Tauri/dist/electron/services/creative-bridge.js";

let token = "session-a", selectionRevision = 1, selected = [1, 2], writes = 0;
const notes = [{ noteIndex: 1, lyrics: "旧", onset: 0, duration: 100, pitch: 60 }, { noteIndex: 2, lyrics: "词", onset: 100, duration: 100, pitch: 62 }];
let guarded;
const bridge = { status: async () => ({ connected: true, status: { sessionToken: token } }), tools: ["sv_ui", "sv_query", "sv_command"].map(name => ({ name, async call(input) {
  let result;
  if (name === "sv_ui") result = { current: { trackIndex: 1, groupIndex: 2 }, selectionRevision, selectedNoteCount: selected.length, selectedNotes: selected.map(i => structuredClone(notes[i - 1])) };
  if (name === "sv_query") { if (input.contextMode === "writeIntent") guarded = JSON.stringify(notes); result = { groups: [{ groupIndex: 2, contextId: "ctx_test_context_long_enough", notes: structuredClone(notes) }] }; }
  if (name === "sv_command") {
    assert.equal(input.action, "fit_lyrics"); assert.equal(input.contextId, "ctx_test_context_long_enough");
    if (guarded !== JSON.stringify(notes)) return { isError: true, text: JSON.stringify({ outcome: "failed", error: { code: "STALE_GUARD", message: "Notes changed" } }) };
    writes++;
    input.args.notes.forEach((note, i) => { notes[note.noteIndex - 1].lyrics = input.args.syllables[i]; });
    result = { outcome: "changed", changedCount: 2 };
  }
  return { isError: false, text: JSON.stringify(result) };
} })) };
const service = createCreativeBridge(bridge);
async function preview() {
  const selection = await service.invoke("read_lyric_bridge_selection", {});
  return service.invoke("preview_lyric_bridge_fit", { request: { selectionToken: selection.selectionToken, sessionToken: selection.sessionToken, slots: [{ text: "星" }, { text: "光" }] } });
}
let pending = await preview();
assert.equal(writes, 0);
const result = await service.invoke("confirm_lyric_bridge_fit", { request: { previewToken: pending.previewToken } });
assert.equal(result.applied, true); assert.equal(writes, 1);
assert.deepEqual(notes.map(n => n.lyrics), ["星", "光"]);
await assert.rejects(service.invoke("confirm_lyric_bridge_fit", { request: { previewToken: pending.previewToken } }), /preview.*unavailable/);
pending = await preview(); selectionRevision++;
await assert.rejects(service.invoke("confirm_lyric_bridge_fit", { request: { previewToken: pending.previewToken } }), /changed/);
pending = await preview(); token = "session-b";
await assert.rejects(service.invoke("confirm_lyric_bridge_fit", { request: { previewToken: pending.previewToken } }), /changed/);
pending = await preview(); notes[0].pitch++;
await assert.rejects(service.invoke("confirm_lyric_bridge_fit", { request: { previewToken: pending.previewToken } }), /changed/);
assert.equal(writes, 1);
await assert.rejects(service.invoke("run_score_to_synthv", { rightsConfirmed: false }), /permission/);
console.log("Bridge lyric preview, exactly-once write, readback, session, selection and note-change checks passed.");
