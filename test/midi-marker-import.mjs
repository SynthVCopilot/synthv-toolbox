import assert from "node:assert/strict";
import test from "node:test";

import { importMidiMonophonic, SYNTHV_QUARTER_BLICKS } from "../src/PiDesktop.Tauri/src-tauri/components/synthv-agent-bridge/dist/src/score-import.js";

function variableLength(value) {
  const bytes = [value & 0x7f];
  for (let remaining = Math.floor(value / 128); remaining > 0; remaining = Math.floor(remaining / 128)) {
    bytes.unshift((remaining & 0x7f) | 0x80);
  }
  return bytes;
}

function uint16(value) {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function uint32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function meta(delta, type, text) {
  const data = Buffer.from(text, "utf8");
  return [...variableLength(delta), 0xff, type, ...variableLength(data.length), ...data];
}

function midiFile(tracks) {
  const bytes = [...Buffer.from("MThd"), ...uint32(6), ...uint16(1), ...uint16(tracks.length), ...uint16(480)];
  for (const track of tracks) {
    bytes.push(...Buffer.from("MTrk"), ...uint32(track.length), ...track);
  }
  return Uint8Array.from(bytes);
}

test("imports lyrics from a metadata track and applies only a verified language override", () => {
  const metadataTrack = [
    ...meta(0, 0x05, "ni"),
    ...meta(0, 0x7f, "SynthVPhoneme\0pinyin-tone3\0ni3"),
    ...meta(480, 0x05, "hao"),
    ...meta(0, 0x7f, "SynthVPhoneme\0pinyin-tone3\0hao3"),
    ...meta(0, 0x2f, ""),
  ];
  const melodyTrack = [
    0x00, 0x90, 60, 100,
    ...variableLength(480), 60, 0,
    0x00, 0x90, 62, 100,
    ...variableLength(480), 62, 0,
    ...meta(0, 0x2f, ""),
  ];

  assert.deepEqual(importMidiMonophonic(midiFile([metadataTrack, melodyTrack]), { trackIndex: 2, channel: 1 }).notes, [
    { onset: 0, duration: SYNTHV_QUARTER_BLICKS, pitch: 60, lyrics: "ni", languageOverride: "mandarin" },
    { onset: SYNTHV_QUARTER_BLICKS, duration: SYNTHV_QUARTER_BLICKS, pitch: 62, lyrics: "hao", languageOverride: "mandarin" },
  ]);
});

test("does not borrow lyrics from another melodic track", () => {
  const selectedTrack = [
    0x00, 0x90, 60, 100,
    ...variableLength(480), 60, 0,
    ...meta(0, 0x2f, ""),
  ];
  const otherMelody = [
    ...meta(0, 0x05, "wrong"),
    0x00, 0x91, 67, 100,
    ...variableLength(480), 67, 0,
    ...meta(0, 0x2f, ""),
  ];

  assert.deepEqual(importMidiMonophonic(midiFile([selectedTrack, otherMelody]), { trackIndex: 1, channel: 1 }).notes, [
    { onset: 0, duration: SYNTHV_QUARTER_BLICKS, pitch: 60 },
  ]);
});

test("normalizes verified English ARPAbet markers into SynthV phoneme overrides", () => {
  const track = [
    ...meta(0, 0x05, "hello"),
    ...meta(0, 0x7f, "SynthVPhoneme\0arpabet\0HH AH0 L OW1"),
    0x00, 0x90, 60, 100,
    ...variableLength(480), 60, 0,
    ...meta(0, 0x2f, ""),
  ];

  assert.deepEqual(importMidiMonophonic(midiFile([track]), { trackIndex: 1, channel: 1 }).notes, [
    {
      onset: 0,
      duration: SYNTHV_QUARTER_BLICKS,
      pitch: 60,
      lyrics: "hello",
      languageOverride: "english",
      phonemes: "hh ah l ow",
    },
  ]);
});

test("rejects an English phoneme override containing a symbol outside the installed phoneset", () => {
  const track = [
    ...meta(0, 0x05, "hello"),
    ...meta(0, 0x7f, "SynthVPhoneme\0arpabet\0HH INVALID"),
    0x00, 0x90, 60, 100,
    ...variableLength(480), 60, 0,
    ...meta(0, 0x2f, ""),
  ];
  const imported = importMidiMonophonic(midiFile([track]), { trackIndex: 1, channel: 1 });

  assert.deepEqual(imported.notes, [{
    onset: 0,
    duration: SYNTHV_QUARTER_BLICKS,
    pitch: 60,
    lyrics: "hello",
    languageOverride: "english",
  }]);
  assert.deepEqual(imported.warnings, [
    "Ignored 1 MIDI phoneme marker(s) with an unsupported phoneset or phoneme sequence.",
  ]);
});
