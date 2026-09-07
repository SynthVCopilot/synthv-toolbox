import importlib.util
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "src/PiDesktop.Tauri/src-tauri/components/pi-audio/pi_audio.py"
SPEC = importlib.util.spec_from_file_location("pi_audio", SCRIPT)
pi_audio = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pi_audio)


class AudioMidiLyricsTests(unittest.TestCase):
    def test_supplied_lyrics_export_without_transcription(self):
        import mido
        with tempfile.TemporaryDirectory() as directory:
            lyrics = Path(directory) / "lyrics.txt"
            lyrics.write_text("hello", encoding="utf-8")
            output = Path(directory) / "manual.mid"
            args = SimpleNamespace(vocal="vocal.wav", inst=None, advanced=False,
                                   lyrics_file=str(lyrics), transcribe=False, midi=str(output),
                                   output_external=True, tol=0.08)
            with patch.object(pi_audio, "extract_notes", return_value=[{"pitch": 60, "start": 0, "end": 1, "velocity": 90}]), \
                 patch.object(pi_audio, "transcribe_words", side_effect=AssertionError("Unexpected transcription")):
                pi_audio.cmd_pair_diff(args)
            events = [event for track in mido.MidiFile(output, charset="utf-8").tracks for event in track]
            self.assertEqual([event.text for event in events if event.type == "lyrics"], ["hello"])

    def test_monophonic_output_has_no_tolerated_overlap(self):
        notes = [{"pitch": 67, "start": 0.0, "end": 0.5},
                 {"pitch": 65, "start": 0.485, "end": 1.0},
                 {"pitch": 72, "start": 0.52, "end": 1.1}]
        result = pi_audio.mono_collapse(notes)
        self.assertTrue(all(a["end"] <= b["start"] for a, b in zip(result, result[1:])))
        self.assertEqual(pi_audio.monophony_rate(result), 1.0)

    def test_melody_only_workflow_does_not_load_transcription(self):
        args = SimpleNamespace(vocal="vocal.wav", inst=None, advanced=False,
                               lyrics_file=None, transcribe=False, midi=None, tol=0.08)
        with patch.object(pi_audio, "extract_notes", return_value=[{"pitch": 60, "start": 0, "end": 1, "velocity": 90}]), \
             patch.object(pi_audio, "transcribe_words", side_effect=AssertionError("Unexpected transcription")):
            result = pi_audio.cmd_pair_diff(args)
        self.assertEqual(result["mono_notes"], 1)

    def test_syllables_and_melisma_follow_dictionary_pronunciation(self):
        for word, expected in [("world", ["world", "-", "-", "-"]),
                               ("hello", ["hello", "+", "-", "-"]),
                               ("beautiful", ["beautiful", "+", "+", "-"])]:
            notes = [{"start": index * 0.25, "end": (index + 1) * 0.25} for index in range(4)]
            markers, _ = pi_audio.map_transcription_to_notes([{"text": word, "start": 0, "end": 1}], notes, "en")
            self.assertEqual([marker["lyric"] for marker in markers], expected)

    def test_overlap_mapping_prefers_largest_word_and_preserves_extensions(self):
        words = [{"text": "hello", "start": 0.0, "end": 1.0}, {"text": "world", "start": 0.9, "end": 2.0}]
        notes = [{"start": 0.0, "end": 0.6}, {"start": 0.6, "end": 1.0}, {"start": 1.0, "end": 1.7}]
        markers, result = pi_audio.map_transcription_to_notes(words, notes, "en")
        self.assertEqual([marker["lyric"] for marker in markers], ["hello", "+", "world"])
        self.assertEqual(result["phoneme_markers"], 1)

    def test_writer_emits_utf8_lyrics_and_nul_phone_metadata_without_overwrite(self):
        import mido
        notes = [{"pitch": 60, "start": 0.0, "end": 0.5, "velocity": 90}, {"pitch": 60, "start": 0.5, "end": 1.0, "velocity": 90}]
        markers = [{"lyric": "你", "phoneset": "pinyin-tone3", "phoneme": "ni3"}, {"lyric": "+", "phoneset": None, "phoneme": None}]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "lyrics.mid"
            pi_audio.write_midi(output, notes, markers)
            events = [event for track in mido.MidiFile(output, charset="utf-8").tracks for event in track]
            self.assertIn("你", [event.text for event in events if event.type == "lyrics"])
            self.assertTrue(any(bytes(event.data).startswith(b"SynthVPhoneme\0") for event in events if event.type == "sequencer_specific"))
            with self.assertRaises(FileExistsError):
                pi_audio.write_midi(output, notes, markers)


if __name__ == "__main__":
    unittest.main()
