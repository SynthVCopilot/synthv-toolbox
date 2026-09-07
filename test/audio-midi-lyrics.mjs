import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const audio = readFileSync(join(root, "src", "PiDesktop.Tauri", "src-tauri", "components", "pi-audio", "pi_audio.py"), "utf8");
const workflows = readFileSync(join(root, "src", "PiDesktop.Tauri", "src-tauri", "src", "workflows.rs"), "utf8");
const commands = readFileSync(join(root, "src", "PiDesktop.Tauri", "src-tauri", "src", "commands.rs"), "utf8");

assert.match(audio, /WhisperModel\("small", device="cpu", compute_type="int8"\)/);
assert.match(audio, /word_timestamps=True/);
assert.match(audio, /midi\.charset = "utf-8"/);
assert.match(audio, /SynthVPhoneme\\0/);
assert.match(audio, /greatest-overlap recognized word/);
assert.match(audio, /dictionary_phoneme_words/);
assert.match(audio, /dictionary_missing_words/);
assert.match(audio, /d\.add_argument\("inst", nargs="\?"/);
assert.match(workflows, /pub fn audio_to_midi\(/);
assert.match(workflows, /ensure_audio_transcription_component/);
assert.match(workflows, /输出文件已存在/);
assert.match(commands, /instrumental_path: Option<String>/);
assert.match(commands, /output_directory: Option<String>/);
assert.match(commands, /phoneme_markers/);
console.log("Audio MIDI lyric and phoneme contracts passed.");
