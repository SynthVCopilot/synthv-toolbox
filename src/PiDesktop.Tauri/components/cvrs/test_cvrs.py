import copy
import json
import pathlib
import tempfile
import types
import unittest
from unittest import mock

import cvrs


Q = cvrs.QUARTER_BLICKS


def fixture():
    return {
        "version": 187,
        "time": {
            "tempo": [
                {"position": 0, "bpm": 120.0},
                {"position": 4 * Q, "bpm": 60.0},
            ]
        },
        "library": [
            {
                "uuid": "library-group",
                "notes": [
                    {"onset": 0, "duration": Q, "lyrics": "世"},
                    {"onset": Q, "duration": Q, "lyrics": "界"},
                ],
                "parameters": {
                    "tension": {"mode": "linear", "points": [[0, 0.1]]}
                },
                "pitchControls": [{"position": 0, "pitch": 0.2}],
                "vocalModes": {"Airy": {"pitch": 10}},
            }
        ],
        "tracks": [
            {
                "name": "主唱",
                "mainGroup": {
                    "uuid": "main-group",
                    "notes": [
                        {"onset": 0, "duration": Q, "lyrics": "你", "attributes": {"vibratoDepth": 0.4}},
                        {"onset": Q, "duration": Q, "lyrics": "好"},
                        {"onset": 5 * Q, "duration": Q, "lyrics": "again"},
                    ],
                    "parameters": {
                        "pitchDelta": {"mode": "cubic", "points": [[0, 10], [Q, -5]]},
                        "loudness": {"mode": "linear", "points": []},
                    },
                    "pitchControls": [{"position": Q, "pitch": 0.1}],
                    "vocalModes": {"Power": {"timbre": 20}},
                },
                "mainRef": {"groupID": "main-group", "blickOffset": 0},
                "groups": [
                    {"groupID": "library-group", "blickOffset": 7 * Q}
                ],
            }
        ],
    }


class CvrsTests(unittest.TestCase):
    def test_strip_parameters_preserves_score_and_voice(self):
        project = fixture()
        original_notes = copy.deepcopy(project["tracks"][0]["mainGroup"]["notes"])

        counts = cvrs.strip_group_parameters(project)

        self.assertEqual(counts, {
            "groups": 2,
            "parameterCurves": 2,
            "parameterPoints": 3,
            "pitchControls": 2,
        })
        main = project["tracks"][0]["mainGroup"]
        library = project["library"][0]
        self.assertEqual(main["parameters"]["pitchDelta"]["points"], [])
        self.assertEqual(library["parameters"]["tension"]["points"], [])
        self.assertEqual(main["pitchControls"], [])
        self.assertEqual(library["pitchControls"], [])
        self.assertEqual(main["notes"], original_notes)
        self.assertEqual(main["vocalModes"], {"Power": {"timbre": 20}})
        self.assertEqual(library["vocalModes"], {"Airy": {"pitch": 10}})

    def test_blick_conversion_integrates_tempo_changes(self):
        marks = cvrs.tempo_marks(fixture())
        self.assertAlmostEqual(cvrs.blick_to_seconds(4 * Q, marks), 2.0)
        self.assertAlmostEqual(cvrs.blick_to_seconds(5 * Q, marks), 3.0)
        self.assertAlmostEqual(cvrs.blick_to_seconds(8 * Q, marks), 6.0)

    def test_lrc_includes_main_and_referenced_groups(self):
        notes, diagnostics = cvrs.lyric_notes_for_track(fixture(), 1)
        phrases = cvrs.lyric_phrases(notes, 0.8)

        self.assertEqual([note["text"] for note in notes if note["text"]], ["你", "好", "again", "世", "界"])
        self.assertEqual(diagnostics["unresolvedReferences"], 0)
        self.assertEqual(len(phrases), 3)
        self.assertEqual(
            cvrs.render_lrc(phrases),
            "[00:00.00]你好\n[00:03.00]again\n[00:05.00]世界\n",
        )
        self.assertEqual(
            cvrs.render_lrc(phrases, enhanced=True),
            "[00:00.00]<00:00.00>你<00:00.50>好\n"
            "[00:03.00]<00:03.00>again\n"
            "[00:05.00]<00:05.00>世<00:06.00>界\n",
        )

    def test_ascii_lyrics_receive_readable_spaces(self):
        phrases = [[
            {"text": "hello", "start": 0.0},
            {"text": "world", "start": 0.5},
        ]]
        self.assertEqual(cvrs.render_lrc(phrases), "[00:00.00]hello world\n")

    def test_track_index_is_one_based_and_checked(self):
        with self.assertRaisesRegex(ValueError, "共有 1 条轨道"):
            cvrs.lyric_notes_for_track(fixture(), 2)

    def test_commands_write_managed_outputs_without_touching_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "source.svp"
            source_text = json.dumps(fixture(), ensure_ascii=False)
            source.write_text(source_text, encoding="utf-8")
            with mock.patch.object(cvrs, "data_root", return_value=root / "data"):
                stripped = cvrs.cmd_strip_params(types.SimpleNamespace(
                    svp=str(source),
                    out="clean.svp",
                ))
                lyrics = cvrs.cmd_export_lrc(types.SimpleNamespace(
                    svp=str(source),
                    track_index=1,
                    line_gap_seconds=0.8,
                    out="song.lrc",
                    word_out="song.word.lrc",
                ))

            self.assertEqual(source.read_text(encoding="utf-8"), source_text)
            self.assertTrue(pathlib.Path(stripped["out"]).is_file())
            self.assertEqual(
                pathlib.Path(lyrics["lrcOut"]).read_text(encoding="utf-8"),
                "[00:00.00]你好\n[00:03.00]again\n[00:05.00]世界\n",
            )
            self.assertIn("<00:00.50>好", pathlib.Path(lyrics["wordLrcOut"]).read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
