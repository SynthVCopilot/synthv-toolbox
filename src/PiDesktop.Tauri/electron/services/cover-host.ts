import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { EmbeddedBridge } from "./synthv-bridge.js";
import type { SynthVService } from "./synthv-service.js";

type Data = Record<string, any>;
export interface CoverNote { startSeconds: number; endSeconds: number; pitch: number; lyric: string; }
export interface CoverTarget {
  sessionToken: string; projectFile: string; trackIndex: number; groupIndex?: number;
  groupName: string; timeline: Array<{ position: number; bpm: number }>;
  notes: Array<{ onset: number; duration: number; pitch: number; lyrics: string }>;
  importedCount: number; language?: string;
}
export interface TuningMonitor { readNotes: Set<number>; writes: number; actions: Data[]; }
const GROUP_READS = new Set(["get_track_notes", "get_phrase_context", "get_group_voice", "get_note_phoneme_data", "get_computed_group_data", "get_note_retakes", "get_pitch_controls", "get_automation", "sample_automation", "get_track_mixer"]);
const TUNING_WRITES = new Set(["apply_group_tuning", "edit_notes", "set_group_voice", "set_note_phoneme_properties", "add_pitch_controls", "edit_pitch_controls", "delete_pitch_controls", "set_automation_points", "simplify_automation", "clear_automation"]);

export function createCoverHost(bridge: EmbeddedBridge, synthv: Pick<SynthVService, "listProcesses" | "sendShortcut">) {
  const call = async (name: string, input: Data): Promise<Data> => {
    const tool = bridge.tools.find(item => item.name === name);
    if (!tool) throw new Error(`Bridge tool ${name} is unavailable.`);
    const result = await tool.call(input), value = JSON.parse(result.text);
    if (result.isError || value.outcome === "failed" || value.outcome === "unknown") throw new Error(`${value.error?.code ?? "BRIDGE_ERROR"}: ${value.error?.message ?? result.text}`);
    return value;
  };
  const current = async (target?: CoverTarget) => {
    const status = await bridge.status();
    if (!status.connected || !status.status?.sessionToken) throw new Error("Start SynthV Bridge before processing a Cover.");
    if (target && (status.status.sessionToken !== target.sessionToken || status.status.projectFile !== target.projectFile)) throw new Error("SynthV project/session changed. Inspect the partial result before continuing.");
    return status;
  };
  const timeline = async () => {
    const value = await call("sv_query", { action: "get_time_axis", args: { tempoLimit: 1000, measureLimit: 1000 } });
    if (value.hasMore || !Array.isArray(value.tempoMarks) || !value.tempoMarks.length) throw new Error("The complete SynthV tempo map is required.");
    return value.tempoMarks.map((item: Data) => ({ position: finite(item.position), bpm: finite(item.bpm) }));
  };
  const readGroup = async (target: CoverTarget, offset: number, limit: number, writeIntent = false) => {
    await current(target);
    const value = await call("sv_query", { action: "get_track_notes", args: { trackIndex: target.trackIndex, groupIndex: target.groupIndex ?? 1, offset, limit }, contextMode: writeIntent ? "writeIntent" : "readOnly", dense: "never" });
    const group = value.groups?.find((item: Data) => item.groupIndex === (target.groupIndex ?? 1));
    if (!group || !Array.isArray(group.notes)) throw new Error("The Cover target group was not returned by SynthV.");
    if (target.groupIndex && group.name !== target.groupName) throw new Error("The Cover group identity changed.");
    return group;
  };
  return {
    async prepare(trackIndex: number, groupName: string, jobId: string): Promise<CoverTarget> {
      if (!Number.isInteger(trackIndex) || trackIndex < 1) throw new Error("A positive target track is required.");
      const status = await current(), projectFile = String(status.status?.projectFile ?? "");
      if (!isAbsolute(projectFile)) throw new Error("Save the SynthV project to a local SVP before starting a Cover.");
      const saved = await lstat(projectFile);
      if (!saved.isFile() || saved.isSymbolicLink() || saved.size > 64 * 1024 * 1024) throw new Error("The saved SynthV project must be a regular SVP file no larger than 64 MiB.");
      const target: CoverTarget = { sessionToken: status.status!.sessionToken!, projectFile, trackIndex, groupName: `${groupName.slice(0, 160)} · ${jobId.slice(0, 8)}`, timeline: await timeline(), notes: [], importedCount: 0 };
      await readGroup(target, 0, 1);
      return target;
    },
    async importNotes(target: CoverTarget, source: CoverNote[], signal: AbortSignal, checkpoint: (target: CoverTarget, dispatching: boolean) => Promise<void>) {
      if (!source.length || source.length > 20_000) throw new Error("Cover score must contain 1–20000 notes.");
      if (target.groupIndex || target.importedCount) throw new Error("A partial host import cannot be replayed. Inspect the existing Cover group first.");
      target.notes = source.map((note, i) => {
        if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127 || typeof note.lyric !== "string" || !note.lyric.trim()) throw new Error(`Invalid recognized note ${i + 1}.`);
        if (note.endSeconds <= note.startSeconds || note.startSeconds < 0 || (i > 0 && note.startSeconds < source[i - 1].endSeconds - 0.000001)) throw new Error(`Unresolved timing/overlap at note ${i + 1}.`);
        const onset = secondsToBlick(note.startSeconds, target.timeline), end = secondsToBlick(note.endSeconds, target.timeline);
        return { onset, duration: Math.max(1, end - onset), pitch: note.pitch, lyrics: note.lyric };
      });
      for (let offset = 0; offset < target.notes.length; offset += 60) {
        signal.throwIfAborted(); await current(target);
        if (JSON.stringify(await timeline()) !== JSON.stringify(target.timeline)) throw new Error("The SynthV tempo map changed during import.");
        const group = await readGroup(target, Math.max(0, target.importedCount - 1), 1, true);
        if (target.groupIndex && group.noteCount !== target.importedCount) throw new Error("The Cover group was edited during import.");
        await checkpoint(target, true);
        const notes = target.notes.slice(offset, offset + 60).map(note => ({ ...note, ...(target.language ? { languageOverride: target.language } : {}) }));
        const result = await call("sv_command", { action: "add_notes", contextId: group.contextId, args: { trackIndex: target.trackIndex, groupIndex: target.groupIndex ?? 1, grouping: target.groupIndex ? "target" : "ensureNonMain", ...(target.groupIndex ? {} : { groupName: target.groupName }), notes } });
        if (result.outcome !== "changed" || !Number.isInteger(result.groupIndex)) throw new Error("The host did not verify the imported batch. Inspect SynthV before retrying.");
        target.groupIndex = result.groupIndex;
        const actual = await readGroup(target, offset, notes.length);
        if (actual.noteCount !== offset + notes.length || actual.notes.length !== notes.length) throw new Error("Imported batch length did not match its readback.");
        assertNotes(notes, actual.notes);
        target.importedCount += notes.length;
        await checkpoint(target, false);
      }
      return target;
    },
    async verify(target: CoverTarget) {
      await current(target);
      if (JSON.stringify(await timeline()) !== JSON.stringify(target.timeline)) throw new Error("The SynthV tempo map changed after import.");
      for (let offset = 0; offset < target.notes.length; offset += 60) {
        const expected = target.notes.slice(offset, offset + 60), actual = await readGroup(target, offset, expected.length);
        if (actual.noteCount !== target.notes.length || actual.notes.length !== expected.length) throw new Error("Cover note coverage changed after tuning.");
        assertNotes(expected, actual.notes);
      }
      const voice = await call("sv_query", { action: "get_group_voice", args: { trackIndex: target.trackIndex, groupIndex: target.groupIndex } });
      return { noteCount: target.notes.length, geometryVerified: true, lyricsVerified: true, voice };
    },
    forTuning(target: CoverTarget, monitor: TuningMonitor): EmbeddedBridge {
      const contextIds = new Set<string>();
      const bound = bridge.tools.map(tool => ({ ...tool, async call(input: unknown) {
        const p = structuredClone(input) as Data, args = p.args ?? {};
        await current(target);
        if (tool.name === "sv_status" && ![undefined, "bridge", "host", "ping"].includes(p.operation)) throw new Error("Cover tuning cannot restart the host executor.");
        if (tool.name === "sv_ui") throw new Error("Cover tuning does not change the editor selection, playback or viewport.");
        if (tool.name === "sv_query") {
          if (!GROUP_READS.has(p.action)) throw new Error("Read only the designated Cover group while tuning.");
          if ((args.trackIndex !== undefined && args.trackIndex !== target.trackIndex) || (args.groupIndex !== undefined && args.groupIndex !== target.groupIndex)) throw new Error("This tuning session is bound to its Cover group.");
          p.args = { ...args, trackIndex: target.trackIndex, groupIndex: target.groupIndex };
          if (p.action === "get_track_notes") { p.args.limit = Math.min(Number(args.limit ?? 60), 60); p.dense = "never"; }
        }
        if (tool.name === "sv_command") {
          if (JSON.stringify(await timeline()) !== JSON.stringify(target.timeline)) throw new Error("The SynthV tempo map changed during tuning.");
          if (!TUNING_WRITES.has(p.action) || !contextIds.has(p.contextId)) throw new Error("Only fresh, group-bound tuning edits are allowed in this Cover session.");
          if ((args.trackIndex !== undefined && args.trackIndex !== target.trackIndex) || (args.groupIndex !== undefined && args.groupIndex !== target.groupIndex) || args.sharedGroupPolicy === "allowAllReferences") throw new Error("The tuning write escapes the Cover target.");
          for (const edit of args.edits ?? args.noteEdits ?? []) {
            if (["onset", "duration", "pitch", "lyrics"].some(key => edit.changes?.[key] !== undefined)) throw new Error("Repair note geometry and lyrics in the score-review stage, before host tuning.");
          }
          p.args = { ...args, trackIndex: target.trackIndex, groupIndex: target.groupIndex };
        }
        const reply = await tool.call(p);
        if (reply.isError) return reply;
        const value = JSON.parse(reply.text);
        if (typeof value.contextId === "string") contextIds.add(value.contextId);
        for (const group of value.groups ?? []) {
          if (group.groupIndex !== target.groupIndex) continue;
          if (typeof group.contextId === "string") contextIds.add(group.contextId);
          for (const note of Array.isArray(group.notes) ? group.notes : []) if (Number.isInteger(note.noteIndex)) monitor.readNotes.add(note.noteIndex);
        }
        if (p.action === "get_phrase_context") for (const note of Array.isArray(value.notes) ? value.notes : []) if (Number.isInteger(note.noteIndex)) monitor.readNotes.add(note.noteIndex);
        if (tool.name === "sv_command" && value.outcome === "changed" && value.verified === true) {
          monitor.writes += Number(value.changedCount ?? 1);
          monitor.actions.push({ action: p.action, changedCount: value.changedCount, verified: value.verified, traceId: value.traceId });
        }
        return reply;
      } }));
      return { ...bridge, tools: bound, classify: (name, input) => bridge.classify(name, input), status: () => bridge.status(), requestStop: () => { throw new Error("Cover tuning cannot stop the Bridge."); }, close: async () => {} };
    },
    async save(target: CoverTarget, processId?: number) {
      await current(target);
      const processes = (await synthv.listProcesses()).filter(item => item.isSv2 && (processId === undefined || item.processId === processId));
      if (processes.length !== 1 || !processes[0].processIdentity) throw new Error("Select the verified SynthV process before saving the Cover.");
      const beforeHash = createHash("sha256").update(await readFile(target.projectFile)).digest("hex");
      const result = await synthv.sendShortcut(processes[0].processId, processes[0].processIdentity, "save");
      if (!result.succeeded) throw new Error(result.detail || result.summary);
      for (let attempt = 0; attempt < 30; attempt++) {
        await current(target);
        const bytes = await readFile(target.projectFile);
        const content = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "").replace(/\0+$/u, ""));
        const group = content.library?.find((item: Data) => item.name === target.groupName);
        if (group?.notes?.length === target.notes.length && createHash("sha256").update(bytes).digest("hex") !== beforeHash) {
          try { assertNotes(target.notes, group.notes); return { svpPath: target.projectFile, saveVerified: true }; } catch {}
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error("SynthV did not save the complete Cover. The edits remain in the host; save them before closing it.");
    },
  };
}
export function secondsToBlick(seconds: number, marks: Array<{ position: number; bpm: number }>): number {
  if (!Number.isFinite(seconds) || seconds < 0 || !marks.length || marks[0].position !== 0) throw new Error("Invalid time conversion input.");
  let elapsed = 0;
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i], next = marks[i + 1];
    if (!Number.isFinite(mark.position) || !Number.isFinite(mark.bpm) || mark.bpm <= 0 || (next && next.position <= mark.position)) throw new Error("Invalid SynthV tempo map.");
    const span = next ? (next.position - mark.position) / 705600000 * 60 / mark.bpm : Infinity;
    if (seconds <= elapsed + span) return Math.round(mark.position + (seconds - elapsed) * mark.bpm / 60 * 705600000);
    elapsed += span;
  }
  throw new Error("Time conversion failed.");
}
function finite(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Non-finite timeline value."); return value; }
function assertNotes(expected: Data[], actual: Data[]) { for (let i = 0; i < expected.length; i++) for (const key of ["onset", "duration", "pitch", "lyrics"]) if (expected[i][key] !== actual[i]?.[key]) throw new Error(`Cover readback differs at note ${i + 1} (${key}).`); }
