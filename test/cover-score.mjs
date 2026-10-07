import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { createCoverScoreService } = await import(pathToFileURL(join(root, "src/PiDesktop.Tauri/electron/services/cover-score.ts")).href);
const { createCoverScoreToolsExtension } = await import(pathToFileURL(join(root, "src/PiDesktop.Tauri/electron/services/cover-score-tools.ts")).href);

const digest = (data) => createHash("sha256").update(data).digest("hex");
async function setup(count = 640) {
  const dir = await mkdtemp(join(tmpdir(), "cover-score-"));
  const notes = Array.from({ length: count }, (_, index) => ({ startSeconds: index * 0.1, endSeconds: index * 0.1 + 0.08, pitch: 60 + index % 12, lyric: `la${index}` }));
  const original = Buffer.from(JSON.stringify({ timingBasis: "seconds", noteCount: notes.length, notes }));
  const source = join(dir, "notes.json");
  await writeFile(source, original);
  await writeFile(join(dir, "segments.json"), JSON.stringify({ words: [{ start: 1, end: 1.3, text: "sample lyric", overlappingNotes: [] }] }));
  await writeFile(join(dir, "raw-notes.json"), JSON.stringify({ notes: [{ startSeconds: 1, endSeconds: 1.08, pitch: 72, velocity: 90 }] }));
  await writeFile(join(dir, "analysis.json"), JSON.stringify({ durationSeconds: 70, rawNoteCount: 700, monoRate: 0.97, qualityWarnings: ["review candidates"] }));
  const service = createCoverScoreService(dir);
  const prepared = await service.prepare("job-a", source, digest(original), { segmentsPath: join(dir, "segments.json"), analysisPath: join(dir, "analysis.json"), rawNotesPath: join(dir, "raw-notes.json") });
  return { dir, original, source, service, prepared, notes };
}

async function reviewAll(service, jobId, noteCount) {
  let reviewed = 0;
  for (let offset = 0; offset < noteCount; offset += 60) {
    const page = await service.inspect(jobId, { offset, limit: 60 });
    const result = await service.review(jobId, { fingerprint: page.fingerprint, noteIds: page.notes.map((note) => note.id), summary: `Reviewed notes ${offset} to ${offset + page.notes.length}.`, unresolved: [] });
    reviewed = result.reviewed;
  }
  return reviewed;
}

test("requires complete review beyond 512 notes and exports every accepted note unchanged", async () => {
  const ctx = await setup();
  try {
    const first = await ctx.service.inspect("job-a", { offset: 0, limit: 60 });
    assert.equal(first.evidence.words[0].text, "sample lyric");
    assert.equal(first.evidence.rawPitchCandidates[0].pitch, 72);
    assert.equal(first.evidence.analysisSummary.rawNoteCount, 700);
    assert.equal(first.notes[0].next.id, first.notes[1].id);
    assert.equal(first.notes[0].previous, null);
    assert.equal(await reviewAll(ctx.service, "job-a", ctx.notes.length), ctx.notes.length);
    await ctx.service.accept("job-a", { summary: "Every segment checked against ASR words and raw pitch candidates.", unresolved: [] });
    const result = await ctx.service.result("job-a");
    assert.equal(result.noteCount, ctx.notes.length);
    assert.equal(result.accepted, true);
    const exported = JSON.parse(await readFile(result.notesPath, "utf8"));
    assert.equal(exported.noteCount, ctx.notes.length);
    assert.equal(exported.notes.length, ctx.notes.length);
    assert.deepEqual(exported.notes[0], { ...ctx.notes[0] });
    assert.deepEqual(await readFile(ctx.source), ctx.original);
  } finally { await rm(ctx.dir, { recursive: true, force: true }); }
});

test("rejects overlapping edits without changing revision and invalidates reviewed neighbors", async () => {
  const ctx = await setup();
  try {
    const page = await ctx.service.inspect("job-a", { offset: 59, limit: 2 });
    const before = page.fingerprint;
    await ctx.service.review("job-a", { fingerprint: before, noteIds: page.notes.map((note) => note.id), summary: "Reviewed the segment boundary.", unresolved: [] });
    assert.equal((await ctx.service.finalize("job-a")).reviewed, 2);
    await assert.rejects(ctx.service.edit("job-a", { fingerprint: before, reason: "Fix a boundary timing error.", edits: [{ type: "update", id: page.notes[1].id, changes: { startSeconds: page.notes[0].endSeconds - 0.01 } }] }), /overlap/);
    assert.equal((await ctx.service.inspect("job-a", { offset: 59, limit: 2 })).fingerprint, before);
    const updated = await ctx.service.edit("job-a", { fingerprint: before, reason: "A supported pitch correction.", edits: [{ type: "update", id: page.notes[0].id, changes: { pitch: page.notes[0].pitch + 1 } }] });
    assert.equal((await ctx.service.finalize("job-a")).reviewed, 0, "an edit invalidates review of the changed note and its neighbor");
    await assert.rejects(ctx.service.review("job-a", { fingerprint: before, noteIds: [page.notes[0].id], summary: "stale", unresolved: [] }), /STALE_SCORE/);
    const current = await ctx.service.inspect("job-a", { offset: 59, limit: 2 });
    assert.equal(current.fingerprint, updated.fingerprint);
    await ctx.service.review("job-a", { fingerprint: current.fingerprint, noteIds: [page.notes[0].id, page.notes[1].id], summary: "Boundary reread.", unresolved: [] });
    assert.equal((await ctx.service.finalize("job-a")).reviewed, 2);
  } finally { await rm(ctx.dir, { recursive: true, force: true }); }
});

test("serializes concurrent writes and rejects a stale second revision", async () => {
  const ctx = await setup(4);
  try {
    const page = await ctx.service.inspect("job-a", { limit: 4 });
    const [first, second] = await Promise.allSettled([
      ctx.service.edit("job-a", { fingerprint: page.fingerprint, reason: "Supported pitch correction A.", edits: [{ type: "update", id: page.notes[0].id, changes: { pitch: page.notes[0].pitch + 1 } }] }),
      ctx.service.edit("job-a", { fingerprint: page.fingerprint, reason: "Supported pitch correction B.", edits: [{ type: "update", id: page.notes[3].id, changes: { pitch: page.notes[3].pitch + 1 } }] }),
    ]);
    assert.equal([first, second].filter((result) => result.status === "fulfilled").length, 1);
    assert.equal([first, second].filter((result) => result.status === "rejected" && /STALE_SCORE/.test(String(result.reason))).length, 1);
  } finally { await rm(ctx.dir, { recursive: true, force: true }); }
});

test("reports source overlaps and zero-duration notes, then accepts their explicit repair", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cover-score-invalid-source-"));
  try {
    const payload = Buffer.from(JSON.stringify({ timingBasis: "seconds", noteCount: 2, notes: [
      { startSeconds: 0, endSeconds: 0.2, pitch: 60, lyric: "one" },
      { startSeconds: 0.1, endSeconds: 0.1, pitch: 62, lyric: "two" },
    ] }));
    const source = join(dir, "notes.json");
    await writeFile(source, payload);
    const service = createCoverScoreService(dir);
    const prepared = await service.prepare("job-a", source, digest(payload));
    const page = await service.inspect("job-a");
    assert.deepEqual(new Set(page.issues.map((issue) => issue.code)), new Set(["overlap", "zero-duration-note"]));
    await service.review("job-a", { fingerprint: page.fingerprint, noteIds: page.notes.map((note) => note.id), summary: "Original timing issues reviewed.", unresolved: [] });
    assert.equal((await service.finalize("job-a")).complete, false, "invalid timing and overlap block completion even when notes were reviewed");
    const fixed = await service.edit("job-a", { fingerprint: prepared.fingerprint, reason: "Restore positive duration and monophonic order from the neighboring onset.", edits: [
      { type: "update", id: page.notes[1].id, changes: { startSeconds: 0.2, endSeconds: 0.3 } },
    ] });
    const reviewed = await service.inspect("job-a");
    await service.review("job-a", { fingerprint: fixed.fingerprint, noteIds: reviewed.notes.map((note) => note.id), summary: "Both corrected note timings reviewed.", unresolved: [] });
    await service.accept("job-a", { summary: "Explicit timing repair accepted.", unresolved: [] });
    assert.equal((await service.result("job-a")).noteCount, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("rejects sources outside dataRoot and refuses tools without a repair-phase job binding", async () => {
  const ctx = await setup(3);
  try {
    await assert.rejects(ctx.service.prepare("job-b", "/etc/hosts", "0".repeat(64)), /outside data root/);
    const registered = new Map();
    let completion;
    createCoverScoreToolsExtension({ service: ctx.service, jobForSession: () => undefined, phaseForSession: () => "repair", guards: { completion(check) { completion = check; } } }).factory({
      registerTool(tool) { registered.set(tool.name, tool); },
      on() {},
    });
    assert.equal(registered.size, 3);
    assert.equal(completion(), null);
    await assert.rejects(registered.get("cover_score_read").execute("call", {}, undefined, () => {}), /COVER_SCORE_UNBOUND/);
  } finally { await rm(ctx.dir, { recursive: true, force: true }); }
});
