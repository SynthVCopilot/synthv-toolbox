# -*- coding: utf-8 -*-
"""pi-audio — Pi Agent 的音频探针组件（AI/人工均可用）。

子命令：
  probe <audio> [--panns] [--notes]
      浅层特征指纹（BPM/调/打击比/能量弧/音区分布）+ 可选 PANNs 判别
      （乐器构成、genre 倾向、有词/无词判别）。输出紧凑 JSON（stdout）。
      风格命名刻意留给上层 LLM：本工具只出结构化事实，不下审美结论。

  pair-diff <vocal> <inst> [--midi OUT.mid] [--tol 0.08] [--advanced]
      有词/无词配对差分：按 (pitch, start±tol) 消耗式匹配去除伴奏音符，
      残差=人声贡献；经"最高音抢占"单音化后可直接喂
      synthv-agent-bridge 的 import_monophonic_score（≤512 音符时）。

依赖：librosa / numpy / basic-pitch / pretty-midi；PANNs 判别需
torch(CPU 即可) + panns-inference。Python ≤3.11（basic-pitch 生态限制）。
"""
import argparse
import json
import sys

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# AudioSet 中的风格/情绪类标签（供相对排序；绝对概率普遍偏低，不可单独当结论）
GENREISH = {
    "Pop music", "Rock music", "Electronic music", "Classical music", "Jazz",
    "Hip hop music", "Soundtrack music", "Video game music", "Dance music",
    "Techno", "House music", "Trance music", "Ambient music", "New-age music",
    "Folk music", "Country", "Rhythm and blues", "Soul music", "Funk",
    "Heavy metal", "Punk rock", "Disco", "Electronica", "Electronic dance music",
    "Drum and bass", "Dubstep", "Progressive rock", "Music of Asia",
    "Traditional music", "Opera", "Swing music", "Blues", "Theme music",
    "Happy music", "Sad music", "Tender music", "Exciting music", "Angry music",
    "Scary music", "Music for children", "Lullaby",
}
INSTRUMENTISH = {
    "Piano", "Electric piano", "Acoustic guitar", "Electric guitar", "Bass guitar",
    "Drum kit", "Drum machine", "Synthesizer", "Violin, fiddle", "Cello",
    "Orchestra", "String section", "Brass instrument", "Trumpet", "Saxophone",
    "Flute", "Organ", "Harp", "Bell", "Marimba, xylophone", "Glockenspiel",
    "Choir", "Keyboard (musical)",
}
VOCALISH = {"Speech", "Singing", "Female singing", "Male singing", "Child singing", "Choir", "A capella"}


def note_name(p: int) -> str:
    return f"{NOTE_NAMES[p % 12]}{p // 12 - 1}"


def data_root():
    """统一数据根：~/.SynthVcopilot（模型/输出/配置/历史都在这个根下）。"""
    import pathlib

    return pathlib.Path.home() / ".SynthVcopilot"


def safe_output_path(name_or_rel: str, subdir: str = "output", suffix: str | None = None):
    """把（可能来自外部的）输出路径安全落到 ~/.SynthVcopilot/ 数据根下。

    规则：硬禁止 `..` 穿透；相对路径落到 `<root>/<subdir>/` 下；
    绝对路径仅当**已在数据根内**时放行（供 FFI 侧传入已圈定的路径），否则拒绝。
    可选强制扩展名。
    """
    import pathlib

    root = data_root()
    p = pathlib.PurePath(name_or_rel)
    if any(part == ".." for part in p.parts):
        raise ValueError(f"路径含 '..'，禁止穿透: {name_or_rel}")
    if p.is_absolute():
        resolved = pathlib.Path(name_or_rel).resolve()
        try:
            resolved.relative_to(root.resolve())
        except ValueError:
            raise ValueError(f"绝对路径不在数据根 {root} 内，拒绝: {name_or_rel}")
        out = resolved
    else:
        out = root / subdir / p
    out = pathlib.Path(out)
    if suffix and out.suffix.lower() != suffix:
        out = out.with_suffix(suffix)
    out.parent.mkdir(parents=True, exist_ok=True)
    return out


def _download(dest, url):
    import os
    import urllib.request

    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    print(f"downloading {os.path.basename(dest)} ...", file=sys.stderr)
    tmp = str(dest) + ".part"
    urllib.request.urlretrieve(url, tmp)
    os.replace(tmp, dest)


PANNS_CKPT_URL = "https://zenodo.org/record/3987831/files/Cnn14_mAP%3D0.431.pth?download=1"
PANNS_CSV_URL = "https://raw.githubusercontent.com/qiuqiangkong/audioset_tagging_cnn/master/metadata/class_labels_indices.csv"


def _ensure_panns_assets():
    """预置 PANNs 资产。checkpoint(~300MB) 放统一数据根 models/panns/ 下；
    标签 CSV 因 panns_inference 库在 import 时硬编码读 ~/panns_data/，只能放在
    该处（唯一的根外例外，~60KB，已在 README 说明）。
    下载用标准库 urllib（库自带的 wget 在 Windows 上不可用）。

    返回 checkpoint 绝对路径（显式传给 AudioTagging，避免库把大模型下到根外）。
    """
    import os

    models = data_root() / "models" / "panns"
    models.mkdir(parents=True, exist_ok=True)
    ckpt = models / "Cnn14_mAP=0.431.pth"
    _download(ckpt, PANNS_CKPT_URL)

    legacy = os.path.join(os.path.expanduser("~"), "panns_data")
    os.makedirs(legacy, exist_ok=True)
    _download(os.path.join(legacy, "class_labels_indices.csv"), PANNS_CSV_URL)
    return str(ckpt)


def extract_notes(path: str):
    """basic-pitch 音符提取 → [{pitch,start,end,velocity}]，按 start 排序。"""
    import contextlib

    from basic_pitch.inference import predict

    # basic-pitch 会往 stdout 打印进度行，污染本工具的纯 JSON 输出——改道 stderr。
    with contextlib.redirect_stdout(sys.stderr):
        _, _, note_events = predict(path)
    notes = [
        {
            "pitch": int(p),
            "start": round(float(s), 3),
            "end": round(float(e), 3),
            "velocity": int(a * 127),
        }
        for (s, e, p, a, _bends) in note_events
    ]
    notes.sort(key=lambda n: n["start"])
    return notes


def cmd_probe(args) -> dict:
    import librosa

    y, sr = librosa.load(args.audio, sr=22050, mono=True)
    duration = len(y) / sr

    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    tempo = float(np.atleast_1d(tempo)[0])

    harmonic, percussive = librosa.effects.hpss(y)
    h_rms = float(np.sqrt(np.mean(harmonic**2)))
    p_rms = float(np.sqrt(np.mean(percussive**2)))
    perc_ratio = p_rms / (h_rms + p_rms) if (h_rms + p_rms) > 0 else 0.0

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    key = NOTE_NAMES[int(np.argmax(chroma))]

    # 六段能量弧（0-9 归一化）；极短音频段可能为空 → 回退 0.0，避免 NaN→int 崩溃
    rms = librosa.feature.rms(y=y)[0]
    seg = np.array_split(rms, 6)
    seg_e = [float(np.mean(s)) if s.size else 0.0 for s in seg]
    mx = max(seg_e) or 1.0
    energy_arc = "".join(str(min(9, int(e / mx * 9.99))) for e in seg_e)
    epsilon = 1e-12
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    peak_dbfs = 20.0 * np.log10(max(peak, epsilon))
    rms_total = float(np.sqrt(np.mean(y**2))) if y.size else 0.0
    rms_dbfs = 20.0 * np.log10(max(rms_total, epsilon))
    clipped_ratio = float(np.mean(np.abs(y) >= 0.999)) if y.size else 0.0
    silent_frame_ratio = float(np.mean(rms <= 10 ** (-60 / 20))) if rms.size else 1.0
    energy_dbfs = [round(20.0 * np.log10(max(value, epsilon)), 1) for value in seg_e]

    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    half = len(centroid) // 2
    trend = float(np.mean(centroid[half:]) - np.mean(centroid[:half]))
    brightness = "rising" if trend > 150 else ("falling" if trend < -150 else "flat")

    result = {
        "tool": "pi-audio/probe",
        "audio": args.audio,
        "duration_sec": round(duration, 1),
        "bpm": round(tempo),
        "bpm_note": "beat-tracking 存在 2x/0.5x 歧义；有配对版本时以一致者为准",
        "key_guess": key,
        "percussive_ratio": round(perc_ratio, 3),
        "energy_arc_6seg": energy_arc,
        "energy_dbfs_6seg": energy_dbfs,
        "peak_dbfs": round(float(peak_dbfs), 2),
        "rms_dbfs": round(float(rms_dbfs), 2),
        "clipped_sample_ratio": round(clipped_ratio, 8),
        "silent_frame_ratio": round(silent_frame_ratio, 5),
        "brightness_trend": brightness,
    }

    if args.notes:
        notes = extract_notes(args.audio)
        pitches = [n["pitch"] for n in notes]
        octs: dict[int, int] = {}
        for p in pitches:
            octs[p // 12 - 1] = octs.get(p // 12 - 1, 0) + 1
        long_n = sum(1 for n in notes if n["end"] - n["start"] > 0.8)
        result["notes"] = {
            "total": len(notes),
            "per_minute": round(len(notes) / (duration / 60)) if duration else 0,
            "range": f"{note_name(min(pitches))}-{note_name(max(pitches))}" if pitches else None,
            "long_over_800ms": long_n,
            "octave_histogram": {f"O{o}": c for o, c in sorted(octs.items())},
        }

    if args.panns:
        import contextlib

        # panns_inference 的 import/构造会向 stdout 打印（Checkpoint path/Using CPU），
        # 且首次下载走 os.system('wget')（Windows 无 wget 会静默失败）——
        # 先用 urllib 预置资产（checkpoint 落统一数据根），再整体改道 stderr
        # 保证本工具 stdout 纯 JSON。
        ckpt_path = _ensure_panns_assets()
        with contextlib.redirect_stdout(sys.stderr):
            from panns_inference import AudioTagging
            from panns_inference.config import labels

            y32, _ = librosa.load(args.audio, sr=32000, mono=True)
            at = AudioTagging(checkpoint_path=ckpt_path, device="cpu")
            clipwise, _ = at.inference(y32[None, :])
        probs = clipwise[0]
        order = np.argsort(probs)[::-1]

        def pick(pool, k):
            return [
                {"label": labels[i], "p": round(float(probs[i]), 3)}
                for i in order
                if labels[i] in pool
            ][:k]

        vocal_p = float(sum(probs[i] for i, l in enumerate(labels) if l in VOCALISH))
        result["panns"] = {
            "instruments": pick(INSTRUMENTISH, 6),
            "genre_hints": pick(GENREISH, 6),
            "genre_note": "AudioSet genre 概率普遍偏低且对 VOCALOID 音色有儿歌偏置，仅供相对排序；风格命名交给上层 LLM 结合本 JSON 判断",
            "vocal_prob_sum": round(vocal_p, 3),
            # 实测样本分布（12 对中V样本，2026-08）：有词 ≥0.35，无词 ≤0.05。
            # 判决边界有意放宽留余量：≥0.2 判 vocal，≤0.08 判 instrumental，其余 uncertain。
            "has_vocals_verdict": "vocal" if vocal_p >= 0.2 else ("instrumental" if vocal_p <= 0.08 else "uncertain"),
        }

    return result


def diff_notes(vnotes, inotes, tol):
    """人声版音符中去除能在 INST 里按 (pitch, start±tol) 匹配到的（一对一消耗）。"""
    import bisect

    by_pitch: dict[int, list[float]] = {}
    for n in inotes:
        by_pitch.setdefault(n["pitch"], []).append(n["start"])
    for v in by_pitch.values():
        v.sort()
    residual, matched = [], 0
    for n in vnotes:
        starts = by_pitch.get(n["pitch"], [])
        i = bisect.bisect_left(starts, n["start"] - tol)
        if i < len(starts) and abs(starts[i] - n["start"]) <= tol:
            matched += 1
            starts.pop(i)
        else:
            residual.append(n)
    return residual, matched


def mono_collapse(notes):
    """扫描线单音化：任意时刻只留最高音；低音丢弃、前音截断；清除 <60ms 碎屑。

    注意：低于主线的和声声部会被丢弃——提取和声需按音高聚类分层，另行处理。
    """
    ns = sorted((dict(n) for n in notes), key=lambda n: (n["start"], -n["pitch"]))
    out = []
    for n in ns:
        if not out:
            out.append(n)
            continue
        last = out[-1]
        if n["start"] >= last["end"] - 0.02:
            out.append(n)
        elif n["pitch"] > last["pitch"]:
            last["end"] = max(last["start"] + 0.05, n["start"])
            out.append(n)
    return [n for n in out if n["end"] - n["start"] >= 0.06]


def monophony_rate(ns):
    if len(ns) < 2:
        return 1.0
    ns = sorted(ns, key=lambda n: n["start"])
    ok = sum(1 for a, b in zip(ns, ns[1:]) if a["end"] <= b["start"] + 0.02)
    return ok / (len(ns) - 1)


def _is_cjk(char: str) -> bool:
    code = ord(char)
    return (
        0x3400 <= code <= 0x4DBF
        or 0x4E00 <= code <= 0x9FFF
        or 0xF900 <= code <= 0xFAFF
        or 0x20000 <= code <= 0x2FA1F
    )


def tokenize_lyrics(text: str):
    """确定性歌词 token 化：CJK 逐字，拉丁/数字连续词，其他字符分隔。"""
    import unicodedata

    tokens = []
    word = []

    def flush_word():
        if word:
            tokens.append("".join(word))
            word.clear()

    for char in text:
        if _is_cjk(char):
            flush_word()
            tokens.append(char)
            continue
        category = unicodedata.category(char)
        if category[0] in {"L", "N"} and (
            category[0] == "N" or "LATIN" in unicodedata.name(char, "")
        ):
            word.append(char)
            continue
        # 空白、标点以及非拉丁/数字符号都不生成 token，并结束当前词。
        flush_word()
    flush_word()
    return tokens


def read_lyrics_file(path: str):
    """读取受限的 UTF-8 普通文件，拒绝符号链接和过大输入。"""
    import pathlib
    import stat

    file_path = pathlib.Path(path)
    try:
        info = file_path.lstat()
    except FileNotFoundError as exc:
        raise ValueError(f"歌词文件不存在: {path}") from exc
    if stat.S_ISLNK(info.st_mode):
        raise ValueError(f"歌词文件不得为符号链接: {path}")
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"歌词路径必须是普通文件: {path}")
    if info.st_size > 256 * 1024:
        raise ValueError(f"歌词文件超过 256 KiB 上限: {path}")
    try:
        return file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(f"歌词文件不是有效 UTF-8: {path}") from exc


def map_lyrics_to_notes(lyrics_file: str, notes):
    """按音符顺序映射歌词；未覆盖音符使用 Synthesizer V 的连字符占位。"""
    tokens = tokenize_lyrics(read_lyrics_file(lyrics_file))
    if len(tokens) > len(notes):
        raise ValueError(
            f"歌词 token 数量 ({len(tokens)}) 多于可用 mono notes ({len(notes)})"
        )
    mapped = tokens + ["-"] * (len(notes) - len(tokens))
    return mapped, {
        "lyric_tokens": len(tokens),
        "lyric_notes": len(notes),
        "lyric_fill_hyphens": len(notes) - len(tokens),
    }


def automatic_correct(notes):
    """Conservative melody cleanup used by the AI-mode advanced workflow.

    It corrects isolated octave slips only when the alternative is materially closer to
    the surrounding melody, joins near-contiguous repeated notes, and removes overlap
    fragments introduced by the correction. Every mutation is counted for review.
    """
    corrected = [dict(note) for note in sorted(notes, key=lambda note: note["start"])]
    octave_shifts = 0
    for index in range(1, len(corrected)):
        previous = corrected[index - 1]["pitch"]
        current = corrected[index]["pitch"]
        candidates = [current]
        if current - 12 >= 48:
            candidates.append(current - 12)
        if current + 12 <= 84:
            candidates.append(current + 12)
        best = min(candidates, key=lambda pitch: abs(pitch - previous))
        if best != current and abs(current - previous) - abs(best - previous) >= 7:
            corrected[index]["pitch"] = best
            octave_shifts += 1

    joined = []
    joined_notes = 0
    for note in corrected:
        if joined and note["pitch"] == joined[-1]["pitch"] and note["start"] - joined[-1]["end"] <= 0.10:
            joined[-1]["end"] = max(joined[-1]["end"], note["end"])
            joined[-1]["velocity"] = max(joined[-1].get("velocity", 90), note.get("velocity", 90))
            joined_notes += 1
        else:
            joined.append(note)

    cleaned = []
    overlap_trims = 0
    dropped_fragments = 0
    for index, note in enumerate(joined):
        if index + 1 < len(joined) and note["end"] > joined[index + 1]["start"]:
            note["end"] = max(note["start"], joined[index + 1]["start"])
            overlap_trims += 1
        if note["end"] - note["start"] < 0.06:
            dropped_fragments += 1
            continue
        cleaned.append(note)
    return cleaned, {
        "octave_shifts": octave_shifts,
        "joined_repeats": joined_notes,
        "overlap_trims": overlap_trims,
        "dropped_fragments": dropped_fragments,
    }


def advanced_pair_diff(vnotes, inotes, requested_tol):
    tolerances = sorted({round(max(0.02, min(0.25, requested_tol + delta)), 3)
                         for delta in (-0.04, -0.02, 0.0, 0.02, 0.04)})
    trials = []
    for tolerance in tolerances:
        residual, matched = diff_notes(vnotes, inotes, tolerance)
        in_range = [note for note in residual if 48 <= note["pitch"] <= 84]
        collapsed = mono_collapse(in_range)
        corrected, corrections = automatic_correct(collapsed)
        match_rate = matched / max(1, len(vnotes))
        coverage = min(1.0, len(corrected) / max(12.0, len(vnotes) * 0.35))
        separation = max(0.0, 1.0 - abs(match_rate - 0.55) / 0.55)
        correction_ratio = sum(corrections.values()) / max(1, len(collapsed))
        score = 0.48 * coverage + 0.32 * separation + 0.20 * max(0.0, 1.0 - correction_ratio)
        trials.append({
            "tolerance": tolerance,
            "score": score,
            "residual": residual,
            "matched": matched,
            "in_range": in_range,
            "mono": corrected,
            "corrections": corrections,
        })

    counts = [len(trial["mono"]) for trial in trials]
    stability = 1.0 - ((max(counts) - min(counts)) / max(1, max(counts)))
    for trial in trials:
        trial["score"] = 0.82 * trial["score"] + 0.18 * stability
    selected = max(trials, key=lambda trial: (trial["score"], -abs(trial["tolerance"] - requested_tol)))
    confidence = max(0.0, min(1.0, selected["score"]))
    level = "high" if confidence >= 0.78 else ("medium" if confidence >= 0.55 else "low")
    public_trials = [{
        "tolerance": trial["tolerance"],
        "mono_notes": len(trial["mono"]),
        "match_rate": round(trial["matched"] / max(1, len(vnotes)), 3),
        "score": round(trial["score"], 3),
    } for trial in trials]
    return selected, {
        "score": round(confidence, 3),
        "level": level,
        "tolerance_stability": round(stability, 3),
        "checks": {
            "has_output": bool(selected["mono"]),
            "within_sv_import_limit": len(selected["mono"]) <= 512,
            "correction_ratio": round(min(1.0, sum(selected["corrections"].values()) / max(1, len(selected["mono"]))), 3),
        },
    }, public_trials


def cmd_pair_diff(args) -> dict:
    vnotes = extract_notes(args.vocal)
    inotes = extract_notes(args.inst)
    advanced = None
    if args.advanced:
        selected, confidence, trials = advanced_pair_diff(vnotes, inotes, args.tol)
        residual = selected["residual"]
        matched = selected["matched"]
        in_range = selected["in_range"]
        mono = selected["mono"]
        selected_tolerance = selected["tolerance"]
        advanced = {
            "requested_tolerance": args.tol,
            "selected_tolerance": selected_tolerance,
            "automatic_corrections": selected["corrections"],
            "confidence": confidence,
            "parameter_trials": trials,
        }
    else:
        residual, matched = diff_notes(vnotes, inotes, args.tol)
        in_range = [n for n in residual if 48 <= n["pitch"] <= 84]  # C3–C6
        mono = mono_collapse(in_range)
        selected_tolerance = args.tol

    lyric_texts = None
    lyric_result = {
        "lyric_tokens": 0,
        "lyric_notes": 0,
        "lyric_fill_hyphens": 0,
    }
    if args.lyrics_file:
        lyric_texts, lyric_result = map_lyrics_to_notes(args.lyrics_file, mono)

    result = {
        "tool": "pi-audio/pair-diff",
        "vocal": args.vocal,
        "inst": args.inst,
        "vocal_notes": len(vnotes),
        "inst_notes": len(inotes),
        "matched_to_inst": matched,
        "match_rate": round(matched / max(1, len(vnotes)), 2),
        "selected_tolerance": selected_tolerance,
        "residual": len(residual),
        "residual_in_C3_C6": len(in_range),
        "mono_notes": len(mono),
        "mono_rate": round(monophony_rate(mono), 2),
        "sv_importable_whole": len(mono) <= 512,  # import_monophonic_score 上限
        "note": "残差含和声/混音差异；单音化保留最高声部，低声部和声会被丢弃",
    }
    result.update(lyric_result)
    if args.lyrics_file:
        result["lyrics_file"] = args.lyrics_file
    if advanced is not None:
        result["advanced"] = advanced
    if mono:
        ps = [n["pitch"] for n in mono]
        result["mono_range"] = f"{note_name(min(ps))}-{note_name(max(ps))}"

    if args.midi:
        import pretty_midi

        # 统一写入纪律：MIDI 只落 ~/.SynthVcopilot/output/ 下，禁止 .. 穿透与绝对路径。
        out_path = safe_output_path(args.midi, subdir="output", suffix=".mid")
        pm = pretty_midi.PrettyMIDI()
        instr = pretty_midi.Instrument(program=54, name="vocal-mono")
        for n in mono:
            instr.notes.append(
                pretty_midi.Note(
                    velocity=max(1, min(127, int(n.get("velocity", 90)))),
                    pitch=n["pitch"],
                    start=n["start"],
                    end=n["end"],
                )
            )
        pm.instruments.append(instr)
        if lyric_texts is not None:
            pm.lyrics.extend(
                pretty_midi.Lyric(text, n["start"])
                for text, n in zip(lyric_texts, mono)
            )
        pm.write(str(out_path))
        result["midi_out"] = str(out_path)

    return result


def main():
    ap = argparse.ArgumentParser(prog="pi-audio", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("probe", help="特征指纹 + 可选 PANNs 判别")
    p.add_argument("audio")
    p.add_argument("--panns", action="store_true", help="加 PANNs 乐器/genre/有词判别（需 torch）")
    p.add_argument("--notes", action="store_true", help="加 basic-pitch 音符统计（慢 ~20s）")
    p.set_defaults(fn=cmd_probe)

    d = sub.add_parser("pair-diff", help="有词/无词配对差分 → 单音人声轨")
    d.add_argument("vocal")
    d.add_argument("inst")
    d.add_argument("--midi", help="导出单音化 MIDI 路径")
    d.add_argument("--tol", type=float, default=0.08, help="起始时间匹配容差秒 (默认 0.08)")
    d.add_argument("--advanced", action="store_true", help="多容差寻优、保守自动纠正与置信度检查")
    d.add_argument(
        "--lyrics-file",
        help="UTF-8 歌词文本（普通文件、非符号链接，最大 256 KiB）",
    )
    d.set_defaults(fn=cmd_pair_diff)

    args = ap.parse_args()
    try:
        print(json.dumps(args.fn(args), ensure_ascii=False, indent=1))
    except Exception as e:  # 出错也保证输出合法 JSON，方便 agent 消费
        print(json.dumps({"tool": "pi-audio", "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
