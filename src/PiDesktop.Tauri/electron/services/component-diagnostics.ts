import { readFile } from "node:fs/promises";

type Issue = { code: string; severity: "warning" | "error"; message: string; location: string };
type Group = Record<string, unknown>;
type GroupOccurrence = { group: Group; offset: number; instrumental: boolean; location: string };
type GroupResolution = { occurrences: GroupOccurrence[]; issues: Issue[]; hasMainGroup: boolean };

export async function projectDoctor(projectPath: string) {
  const project = JSON.parse(await readFile(projectPath, "utf8")) as Record<string, unknown>;
  const tracks = arrayOfRecords(project.tracks);
  const groupsById = indexGroups(project, tracks);
  const issues: Issue[] = [];
  let inspectedItems = tracks.length;
  let noteCount = 0;
  if (tracks.length === 0) issues.push({ code: "TRACKS_EMPTY", severity: "error", message: "Project has no tracks.", location: "tracks" });

  tracks.forEach((track, trackIndex) => {
    const resolution = resolveTrackGroups(track, trackIndex, groupsById);
    issues.push(...resolution.issues);
    if (!resolution.hasMainGroup) issues.push({ code: "MAIN_GROUP_MISSING", severity: "error", message: "Track has no main note group.", location: "tracks[" + trackIndex + "].mainGroup" });

    for (const occurrence of resolution.occurrences) {
      const notes = arrayOfRecords(occurrence.group.notes);
      noteCount += notes.length;
      inspectedItems += notes.length;
      notes.forEach((note, noteIndex) => {
        const location = occurrence.location + ".notes[" + noteIndex + "]";
        const onset = finite(note.onset);
        const duration = finite(note.duration);
        const absoluteOnset = onset === undefined ? undefined : onset + occurrence.offset;
        if (absoluteOnset === undefined || !Number.isFinite(absoluteOnset) || duration === undefined || absoluteOnset < 0 || duration <= 0) {
          issues.push({ code: "NOTE_TIMING_INVALID", severity: "error", message: "Note onset or duration is invalid.", location });
        }
        if (!occurrence.instrumental && (typeof note.lyrics !== "string" || !note.lyrics.trim())) {
          issues.push({ code: "LYRIC_EMPTY", severity: "warning", message: "Vocal note has empty lyrics.", location });
        }
      });

      const parameters = occurrence.group.parameters && typeof occurrence.group.parameters === "object"
        ? occurrence.group.parameters as Record<string, unknown>
        : {};
      for (const [parameterName, curveValue] of Object.entries(parameters)) {
        inspectedItems += 1;
        const points = curveValue && typeof curveValue === "object" ? (curveValue as Record<string, unknown>).points : undefined;
        if (!Array.isArray(points)) {
          issues.push({ code: "PARAMETER_POINTS_INVALID", severity: "warning", message: "Parameter curve has no point list.", location: occurrence.location + ".parameters." + parameterName });
          continue;
        }
        points.forEach((point, pointIndex) => {
          const validArray = Array.isArray(point) && point.length >= 2 && finite(point[0]) !== undefined && finite(point[1]) !== undefined;
          const validObject = point && typeof point === "object" && finite((point as Record<string, unknown>).x) !== undefined && finite((point as Record<string, unknown>).y) !== undefined;
          if (!validArray && !validObject) issues.push({ code: "PARAMETER_POINT_INVALID", severity: "warning", message: "Parameter point coordinates are invalid.", location: occurrence.location + ".parameters." + parameterName + ".points[" + pointIndex + "]" });
        });
      }
    }
  });

  const version = finite(project.version);
  const errors = issues.filter(issue => issue.severity === "error").length;
  const warnings = issues.filter(issue => issue.severity === "warning").length;
  const summary = "Inspected " + tracks.length + " track(s) and " + noteCount + " note instance(s); found " + errors + " error(s) and " + warnings + " warning(s).";
  return {
    kind: "project-doctor",
    summary,
    data: {
      kind: "project-doctor",
      ok: errors === 0,
      summary,
      version,
      era: version === undefined ? "unknown" : version <= 134 ? "SV1" : version >= 153 ? "SV2" : "boundary(" + version + ")",
      trackCount: tracks.length,
      noteCount,
      inspectedItems,
      issues,
    },
  };
}

export async function pronunciationDiagnostics(projectPath?: string, lyrics?: string) {
  const issues: Issue[] = [];
  let inspectedItems = 0;
  if (projectPath) {
    const project = JSON.parse(await readFile(projectPath, "utf8")) as Record<string, unknown>;
    const tracks = arrayOfRecords(project.tracks);
    const groupsById = indexGroups(project, tracks);
    tracks.forEach((track, trackIndex) => {
      const resolution = resolveTrackGroups(track, trackIndex, groupsById);
      issues.push(...resolution.issues.map(issue => ({ ...issue, severity: "warning" as const })));
      for (const occurrence of resolution.occurrences) {
        if (occurrence.instrumental) continue;
        const notes = arrayOfRecords(occurrence.group.notes);
        notes.forEach((note, noteIndex) => {
          inspectedItems += 1;
          const lyric = typeof note.lyrics === "string" ? note.lyrics.trim() : "";
          if (!lyric || ["-", "+", "br", "sil", "sp", "ap"].includes(lyric.toLowerCase())) {
            issues.push({ code: "LYRIC_EMPTY_OR_CONTROL", severity: "warning", message: "Note has no pronounceable lyric text.", location: occurrence.location + ".notes[" + noteIndex + "]" });
          }
        });
      }
    });
  }
  if (lyrics !== undefined) {
    const entries = lyrics.split(/\r?\n/u).map((value, index) => ({ value: value.trim(), index })).filter(entry => entry.value.length > 0);
    inspectedItems += entries.length;
    entries.forEach(({ value, index }) => {
      if (/^[\p{P}\p{S}]+$/u.test(value)) issues.push({ code: "LYRIC_HAS_NO_LETTERS", severity: "warning", message: "Lyric line contains no letters or numbers.", location: "lyrics[" + index + "]" });
    });
  }
  if (!projectPath && lyrics === undefined) throw new Error("Provide projectPath or lyrics for pronunciation diagnostics.");
  const warnings = issues.filter(issue => issue.severity === "warning").length;
  return {
    kind: "pronunciation-check",
    summary: "Checked " + inspectedItems + " lyric entries; " + warnings + " warning(s). Phonetic correctness requires an audio-aware pronunciation service.",
    data: { kind: "pronunciation-check", ok: true, inspectedItems, issues },
  };
}

function resolveTrackGroups(track: Group, trackIndex: number, groupsById: Map<string, Group>): GroupResolution {
  const occurrences: GroupOccurrence[] = [];
  const issues: Issue[] = [];
  const prefix = "tracks[" + trackIndex + "]";
  const mainGroup = record(track.mainGroup);
  const mainRef = record(track.mainRef) ?? {};
  const hasMainGroup = mainGroup !== undefined;
  if (typeof mainRef.groupID === "string" && !groupsById.has(mainRef.groupID)) {
    issues.push({ code: "MAIN_GROUP_REFERENCE_UNRESOLVED", severity: "error", message: "Track main reference points to a missing note group.", location: prefix + ".mainRef.groupID" });
  }
  if (mainGroup) {
    const offset = readOffset(mainRef.blickOffset);
    if (offset.invalid) issues.push({ code: "MAIN_REFERENCE_OFFSET_INVALID", severity: "error", message: "Main group reference offset is invalid.", location: prefix + ".mainRef.blickOffset" });
    occurrences.push({
      group: mainGroup,
      offset: offset.value,
      instrumental: mainRef.isInstrumental === true,
      location: prefix + ".mainGroup@blickOffset=" + offset.value,
    });
  }

  const references = Array.isArray(track.groups) ? track.groups : [];
  references.forEach((value, referenceIndex) => {
    const reference = record(value);
    const groupId = typeof reference?.groupID === "string" ? reference.groupID : undefined;
    const location = prefix + ".groups[" + referenceIndex + "]";
    const offset = readOffset(reference?.blickOffset);
    if (offset.invalid) issues.push({ code: "GROUP_REFERENCE_OFFSET_INVALID", severity: "error", message: "Group reference offset is invalid.", location: location + ".blickOffset" });
    const group = groupId ? groupsById.get(groupId) : undefined;
    if (!group) {
      issues.push({ code: "GROUP_REFERENCE_UNRESOLVED", severity: "error", message: "Track refers to a missing note group.", location: location + ".groupID" });
      return;
    }
    occurrences.push({
      group,
      offset: offset.value,
      instrumental: reference?.isInstrumental === true,
      location: location + "@blickOffset=" + offset.value,
    });
  });
  return { occurrences, issues, hasMainGroup };
}

function indexGroups(project: Record<string, unknown>, tracks: Group[]): Map<string, Group> {
  const result = new Map<string, Group>();
  for (const group of arrayOfRecords(project.library)) {
    const id = groupId(group);
    if (id && !result.has(id)) result.set(id, group);
  }
  for (const track of tracks) {
    const group = record(track.mainGroup);
    const id = group ? groupId(group) : undefined;
    if (group && id && !result.has(id)) result.set(id, group);
  }
  return result;
}

function groupId(group: Group): string | undefined {
  for (const key of ["uuid", "groupID", "id"]) if (typeof group[key] === "string" && group[key]) return group[key] as string;
  return undefined;
}

function arrayOfRecords(value: unknown): Group[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is Group => item !== undefined) : [];
}

function record(value: unknown): Group | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Group : undefined;
}

function readOffset(value: unknown): { value: number; invalid: boolean } {
  if (value === undefined || value === null) return { value: 0, invalid: false };
  const offset = finite(value);
  return offset === undefined ? { value: 0, invalid: true } : { value: offset, invalid: false };
}

function finite(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
