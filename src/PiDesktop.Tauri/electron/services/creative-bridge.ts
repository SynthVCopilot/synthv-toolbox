import { randomUUID } from "node:crypto";
import type { EmbeddedBridge } from "./synthv-bridge.js";

type Data = Record<string, any>;
type Selection = { sessionToken: string; signature: string; target: { trackIndex: number; groupIndex: number }; notes: Data[]; expires: number };
type Preview = Selection & { contextId: string; slots: Array<{ text: string; phoneme?: string }> };
export const CREATIVE_BRIDGE_COMMANDS = ["read_lyric_bridge_selection", "preview_lyric_bridge_fit", "confirm_lyric_bridge_fit", "run_score_to_synthv", "run_retake_workbench"];

export function createCreativeBridge(bridge: EmbeddedBridge) {
  const selections = new Map<string, Selection>();
  const previews = new Map<string, Preview>();
  const ttl = 120_000;
  const call = async (name: string, input: Data): Promise<Data> => {
    const tool = bridge.tools.find(item => item.name === name);
    if (!tool) throw new Error(`Bridge tool is unavailable: ${name}`);
    const reply = await tool.call(input);
    const value = JSON.parse(reply.text);
    if (reply.isError || value.outcome === "failed") throw new Error(`${value.error?.code ?? "BRIDGE_ERROR"}: ${value.error?.message ?? reply.text}`);
    return value;
  };
  const session = async () => {
    const status = await bridge.status();
    if (!status.connected || !status.status?.sessionToken) {
      selections.clear(); previews.clear();
      throw new Error("Connect SynthV Bridge before using this workflow.");
    }
    return status.status.sessionToken;
  };
  const readSelection = async (): Promise<Selection> => {
    const sessionToken = await session();
    const value = await call("sv_ui", { action: "get_selection", args: {} });
    if (value.pianoRollHasUnfinishedEdits || value.arrangementHasUnfinishedEdits) throw new Error("Finish the current SynthV edit before reading the selection.");
    const target = { trackIndex: index(value.current?.trackIndex), groupIndex: index(value.current?.groupIndex) };
    const notes = (Array.isArray(value.selectedNotes) ? value.selectedNotes : []).map((note: Data) => ({ noteIndex: index(note.noteIndex), lyric: String(note.lyrics ?? ""), onset: note.onset, duration: note.duration, pitch: note.pitch })).sort((a: Data, b: Data) => a.onset - b.onset || a.noteIndex - b.noteIndex);
    if (!notes.length || notes.length > 512 || notes.length !== value.selectedNoteCount) throw new Error("Select between 1 and 512 notes in one SynthV group.");
    if (await session() !== sessionToken) throw new Error("SynthV session changed. Read the selection again.");
    return { sessionToken, target, notes, signature: JSON.stringify({ target, notes, revision: value.selectionRevision }), expires: Date.now() + ttl };
  };
  const sameSelection = async (stored: Selection) => {
    if (stored.expires < Date.now()) throw new Error("The lyric preview expired. Read the selection again.");
    const current = await readSelection();
    if (current.sessionToken !== stored.sessionToken || current.signature !== stored.signature) throw new Error("SynthV selection or notes changed. Read the selection and preview again.");
  };
  const readNotes = async (target: Data, notes: Data[], intent = false) => {
    const indices = notes.map(note => note.noteIndex);
    const first = Math.min(...indices), last = Math.max(...indices);
    if (last - first >= 5000) throw new Error("Select a smaller note range before fitting lyrics.");
    return call("sv_query", { action: "get_track_notes", contextMode: intent ? "writeIntent" : "readOnly", dense: "never", args: { ...target, offset: first - 1, limit: last - first + 1 } });
  };
  const groupNotes = (read: Data, groupIndex: number): Data[] => {
    const group = read.groups?.find((item: Data) => item.groupIndex === groupIndex);
    if (!group || !Array.isArray(group.notes)) throw new Error("Bridge did not return the selected note group.");
    return group.notes;
  };
  const publicSelection = (value: Selection) => ({ sessionToken: value.sessionToken, target: value.target, notes: value.notes, noteCount: value.notes.length });
  return {
    async invoke(command: string, args: Data): Promise<Data> {
      for (const [key, value] of selections) if (value.expires < Date.now()) selections.delete(key);
      for (const [key, value] of previews) if (value.expires < Date.now()) previews.delete(key);
      if (command === "read_lyric_bridge_selection") {
        selections.clear(); previews.clear();
        const value = await readSelection(), selectionToken = randomUUID();
        selections.set(selectionToken, value);
        return { ...publicSelection(value), selectionToken };
      }
      if (command === "preview_lyric_bridge_fit") {
        const request = args.request;
        const stored = selections.get(request?.selectionToken);
        if (!stored || request.sessionToken !== stored.sessionToken) throw new Error("Read the SynthV selection again before previewing lyrics.");
        await sameSelection(stored);
        if (!Array.isArray(request.slots) || request.slots.length !== stored.notes.length) throw new Error("Supply exactly one lyric slot per selected note.");
        const slots = request.slots.map((slot: Data) => {
          if (typeof slot?.text !== "string" || !slot.text.trim() || slot.text.length > 1000) throw new Error("Each lyric slot must contain 1–1000 characters.");
          if (slot.phoneme !== undefined && (typeof slot.phoneme !== "string" || slot.phoneme.length > 4000)) throw new Error("Invalid phoneme slot.");
          return { text: slot.text, ...(slot.phoneme === undefined ? {} : { phoneme: slot.phoneme }) };
        });
        if (slots.some((slot: Data) => slot.phoneme !== undefined) && slots.some((slot: Data) => slot.phoneme === undefined)) throw new Error("Supply phonemes for every slot, or omit them to preserve existing phonemes.");
        const read = await readNotes(stored.target, stored.notes, true);
        const available = groupNotes(read, stored.target.groupIndex);
        for (const note of stored.notes) {
          const actual = available.find(item => item.noteIndex === note.noteIndex);
          if (!actual || actual.lyrics !== note.lyric || actual.onset !== note.onset || actual.duration !== note.duration || actual.pitch !== note.pitch) throw new Error("Notes changed while preparing the preview. Read the selection again.");
        }
        const contextId = read.groups?.find((group: Data) => group.groupIndex === stored.target.groupIndex)?.contextId;
        if (typeof contextId !== "string") throw new Error("Bridge did not authorize a fresh lyric write context.");
        await sameSelection(stored);
        const previewToken = randomUUID();
        previews.clear();
        previews.set(previewToken, { ...stored, contextId, slots });
        return { previewToken, sessionToken: stored.sessionToken, target: stored.target, slotCount: slots.length, expiresInSeconds: Math.max(0, Math.floor((stored.expires - Date.now()) / 1000)), notes: stored.notes.map((note, i) => ({ ...note, currentLyric: note.lyric, ...slots[i] })) };
      }
      if (command === "confirm_lyric_bridge_fit") {
        const token = args.request?.previewToken, preview = previews.get(token);
        if (!preview) throw new Error("The lyric preview is unavailable. Preview again before writing.");
        previews.delete(token);
        await sameSelection(preview);
        await call("sv_command", { action: "fit_lyrics", contextId: preview.contextId, args: { ...preview.target, notes: preview.notes.map(note => ({ noteIndex: note.noteIndex })), syllables: preview.slots.map(slot => slot.text), ...(preview.slots[0]?.phoneme === undefined ? {} : { phonemes: preview.slots.map(slot => slot.phoneme) }) } });
        selections.clear();
        try {
          if (await session() !== preview.sessionToken) throw new Error("session changed");
          const actual = groupNotes(await readNotes(preview.target, preview.notes), preview.target.groupIndex);
          for (let i = 0; i < preview.notes.length; i++) {
            const expected = preview.notes[i], note = actual.find(item => item.noteIndex === expected.noteIndex);
            if (!note || note.lyrics !== preview.slots[i].text || note.onset !== expected.onset || note.duration !== expected.duration || note.pitch !== expected.pitch) throw new Error("note readback differs");
          }
        } catch (error) { throw new Error(`Lyrics were written, but verification failed: ${String(error)}. Inspect SynthV before retrying.`); }
        return { applied: true, target: preview.target, noteCount: preview.notes.length };
      }
      if (command === "run_score_to_synthv") {
        if (args.rightsConfirmed !== true) throw new Error("Confirm permission to import this score first.");
        const sessionToken = await session(), trackIndex = index(args.trackIndex);
        const inspected = await call("sv_query", { action: "inspect_score_file", args: { filePath: args.scorePath, previewNoteLimit: 16 } });
        if (inspected.previewError) throw new Error(`Score cannot be imported: ${inspected.previewError.message}`);
        const read = await call("sv_query", { action: "get_track_notes", contextMode: "writeIntent", dense: "never", args: { trackIndex, groupIndex: 1, limit: 1 } });
        if (await session() !== sessionToken) throw new Error("SynthV session changed before score import.");
        const contextId = read.groups?.find((group: Data) => group.groupIndex === 1)?.contextId;
        if (typeof contextId !== "string") throw new Error("Bridge did not return an import write context.");
        const imported = await call("sv_command", { action: "import_monophonic_score", contextId, args: { trackIndex, groupIndex: 1, filePath: args.scorePath, expectedFileFingerprint: inspected.fileFingerprint, rightsConfirmed: true, groupName: args.groupName, grouping: "ensureNonMain" } });
        return { kind: "score-to-synthv", summary: "Score imported into a SynthV note group. Save the project in SynthV.", data: { inspection: inspected, imported, sourceTempoAppliedToProject: false } };
      }
      if (command === "run_retake_workbench") {
        const target = { trackIndex: index(args.trackIndex), groupIndex: index(args.groupIndex), noteIndex: index(args.noteIndex) };
        const sessionToken = await session();
        const read = await call("sv_query", { action: "get_note_retakes", contextMode: args.operation === "refresh" ? "readOnly" : "writeIntent", args: target });
        if (args.operation === "refresh") return { kind: "retake", summary: "Retake candidates read.", data: read };
        const action = ({ generate: "generate_note_retake", activate: "activate_note_retake", delete: "delete_note_retake" } as Data)[args.operation];
        if (!action) throw new Error("Unsupported retake operation.");
        if (await session() !== sessionToken) throw new Error("SynthV session changed before the retake operation.");
        const result = await call("sv_command", { action, contextId: read.contextId, args: { ...target, ...(args.operation === "generate" ? { newDuration: args.newDuration, newPitch: args.newPitch, newTimbre: args.newTimbre, activate: args.activate } : { takeId: args.takeId }) } });
        return { kind: "retake", summary: "Retake operation completed.", data: result };
      }
      throw new Error(`Unsupported Bridge workflow: ${command}`);
    },
  };
}
function index(value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error("SynthV indices must be positive integers."); return value; }
