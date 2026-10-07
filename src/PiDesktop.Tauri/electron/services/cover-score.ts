import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface CoverScoreNote {
  readonly id: string;
  startSeconds: number;
  endSeconds: number;
  pitch: number;
  lyric: string;
  phoneme?: string;
  phoneset?: string;
}

export interface CoverScoreIssue {
  readonly id: string;
  readonly noteIds: string[];
  readonly severity: "info" | "warning" | "severe";
  readonly code: string;
  readonly message: string;
}

export interface CoverScoreService {
  prepare(jobId: string, sourcePath: string, expectedSha256: string, evidence?: { segmentsPath?: string; analysisPath?: string; rawNotesPath?: string }): Promise<{ fingerprint: string; noteCount: number; totalDuration: number }>;
  inspect(jobId: string, options?: { offset?: number; limit?: number }): Promise<{ fingerprint: string; notes: Array<CoverScoreNote & { previous: CoverScoreNote | null; next: CoverScoreNote | null }>; issues: CoverScoreIssue[]; noteCount: number; totalDuration: number; evidence: { words: unknown[]; rawPitchCandidates: unknown[]; analysisSummary: Record<string, unknown> | null } }>;
  edit(jobId: string, input: { fingerprint: string; edits: CoverScoreEdit[]; reason: string }): Promise<{ fingerprint: string; noteCount: number; changes: number }>;
  review(jobId: string, input: { fingerprint: string; noteIds: string[]; summary: string; unresolved: string[] }): Promise<{ reviewed: number; complete: boolean; liveNoteCount: number }>;
  accept(jobId: string, input: { summary: string; unresolved: string[] }): Promise<{ accepted: true; fingerprint: string; noteCount: number }>;
  result(jobId: string): Promise<CoverScoreResult | null>;
  finalize(jobId: string): Promise<{ complete: boolean; reviewed: number; noteCount: number; unresolved: string[] }>;
}

export type CoverScoreEdit =
  | { type: "update"; id: string; changes: Partial<Pick<CoverScoreNote, "startSeconds" | "endSeconds" | "pitch" | "lyric">> }
  | { type: "delete"; id: string }
  | { type: "insert"; afterId?: string; note: Omit<CoverScoreNote, "id"> };

export interface CoverScoreResult {
  notesPath: string;
  sha256: string;
  noteCount: number;
  issues: CoverScoreIssue[];
  changes: Array<{ type: string; id: string; reason: string }>;
  accepted: true;
}

interface ReviewState { fingerprint: string; summary: string; unresolved: string[] }
interface JobState {
  sourceSha256: string;
  sourceName: string;
  originalNotes: CoverScoreNote[];
  notes: CoverScoreNote[];
  originalDuration: number;
  changes: Array<{ type: string; id: string; reason: string }>;
  reviews: Record<string, ReviewState>;
  accepted?: CoverScoreResult;
  acceptanceSummary?: string;
  unresolved: string[];
  evidenceFiles?: { segments?: string; analysis?: string; rawNotes?: string };
}

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_NOTES = 20_000;
const MAX_EDITS = 60;
const MAX_READ = 60;
const TAIL_SLACK_SECONDS = 0.25;

function hash(data: string | Uint8Array): string { return createHash("sha256").update(data).digest("hex"); }
function fingerprint(notes: readonly CoverScoreNote[]): string { return hash(JSON.stringify(notes)); }
function noteFingerprint(note: CoverScoreNote): string { return hash(JSON.stringify(note)); }
function clone<T>(value: T): T { return structuredClone(value); }
function validateJobId(jobId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(jobId)) throw new Error("Invalid job id.");
}

function parseNotes(source: unknown): { notes: CoverScoreNote[]; duration: number } {
  if (!source || typeof source !== "object") throw new Error("Score document must be an object.");
  const data = source as Record<string, unknown>;
  if (data.timingBasis !== "seconds" || !Array.isArray(data.notes) || data.notes.length === 0 || data.notes.length > MAX_NOTES || (data.noteCount !== undefined && data.noteCount !== data.notes.length)) throw new Error("Expected seconds timing, matching noteCount, and 1..20000 notes.");
  const notes = data.notes.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`Invalid note at index ${index}.`);
    const item = value as Record<string, unknown>;
    const startSeconds = item.startSeconds;
    const endSeconds = item.endSeconds;
    const pitch = item.pitch;
    const lyric = item.lyric;
    if (typeof startSeconds !== "number" || !Number.isFinite(startSeconds) || typeof endSeconds !== "number" || !Number.isFinite(endSeconds) ||
      typeof pitch !== "number" || !Number.isInteger(pitch) || pitch < 0 || pitch > 127 || typeof lyric !== "string") throw new Error(`Invalid note fields at index ${index}.`);
    const note: CoverScoreNote = { id: `note-${String(index + 1).padStart(6, "0")}`, startSeconds, endSeconds, pitch, lyric };
    if (typeof item.phoneme === "string") note.phoneme = item.phoneme;
    if (typeof item.phoneset === "string") note.phoneset = item.phoneset;
    return note;
  });
  const duration = notes.reduce((max, note) => Math.max(max, note.endSeconds), 0);
  return { notes, duration };
}

function validateNotes(notes: readonly CoverScoreNote[], duration: number, options: { allowZeroDuration?: boolean; allowOverlap?: boolean } = {}): void {
  if (notes.length > MAX_NOTES) throw new Error("Score exceeds 20000 notes.");
  let previous: CoverScoreNote | undefined;
  for (const note of notes) {
    if (!Number.isFinite(note.startSeconds) || !Number.isFinite(note.endSeconds) || note.startSeconds < 0 || note.endSeconds < note.startSeconds || (!options.allowZeroDuration && note.endSeconds === note.startSeconds) || note.endSeconds > duration + TAIL_SLACK_SECONDS) throw new Error(`Invalid timing for ${note.id}.`);
    if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) throw new Error(`Invalid pitch for ${note.id}.`);
    if (typeof note.lyric !== "string") throw new Error(`Invalid lyric for ${note.id}.`);
    if (!options.allowOverlap && previous && note.startSeconds < previous.endSeconds - 0.000001) throw new Error(`Monophonic overlap between ${previous.id} and ${note.id}.`);
    previous = note;
  }
}

function findIssues(notes: readonly CoverScoreNote[]): CoverScoreIssue[] {
  const issues: CoverScoreIssue[] = [];
  const add = (code: string, severity: CoverScoreIssue["severity"], noteIds: string[], message: string) => issues.push({ id: `${code}:${noteIds.join(":")}`, code, severity, noteIds, message });
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]!;
    const duration = note.endSeconds - note.startSeconds;
    if (i > 0 && note.startSeconds < notes[i - 1]!.endSeconds - 0.000001) add("overlap", "severe", [notes[i - 1]!.id, note.id], "Adjacent notes overlap and violate the monophonic score constraint.");
    if (duration === 0) add("zero-duration-note", "warning", [note.id], "Note has zero duration and must be repaired before acceptance.");
    else if (duration < 0.025) add("very-short-note", "warning", [note.id], "Note is shorter than 25 ms.");
    else if (duration < 0.055) add("short-note", "info", [note.id], "Note is shorter than 55 ms.");
    if (!note.lyric.trim()) add("empty-lyric", "warning", [note.id], "Lyric is empty.");
    if (/^(?:-|、|,|\.\.?)$/.test(note.lyric.trim())) add("possible-melisma-fragment", "info", [note.id], "Lyric may be a continuation or melisma fragment.");
    if (i > 0) {
      const prev = notes[i - 1]!;
      if (Math.abs(note.pitch - prev.pitch) >= 12) add("octave-leap", Math.abs(note.pitch - prev.pitch) >= 24 ? "warning" : "info", [prev.id, note.id], "Adjacent notes differ by at least an octave.");
      if (note.lyric === prev.lyric && note.lyric.trim()) add("repeated-lyric-fragment", "info", [prev.id, note.id], "Adjacent notes repeat the same lyric fragment.");
      const gap = note.startSeconds - prev.endSeconds;
      if (gap > 0.8) add("segment-boundary-discontinuity", "warning", [prev.id, note.id], "Large gap may indicate a segment boundary discontinuity.");
    }
  }
  return issues;
}

export function createCoverScoreService(dataRoot: string): CoverScoreService {
  const root = resolve(dataRoot);
  const locks = new Map<string, Promise<void>>();

  async function inJob<T>(jobId: string, action: () => Promise<T>): Promise<T> {
    validateJobId(jobId);
    const prior = locks.get(jobId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => { release = resolveLock; });
    const queued = prior.then(() => current);
    locks.set(jobId, queued);
    await prior;
    try { return await action(); }
    finally { release(); if (locks.get(jobId) === queued) locks.delete(jobId); }
  }

  async function jobDir(jobId: string, create = false): Promise<string> {
    const rootReal = await realpath(root);
    const parent = join(rootReal, "cover-score");
    if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentStat = await lstat(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error("Unsafe score storage directory.");
    const dir = join(parent, jobId);
    if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
    const dirStat = await lstat(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || dirname(dir) !== parent) throw new Error("Unsafe job directory.");
    const real = await realpath(dir);
    if (!real.startsWith(`${rootReal}${sep}`)) throw new Error("Job directory is outside data root.");
    return real;
  }

  async function readState(jobId: string): Promise<JobState> {
    const dir = await jobDir(jobId);
    const raw = await readFile(join(dir, "state.json"), "utf8");
    return JSON.parse(raw) as JobState;
  }

  async function atomicWrite(filePath: string, data: string): Promise<void> {
    const temporary = join(dirname(filePath), `.tmp-${randomUUID()}`);
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    try { await rename(temporary, filePath); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
  }

  async function saveState(jobId: string, state: JobState): Promise<void> {
    const dir = await jobDir(jobId);
    await atomicWrite(join(dir, "state.json"), JSON.stringify(state));
  }

  function assertFingerprint(state: JobState, expected: string): void {
    if (fingerprint(state.notes) !== expected) throw new Error("STALE_SCORE: score changed; inspect again before editing.");
  }

  return {
    async prepare(jobId, sourcePath, expectedSha256, evidence) {
      return inJob(jobId, async () => {
        if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error("Expected SHA-256 is required.");
        const rootReal = await realpath(root);
        const absolute = resolve(sourcePath);
        if (!isAbsolute(sourcePath)) throw new Error("Source file must be an absolute path inside data root.");
        const st = await lstat(absolute);
        if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_BYTES) throw new Error("Source must be a regular file no larger than 64 MiB.");
        const real = await realpath(absolute);
        const sourceRelative = relative(rootReal, real);
        if (sourceRelative === ".." || sourceRelative.startsWith(`..${sep}`) || isAbsolute(sourceRelative)) throw new Error("Source path resolves outside data root.");
        const bytes = await readFile(real);
        if (bytes.byteLength > MAX_BYTES) throw new Error("Source exceeds 64 MiB.");
        if (hash(bytes) !== expectedSha256.toLowerCase()) throw new Error("Source SHA-256 mismatch.");
        const parsed = parseNotes(JSON.parse(bytes.toString("utf8")));
        const sidecars: Array<{ field: "segments" | "analysis" | "rawNotes"; filename: string; bytes: Buffer }> = [];
        let analysisDuration: number | undefined;
        for (const [field, source] of [["segments", evidence?.segmentsPath], ["analysis", evidence?.analysisPath], ["rawNotes", evidence?.rawNotesPath]] as const) {
          if (!source) continue;
          const sidecar = resolve(source);
          if (!isAbsolute(source)) throw new Error("Evidence files must use absolute paths.");
          const sidecarStat = await lstat(sidecar);
          if (sidecarStat.isSymbolicLink() || !sidecarStat.isFile() || sidecarStat.size > MAX_BYTES) throw new Error("Evidence must be a regular file no larger than 64 MiB.");
          const sidecarReal = await realpath(sidecar);
          if (dirname(sidecarReal) !== dirname(real)) throw new Error("Evidence path resolves outside the source directory.");
          const sidecarBytes = await readFile(sidecarReal);
          if (sidecarBytes.byteLength > MAX_BYTES) throw new Error("Evidence exceeds 64 MiB.");
          const sidecarData = JSON.parse(sidecarBytes.toString("utf8"));
          if (field === "analysis" && typeof sidecarData?.durationSeconds === "number" && Number.isFinite(sidecarData.durationSeconds) && sidecarData.durationSeconds > 0) analysisDuration = sidecarData.durationSeconds;
          sidecars.push({ field, filename: `${field}.json`, bytes: sidecarBytes });
        }
        const originalDuration = analysisDuration ?? parsed.duration;
        validateNotes(parsed.notes, originalDuration, { allowZeroDuration: true, allowOverlap: true });
        const dir = await jobDir(jobId, true);
        const originalPath = join(dir, "original.json");
        await writeFile(originalPath, bytes, { flag: "wx", mode: 0o600 });
        const evidenceFiles: JobState["evidenceFiles"] = {};
        for (const sidecar of sidecars) {
          await writeFile(join(dir, sidecar.filename), sidecar.bytes, { flag: "wx", mode: 0o600 });
          evidenceFiles[sidecar.field] = sidecar.filename;
        }
        const state: JobState = { sourceSha256: expectedSha256.toLowerCase(), sourceName: basename(real), originalNotes: clone(parsed.notes), notes: clone(parsed.notes), originalDuration, changes: [], reviews: {}, unresolved: [], evidenceFiles };
        await atomicWrite(join(dir, "state.json"), JSON.stringify(state));
        return { fingerprint: fingerprint(state.notes), noteCount: state.notes.length, totalDuration: originalDuration };
      });
    },
    async inspect(jobId, options = {}) {
      return inJob(jobId, async () => {
        const state = await readState(jobId);
        const offset = options.offset ?? 0;
        const limit = options.limit ?? MAX_READ;
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_READ) throw new Error("offset must be nonnegative and limit must be 1..60.");
        const notes = state.notes.slice(offset, offset + limit).map((note) => {
          const index = state.notes.findIndex((item) => item.id === note.id);
          return { ...clone(note), previous: index > 0 ? clone(state.notes[index - 1]!) : null, next: index + 1 < state.notes.length ? clone(state.notes[index + 1]!) : null };
        });
        const firstTime = notes[0]?.startSeconds ?? 0;
        const lastTime = notes.at(-1)?.endSeconds ?? firstTime;
        const evidence = { words: [] as unknown[], rawPitchCandidates: [] as unknown[], analysisSummary: null as Record<string, unknown> | null };
        const loadEvidence = async (filename: string | undefined): Promise<any> => filename ? JSON.parse(await readFile(join(await jobDir(jobId), filename), "utf8")) : null;
        if (state.evidenceFiles?.segments) {
          const segments = await loadEvidence(state.evidenceFiles.segments);
          const words = Array.isArray(segments?.words) ? segments.words : Array.isArray(segments?.segments) ? segments.segments : [];
          evidence.words = words.filter((word: any) => typeof word?.start === "number" && typeof word?.end === "number" && word.end >= firstTime - 1 && word.start <= lastTime + 1).slice(0, 120);
        }
        if (state.evidenceFiles?.rawNotes) {
          const raw = await loadEvidence(state.evidenceFiles.rawNotes);
          evidence.rawPitchCandidates = (Array.isArray(raw?.notes) ? raw.notes : []).filter((note: any) => typeof note?.startSeconds === "number" && typeof note?.endSeconds === "number" && note.endSeconds >= firstTime - 1 && note.startSeconds <= lastTime + 1).slice(0, 120);
        }
        if (state.evidenceFiles?.analysis) {
          const analysis = await loadEvidence(state.evidenceFiles.analysis);
          const keys = ["tool", "durationSeconds", "sampleRate", "rawNoteCount", "monoRate", "pitchRange", "transformations", "inference", "transcription", "alignment", "qualityWarnings"];
          evidence.analysisSummary = Object.fromEntries(keys.filter((key) => analysis?.[key] !== undefined).map((key) => [key, analysis[key]]));
        }
        return { fingerprint: fingerprint(state.notes), notes, issues: findIssues(state.notes).filter((issue) => issue.noteIds.some((id) => notes.some((note) => note.id === id))), noteCount: state.notes.length, totalDuration: state.originalDuration, evidence };
      });
    },
    async edit(jobId, input) {
      return inJob(jobId, async () => {
        if (!Array.isArray(input.edits) || input.edits.length < 1 || input.edits.length > MAX_EDITS || !input.reason.trim() || input.reason.length > 1000) throw new Error("Provide 1..60 edits and a reason no longer than 1000 characters.");
        const state = await readState(jobId);
        assertFingerprint(state, input.fingerprint);
        if (state.accepted) throw new Error("Accepted score cannot be edited.");
        const candidate = clone(state.notes);
        const changedIds = new Set<string>();
        const invalidatedIds = new Set<string>();
        for (const edit of input.edits) {
          if (edit.type === "update") {
            const i = candidate.findIndex((note) => note.id === edit.id);
            const changeKeys = Object.keys(edit.changes ?? {});
            if (i < 0 || changeKeys.length === 0 || changeKeys.some((key) => !["startSeconds", "endSeconds", "pitch", "lyric"].includes(key))) throw new Error(`Unknown note or invalid changes: ${edit.id}.`);
            for (const neighbor of [candidate[i - 1], candidate[i], candidate[i + 1]]) if (neighbor) invalidatedIds.add(neighbor.id);
            candidate[i] = { ...candidate[i]!, ...edit.changes };
            changedIds.add(edit.id);
            state.changes.push({ type: "update", id: edit.id, reason: input.reason });
          } else if (edit.type === "delete") {
            const i = candidate.findIndex((note) => note.id === edit.id);
            if (i < 0) throw new Error(`Unknown note: ${edit.id}.`);
            for (const neighbor of [candidate[i - 1], candidate[i], candidate[i + 1]]) if (neighbor) invalidatedIds.add(neighbor.id);
            candidate.splice(i, 1);
            changedIds.add(edit.id);
            state.changes.push({ type: "delete", id: edit.id, reason: input.reason });
          } else if (edit.type === "insert") {
            const i = edit.afterId === undefined ? -1 : candidate.findIndex((note) => note.id === edit.afterId);
            if (edit.afterId !== undefined && i < 0) throw new Error(`Unknown anchor note: ${edit.afterId}.`);
            const id = `insert-${randomUUID()}`;
            const supplied = edit.note as Omit<CoverScoreNote, "id"> & Record<string, unknown>;
            if (!supplied || Object.keys(supplied).some((key) => !["startSeconds", "endSeconds", "pitch", "lyric", "phoneme", "phoneset"].includes(key))) throw new Error("Inserted note has unsupported fields.");
            const note: CoverScoreNote = { startSeconds: supplied.startSeconds, endSeconds: supplied.endSeconds, pitch: supplied.pitch, lyric: supplied.lyric, id };
            if (typeof supplied.phoneme === "string") note.phoneme = supplied.phoneme;
            if (typeof supplied.phoneset === "string") note.phoneset = supplied.phoneset;
            for (const neighbor of [candidate[i], candidate[i + 1]]) if (neighbor) invalidatedIds.add(neighbor.id);
            candidate.splice(i + 1, 0, note);
            changedIds.add(id);
            state.changes.push({ type: "insert", id, reason: input.reason });
          } else throw new Error("Unsupported score edit.");
        }
        validateNotes(candidate, state.originalDuration);
        for (const id of [...changedIds, ...invalidatedIds]) delete state.reviews[id];
        state.notes = candidate;
        await saveState(jobId, state);
        return { fingerprint: fingerprint(candidate), noteCount: candidate.length, changes: input.edits.length };
      });
    },
    async review(jobId, input) {
      return inJob(jobId, async () => {
        const state = await readState(jobId);
        assertFingerprint(state, input.fingerprint);
        if (!input.summary.trim() || input.summary.length > 2000 || input.noteIds.length < 1 || input.noteIds.length > MAX_READ || input.unresolved.length > 60 || input.unresolved.some((item) => typeof item !== "string" || item.length > 300)) throw new Error("Review requires a bounded summary, 1..60 note ids, and at most 60 bounded uncertainty entries.");
        const unique = [...new Set(input.noteIds)];
        if (unique.length !== input.noteIds.length || unique.some((id) => !state.notes.some((note) => note.id === id))) throw new Error("Review contains duplicate or unknown note ids.");
        for (const id of unique) {
          const note = state.notes.find((item) => item.id === id)!;
          state.reviews[id] = { fingerprint: noteFingerprint(note), summary: input.summary, unresolved: [...input.unresolved] };
        }
        state.unresolved = [...new Set([...state.unresolved, ...input.unresolved])];
        await saveState(jobId, state);
        const reviewed = state.notes.filter((note) => state.reviews[note.id]?.fingerprint === noteFingerprint(note)).length;
        return { reviewed, complete: reviewed === state.notes.length, liveNoteCount: state.notes.length };
      });
    },
    async accept(jobId, input) {
      return inJob(jobId, async () => {
        const state = await readState(jobId);
        if (!input.summary.trim() || input.summary.length > 2000 || input.unresolved.length > 60 || input.unresolved.some((item) => typeof item !== "string" || item.length > 300)) throw new Error("Acceptance requires a bounded summary and at most 60 bounded uncertainty entries.");
        validateNotes(state.notes, state.originalDuration);
        const reviewed = state.notes.filter((note) => state.reviews[note.id]?.fingerprint === noteFingerprint(note));
        if (reviewed.length !== state.notes.length) throw new Error(`Full-song review incomplete: ${reviewed.length}/${state.notes.length}.`);
        const unresolved = [...new Set([...state.unresolved, ...input.unresolved])];
        const severe = findIssues(state.notes).filter((issue) => issue.severity === "severe");
        if (severe.some((issue) => unresolved.includes(issue.id) || unresolved.includes(issue.code))) throw new Error("Severe unresolved issues prevent acceptance.");
        state.acceptanceSummary = input.summary;
        state.unresolved = unresolved;
        const output = { timingBasis: "seconds", notes: state.notes.map(({ id: _id, ...note }) => note), noteCount: state.notes.length };
        const bytes = JSON.stringify(output, null, 2);
        const dir = await jobDir(jobId);
        const notesPath = join(dir, "repaired.json");
        await atomicWrite(notesPath, bytes);
        const accepted: CoverScoreResult = { notesPath, sha256: hash(bytes), noteCount: state.notes.length, issues: findIssues(state.notes), changes: clone(state.changes), accepted: true };
        state.accepted = accepted;
        await saveState(jobId, state);
        return { accepted: true, fingerprint: fingerprint(state.notes), noteCount: state.notes.length };
      });
    },
    async result(jobId) { return inJob(jobId, async () => (await readState(jobId)).accepted ?? null); },
    async finalize(jobId) {
      return inJob(jobId, async () => {
        const state = await readState(jobId);
        const reviewed = state.notes.filter((note) => state.reviews[note.id]?.fingerprint === noteFingerprint(note)).length;
        const severe = findIssues(state.notes).filter((issue) => issue.severity === "severe");
        let structurallyValid = true;
        try { validateNotes(state.notes, state.originalDuration); }
        catch { structurallyValid = false; }
        return { complete: reviewed === state.notes.length && structurallyValid && severe.length === 0, reviewed, noteCount: state.notes.length, unresolved: [...state.unresolved] };
      });
    },
  };
}
