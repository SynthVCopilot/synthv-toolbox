import {
  importScoreSnapshotMonophonic,
  inspectScoreSnapshot,
  readLocalScoreSnapshot,
} from "../dist/src/score-import.js";

const filePath = process.argv[2];
if (typeof filePath !== "string" || filePath.length === 0) {
  throw new Error("Usage: node scripts/cover-score-notes.mjs /absolute/path/to/cover.mid");
}

const snapshot = await readLocalScoreSnapshot(filePath);
const inspection = inspectScoreSnapshot(snapshot);
if (inspection.format !== "midi") {
  throw new Error("Cover score conversion accepts the generated MIDI file only.");
}

const tracks = inspection.tracks.filter((track) => track.noteCount > 0);
if (tracks.length !== 1) {
  throw new Error("Generated Cover MIDI must contain exactly one non-empty track.");
}
const [track] = tracks;
if (track.channels.length !== 1) {
  throw new Error("Generated Cover MIDI must contain exactly one active channel.");
}

const imported = importScoreSnapshotMonophonic(
  snapshot,
  { trackIndex: track.trackIndex, channel: track.channels[0].channel },
  snapshot.fileFingerprint,
  { defaultLyric: "la" },
);
process.stdout.write(
  `${JSON.stringify({
    sourcePath: imported.sourcePath,
    fileFingerprint: imported.fileFingerprint,
    notes: imported.notes,
    noteCount: imported.notes.length,
    tempoMap: imported.tempoMap,
    warnings: imported.warnings,
  })}\n`,
);
