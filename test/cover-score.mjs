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
    await assert.rejects(ctx.service.edit("job-a", { fingerprint: before, reason: "Test an invalid zero-duration edit.", edits: [{ type: "update", id: page.notes[0].id, changes: { endSeconds: page.notes[0].startSeconds } }] }), /zero-duration/);
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

test("repairs more than 60 pre-existing overlaps in bounded passes and records before/after values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cover-score-many-overlaps-"));
  try {
    const notes = Array.from({ length: 130 }, (_, index) => ({ startSeconds: index * 0.1, endSeconds: index * 0.1 + 0.12, pitch: 60, lyric: `syllable-${index}` }));
    const payload = Buffer.from(JSON.stringify({ timingBasis: "seconds", noteCount: notes.length, notes }));
    const source = join(dir, "notes.json");
    await writeFile(source, payload);
    const service = createCoverScoreService(dir);
    const prepared = await service.prepare("job-a", source, digest(payload));
    const editsFor = (page) => page.notes.slice(0, 60).map((note) => ({ type: "update", id: note.id, changes: { endSeconds: note.startSeconds + 0.1 } }));
    let page = await service.inspect("job-a", { offset: 0, limit: 60 });
    const first = await service.edit("job-a", { fingerprint: page.fingerprint, reason: "Trim each detected overlap to the following recognized onset.", edits: editsFor(page) });
    assert.equal(first.noteCount, 130);
    page = await service.inspect("job-a", { offset: 60, limit: 60 });
    const second = await service.edit("job-a", { fingerprint: page.fingerprint, reason: "Continue the overlap correction across the next segment.", edits: editsFor(page) });
    assert.equal(second.noteCount, 130);
    page = await service.inspect("job-a", { offset: 120, limit: 10 });
    await service.edit("job-a", { fingerprint: page.fingerprint, reason: "Trim the remaining onset overlaps.", edits: page.notes.slice(0, -1).map((note, index) => ({ type: "update", id: note.id, changes: { endSeconds: note.startSeconds + 0.1 } })) });
    const changed = await service.inspect("job-a", { offset: 0, limit: 1 });
    await reviewAll(service, "job-a", 130);
    await service.accept("job-a", { summary: "All timing overlaps corrected and reviewed.", unresolved: [] });
    const result = await service.result("job-a");
    assert.equal(result.noteCount, 130);
    assert.equal(result.changes.length, 129);
    assert.deepEqual(result.changes[0].before, { ...notes[0] });
    assert.deepEqual(result.changes[0].after, { ...notes[0], endSeconds: notes[0].startSeconds + 0.1 });
    assert.equal(changed.notes[0].id, "note-000001");
    assert.equal((await service.finalize("job-a")).complete, true);
    assert.equal(prepared.noteCount, 130);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("blocks empty lyrics and requires tool reads from the current revision before review", async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), "cover-score-empty-lyric-"));
  try {
    const payload = Buffer.from(JSON.stringify({ timingBasis: "seconds", noteCount: 1, notes: [{ startSeconds: 0, endSeconds: 0.4, pitch: 60, lyric: "" }] }));
    const source = join(emptyDir, "notes.json");
    await writeFile(source, payload);
    const service = createCoverScoreService(emptyDir);
    const prepared = await service.prepare("job-a", source, digest(payload));
    const emptyPage = await service.inspect("job-a");
    await service.review("job-a", { fingerprint: emptyPage.fingerprint, noteIds: [emptyPage.notes[0].id], summary: "Review the unresolved empty lyric.", unresolved: ["lyric needs acoustic evidence"] });
    assert.equal((await service.finalize("job-a")).complete, false);
    await assert.rejects(service.accept("job-a", { summary: "Accept", unresolved: [] }), /Empty lyrics/);
    const filled = await service.edit("job-a", { fingerprint: prepared.fingerprint, reason: "Fill the note from its overlapping ASR word evidence.", edits: [{ type: "update", id: emptyPage.notes[0].id, changes: { lyric: "word" } }] });
    await service.review("job-a", { fingerprint: filled.fingerprint, noteIds: [emptyPage.notes[0].id], summary: "Reviewed the evidence-backed lyric.", unresolved: [] });
    assert.equal((await service.finalize("job-a")).complete, true);
  } finally { await rm(emptyDir, { recursive: true, force: true }); }

  const ctx = await setup(3);
  try {
    const job = "job-a";
    const tools = new Map();
    const extension = createCoverScoreToolsExtension({ service: ctx.service, jobForSession: () => job, phaseForSession: () => "repair", guards: { completion() {} } });
    extension.factory({ registerTool(tool) { tools.set(tool.name, tool); }, on() {} });
    const reviewTool = tools.get("cover_score_review");
    const readTool = tools.get("cover_score_read");
    const editTool = tools.get("cover_score_edit");
    await assert.rejects(reviewTool.execute("call", { fingerprint: ctx.prepared.fingerprint, noteIds: ["note-000002"], summary: "Guess id", unresolved: [] }), /COVER_SCORE_NOT_READ/);
    const read = JSON.parse((await readTool.execute("call", { limit: 3 })).content[0].text);
    await editTool.execute("call", { fingerprint: read.fingerprint, reason: "Correct from current evidence.", edits: [{ type: "update", id: read.notes[1].id, changes: { pitch: read.notes[1].pitch + 1 } }] });
    const latest = await ctx.service.inspect(job, { limit: 3 });
    await assert.rejects(reviewTool.execute("call", { fingerprint: latest.fingerprint, noteIds: [latest.notes[1].id], summary: "Use an id read before the edit", unresolved: [] }), /COVER_SCORE_NOT_READ/);
    const reread = JSON.parse((await readTool.execute("call", { limit: 3 })).content[0].text);
    await reviewTool.execute("call", { fingerprint: reread.fingerprint, noteIds: reread.notes.map((note) => note.id), summary: "Reviewed live notes from this revision.", unresolved: [] });
    assert.equal((await ctx.service.finalize(job)).reviewed, 3);
  } finally { await rm(ctx.dir, { recursive: true, force: true }); }
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

test("recognition with a missing lyric enters repair and cannot be accepted without correction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cover-missing-lyric-"));
  try {
    const source = join(dir, "notes.json");
    const bytes = JSON.stringify({ timingBasis: "seconds", noteCount: 1, notes: [{startSeconds:0,endSeconds:1,pitch:60,velocity:40}] });
    await writeFile(source, bytes);
    const service = createCoverScoreService(dir);
    await service.prepare("missing", source, digest(bytes));
    const page = await service.inspect("missing");
    assert.equal(page.notes[0].lyric, "");
    assert.ok(page.issues.some(issue => issue.code === "empty-lyric"));
    await service.review("missing", {fingerprint:page.fingerprint,noteIds:[page.notes[0].id],summary:"Missing word requires evidence.",unresolved:["empty-lyric"]});
    assert.equal((await service.finalize("missing")).complete, false);
    await assert.rejects(service.accept("missing", {summary:"Cannot guess a word.",unresolved:[]}), /lyric/);
    assert.equal(await readFile(source, "utf8"), bytes);
  } finally { await rm(dir, {recursive:true,force:true}); }
});

test("correcting a recognized word clears the previous word's dictionary phonemes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cover-phoneme-repair-"));
  try {
    const source = join(dir, "notes.json");
    const bytes = JSON.stringify({timingBasis:"seconds",notes:[{startSeconds:0,endSeconds:1,pitch:60,lyric:"hello",phoneme:"h @ l @U",phoneset:"xsampa"}]});
    await writeFile(source,bytes);const service=createCoverScoreService(dir);
    await service.prepare("phonemes",source,digest(bytes));const before=await service.inspect("phonemes");
    await service.edit("phonemes",{fingerprint:before.fingerprint,reason:"Correct the recognition from aligned text evidence.",edits:[{type:"update",id:before.notes[0].id,changes:{lyric:"world"}}]});
    const after=await service.inspect("phonemes");
    assert.equal(after.notes[0].lyric,"world");assert.equal(after.notes[0].phoneme,undefined);assert.equal(after.notes[0].phoneset,undefined);
    assert.equal(await readFile(source,"utf8"),bytes);
  }finally{await rm(dir,{recursive:true,force:true});}
});
