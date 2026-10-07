import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const python = process.env.SYNTHV_TOOLBOX_AUDIO_TEST_PYTHON;
assert.ok(python, "Set SYNTHV_TOOLBOX_AUDIO_TEST_PYTHON to an installed pi-audio runtime.");
const serviceUrl = process.env.COVER_AUDIO_MODULE ?? new URL("../src/PiDesktop.Tauri/electron/services/cover-audio.ts", import.meta.url).href;
const { createCoverAudio } = await import(serviceUrl);
const dataRoot = process.env.COVER_AUDIO_TEST_DATA_ROOT;
const root = dataRoot ? path.dirname(dataRoot) : await mkdtemp(path.join(os.tmpdir(), "cover-audio-e2e-"));
if (dataRoot) await mkdir(dataRoot, { recursive: true });
const managedDataRoot = dataRoot ?? path.join(root, "data");
const audioPath = path.join(root, "known-melody.wav");
const sampleRate = 22_050;
const frames = sampleRate * 6;
const pcm = Buffer.alloc(frames * 2);
for (let index = 0; index < frames; index += 1) {
  const seconds = index / sampleRate;
  const frequency = seconds < 2 ? 440 : seconds < 4 ? 523.25 : 659.25;
  const amplitude = seconds % 2 < 0.05 ? 0 : Math.sin(2 * Math.PI * frequency * seconds) * 0.52;
  pcm.writeInt16LE(Math.round(amplitude * 32767), index * 2);
}
const wav = Buffer.alloc(44 + pcm.length);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
await writeFile(audioPath, wav);

const original = await readFile(audioPath);
const workflow = createCoverAudio({ dataRoot: managedDataRoot, python });
const separation = await workflow.separate(audioPath);
assert.equal(separation.model, "htdemucs");
assert.ok(["mps", "cuda", "cpu"].includes(separation.device));
assert.ok((await stat(separation.vocalPath)).size > 44);
assert.ok((await stat(separation.instrumentalPath)).size > 44);
assert.deepEqual(await readFile(audioPath), original, "separation must preserve input bytes");

const extraction = await workflow.transcribeAndExtract(separation.vocalPath, { lyrics: "啊" });
assert.equal(extraction.timingBasis, "seconds");
assert.ok(extraction.noteCount > 0);
assert.ok(extraction.rawNoteCount >= extraction.noteCount);
assert.match(extraction.notesSha256, /^[a-f0-9]{64}$/u);
assert.deepEqual(await readFile(audioPath), original, "analysis must preserve input bytes");
const notes = JSON.parse(await readFile(extraction.notesPath, "utf8"));
const rawNotes = JSON.parse(await readFile(extraction.rawNotesPath, "utf8"));
assert.equal(notes.noteCount, extraction.noteCount);
assert.equal(rawNotes.noteCount, extraction.rawNoteCount);
assert.equal(notes.timingBasis, "seconds");
assert.ok(notes.notes.every(note => Number.isFinite(note.startSeconds) && Number.isFinite(note.endSeconds) && Number.isInteger(note.pitch)));
assert.ok(notes.transformations.confidenceHint);
assert.ok(JSON.parse(await readFile(extraction.segmentsPath, "utf8")).alignmentDescription.includes("without acoustic timing"));
assert.ok((await stat(extraction.midiPath)).size > 0);
assert.ok((await stat(extraction.lyricsPath)).size > 0);
assert.ok((await stat(extraction.analysisPath)).size > 0);
console.log(JSON.stringify({ model: separation.model, device: separation.device, noteCount: extraction.noteCount, rawNoteCount: extraction.rawNoteCount }));
