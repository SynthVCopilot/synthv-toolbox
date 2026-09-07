import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "src/PiDesktop.Tauri/src-tauri/components/pi-audio/pi_audio.py"
SPEC = importlib.util.spec_from_file_location("pi_audio", SCRIPT)
pi_audio = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pi_audio)


class AudioMidiLyricsTests(unittest.TestCase):
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
