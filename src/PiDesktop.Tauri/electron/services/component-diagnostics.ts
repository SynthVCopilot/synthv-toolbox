import { readFile } from "node:fs/promises";

type Issue = { code: string; severity: "warning" | "error"; message: string; location: string };
type Note = Record<string, unknown>;

export async function projectDoctor(projectPath: string) {
  const project = JSON.parse(await readFile(projectPath, "utf8")) as Record<string, unknown>;
  const tracks = Array.isArray(project.tracks) ? project.tracks as Record<string, unknown>[] : [];
  const groups = new Set<string>();
  const issues: Issue[] = [];
  let inspectedItems = 0;
  let noteCount = 0;
  if (tracks.length === 0) issues.push({ code: "TRACKS_EMPTY", severity: "error", message: "Project has no tracks.", location: "tracks" });
  tracks.forEach((track, trackIndex) => {
    const mainGroup = track.mainGroup && typeof track.mainGroup === "object" ? track.mainGroup as Record<string, unknown> : undefined;
    const groupId = typeof mainGroup?.uuid === "string" ? mainGroup.uuid : undefined;
    if (groupId) groups.add(groupId);
    if (!mainGroup) issues.push({ code: "MAIN_GROUP_MISSING", severity: "error", message: "Track has no main note group.", location: `tracks[${trackIndex}].mainGroup` });
    const notes = Array.isArray(mainGroup?.notes) ? mainGroup.notes as Note[] : [];
    noteCount += notes.length;
    notes.forEach((note, noteIndex) => {
      inspectedItems += 1;
      const location = `tracks[${trackIndex}].mainGroup.notes[${noteIndex}]`;
      const onset = finite(note.onset);
      const duration = finite(note.duration);
      if (onset === undefined || duration === undefined || onset < 0 || duration <= 0) issues.push({ code: "NOTE_TIMING_INVALID", severity: "error", message: "Note onset or duration is invalid.", location });
      if (!track.mainRef || typeof track.mainRef !== "object" || !(track.mainRef as Record<string, unknown>).isInstrumental) {
        if (typeof note.lyrics !== "string" || !note.lyrics.trim()) issues.push({ code: "LYRIC_EMPTY", severity: "warning", message: "Vocal note has empty lyrics.", location });
      }
    });
    const parameters = mainGroup?.parameters && typeof mainGroup.parameters === "object" ? mainGroup.parameters as Record<string, unknown> : {};
    for (const [parameterName, curveValue] of Object.entries(parameters)) {
      inspectedItems += 1;
      const points = curveValue && typeof curveValue === "object" ? (curveValue as Record<string, unknown>).points : undefined;
      if (!Array.isArray(points)) {
        issues.push({ code: "PARAMETER_POINTS_INVALID", severity: "warning", message: "Parameter curve has no point list.", location: `tracks[${trackIndex}].mainGroup.parameters.${parameterName}` });
        continue;
      }
      points.forEach((point, pointIndex) => {
        const validArray = Array.isArray(point) && point.length >= 2 && finite(point[0]) !== undefined && finite(point[1]) !== undefined;
        const validObject = point && typeof point === "object" && finite((point as Record<string, unknown>).x) !== undefined && finite((point as Record<string, unknown>).y) !== undefined;
        if (!validArray && !validObject) issues.push({ code: "PARAMETER_POINT_INVALID", severity: "warning", message: "Parameter point coordinates are invalid.", location: `tracks[${trackIndex}].mainGroup.parameters.${parameterName}.points[${pointIndex}]` });
      });
    }
  });
  const library = Array.isArray(project.library) ? project.library as Record<string, unknown>[] : [];
  const knownIds = new Set([...groups, ...library.flatMap(group => typeof group.uuid === "string" ? [group.uuid] : [])]);
  tracks.forEach((track, trackIndex) => {
    const mainRef = track.mainRef && typeof track.mainRef === "object" ? track.mainRef as Record<string, unknown> : undefined;
    if (typeof mainRef?.groupID === "string" && !knownIds.has(mainRef.groupID)) issues.push({ code: "MAIN_GROUP_REFERENCE_UNRESOLVED", severity: "error", message: "Track main reference points to a missing note group.", location: `tracks[${trackIndex}].mainRef.groupID` });
    const references = Array.isArray(track.groups) ? track.groups as Record<string, unknown>[] : [];
    references.forEach((reference, referenceIndex) => {
      inspectedItems += 1;
      if (typeof reference.groupID === "string" && !knownIds.has(reference.groupID)) issues.push({ code: "GROUP_REFERENCE_UNRESOLVED", severity: "error", message: "Track refers to a missing note group.", location: `tracks[${trackIndex}].groups[${referenceIndex}]` });
    });
  });
  const version = finite(project.version);
  inspectedItems += tracks.length;
  const errors = issues.filter(issue => issue.severity === "error").length;
  const warnings = issues.filter(issue => issue.severity === "warning").length;
  const summary = `Inspected ${tracks.length} track(s) and ${noteCount} note(s); found ${errors} error(s) and ${warnings} warning(s).`;
  return { kind: "project-doctor", summary, data: { kind: "project-doctor", ok: errors === 0, summary, version, era: version === undefined ? "unknown" : version <= 134 ? "SV1" : version >= 153 ? "SV2" : `boundary(${version})`, trackCount: tracks.length, noteCount, inspectedItems, issues } };
}

export async function pronunciationDiagnostics(projectPath?: string, lyrics?: string) {
  const issues: Issue[] = [];
  let inspectedItems = 0;
  if (projectPath) {
    const project = JSON.parse(await readFile(projectPath, "utf8")) as Record<string, unknown>;
    const tracks = Array.isArray(project.tracks) ? project.tracks as Record<string, unknown>[] : [];
    tracks.forEach((track, trackIndex) => {
      const group = track.mainGroup && typeof track.mainGroup === "object" ? track.mainGroup as Record<string, unknown> : {};
      const notes = Array.isArray(group.notes) ? group.notes as Note[] : [];
      notes.forEach((note, noteIndex) => {
        inspectedItems += 1;
        if (typeof note.lyrics !== "string" || !note.lyrics.trim() || ["-", "+", "br", "sil", "sp", "ap"].includes(note.lyrics.trim().toLowerCase())) {
          issues.push({ code: "LYRIC_EMPTY_OR_CONTROL", severity: "warning", message: "Note has no pronounceable lyric text.", location: `tracks[${trackIndex}].mainGroup.notes[${noteIndex}]` });
        }
      });
    });
  }
  if (lyrics !== undefined) {
    const entries = lyrics.split(/\r?\n/u).map((value, index) => ({ value: value.trim(), index })).filter(entry => entry.value.length > 0);
    inspectedItems += entries.length;
    entries.forEach(({ value, index }) => {
      if (/^[\p{P}\p{S}]+$/u.test(value)) issues.push({ code: "LYRIC_HAS_NO_LETTERS", severity: "warning", message: "Lyric line contains no letters or numbers.", location: `lyrics[${index}]` });
    });
  }
  if (!projectPath && lyrics === undefined) throw new Error("Provide projectPath or lyrics for pronunciation diagnostics.");
  const errors = issues.filter(issue => issue.severity === "error").length;
  const warnings = issues.filter(issue => issue.severity === "warning").length;
  return {
    kind: "pronunciation-check",
    summary: `Checked ${inspectedItems} lyric entries; ${warnings} warning(s). Phonetic correctness requires an audio-aware pronunciation service.`,
    data: { kind: "pronunciation-check", ok: errors === 0, inspectedItems, issues },
  };
}

function finite(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
