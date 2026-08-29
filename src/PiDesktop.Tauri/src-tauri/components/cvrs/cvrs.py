# -*- coding: utf-8 -*-
"""cvrs — SynthV 工程离线工具（.svp 文件级）。

背景：SV1(format ≤~134) 与 SV2(≥153) 的 .svp 唱法/参数语义不兼容，
且桥的 Lua API 不能渲染音频/保存工程。CVRS 因此走 **.svp 文件级**：
把跨版本的**渲染结果(wav)**当作一条**静音 instrumental 参考轨**写进目标工程，
**绝不跨版本翻译可编辑唱法语义**（跨界直译必坏）。

子命令：
  probe <svp>
      只读结构探针：format version → SV1/SV2 时代 → 轨列表（名/音符数/是否
      instrumental/是否静音/音频文件）+ 版本特征标记。不翻译任何唱法数据。

  add-ref <target.svp> --audio <wav> [--name N] [--begin-seconds S] [--out FILE]
      把 wav 作为静音参考音频轨写进目标工程。为保证 schema 与目标版本完全一致，
      从目标自身克隆一个空轨壳（清空所有音符/参数/唱法），只填 isInstrumental+
      audio+mute。输出默认落 ~/.SynthVcopilot/output/ 下（禁 .. 穿透、不覆盖源）。

  strip-params <svp> [--out FILE]
      生成无参工程副本：清空所有音符组的自动化点和 Smart Pitch 控制，保留音符、
      歌词、音素、歌手/声线设置与时间轴。

  export-lrc <svp> [--track-index N] [--line-gap-seconds S]
      从指定的 1-based 轨道同时生成普通 LRC 和带内嵌起音标签的逐字 LRC。

依赖：标准库即可；wav 时长探测可选用 ffprobe（在 PATH 时自动使用）。
"""
import argparse
import copy
import json
import math
import pathlib
import subprocess
import sys
import uuid

sys.stdout.reconfigure(encoding="utf-8")

# format version → SV 时代边界（见 agents_memory Pi_Agent/002 普查）
SV1_MAX = 134  # 含
SV2_MIN = 153
QUARTER_BLICKS = 705_600_000
CONTROL_LYRICS = {"", "-", "+", "br", "sil", "sp", "ap"}


def data_root() -> pathlib.Path:
    return pathlib.Path.home() / ".SynthVcopilot"


def safe_output_path(name_or_rel: str, subdir: str = "output", suffix: str | None = None) -> pathlib.Path:
    """输出落 ~/.SynthVcopilot/ 数据根；硬禁 '..' 穿透；绝对路径仅根内放行。"""
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


def load_svp(path: str):
    """容错读 .svp：去 BOM、去尾部 NUL/垃圾（老文件常见）。"""
    raw = pathlib.Path(path).read_bytes()
    if raw[:3] == b"\xef\xbb\xbf":
        raw = raw[3:]
    text = raw.decode("utf-8", errors="replace").rstrip("\x00").strip()
    obj, _end = json.JSONDecoder().raw_decode(text)
    return obj


def write_svp(project: dict, output_path: pathlib.Path) -> None:
    """按 SynthV 的单行、UTF-8、无 BOM 习惯写出工程。"""
    output_path.write_text(
        json.dumps(project, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def ensure_distinct_output(source: str, output_path: pathlib.Path) -> None:
    if pathlib.Path(source).resolve() == output_path.resolve():
        raise ValueError("输出路径与源工程相同；拒绝覆盖源工程")


def era(version) -> str:
    if version is None:
        return "unknown"
    if version <= SV1_MAX:
        return "SV1"
    if version >= SV2_MIN:
        return "SV2"
    return f"boundary({version})"


def ffprobe_duration(wav: str):
    """有 ffprobe 就取时长秒，否则 None。"""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "default=nk=1:nw=1", wav],
            capture_output=True, text=True, timeout=30,
        )
        return round(float(out.stdout.strip()), 6)
    except Exception:
        return None


def cmd_probe(args) -> dict:
    d = load_svp(args.svp)
    ver = d.get("version")
    tracks = []
    for t in d.get("tracks", []):
        mref = t.get("mainRef") or {}
        mixer = t.get("mixer", {})
        audio = mref.get("audio")
        tracks.append({
            "name": t.get("name"),
            "notes": len((t.get("mainGroup") or {}).get("notes") or []),
            "isInstrumental": bool(mref.get("isInstrumental")),
            "muted": bool(mixer.get("mute") or mref.get("mute")),
            "audioFile": audio.get("filename") if isinstance(audio, dict) else None,
        })
    markers = {
        "group_vocalModes": "vocalModes" in ((d.get("tracks") or [{}])[0].get("mainGroup") or {}),
        "pitchControls": "pitchControls" in ((d.get("tracks") or [{}])[0].get("mainGroup") or {}),
        "startTimeSeconds": "startTimeSeconds" in (d.get("time") or {}),
        "exportPitch": "exportPitch" in (d.get("renderConfig") or {}),
    }
    return {
        "tool": "cvrs/probe",
        "svp": args.svp,
        "version": ver,
        "era": era(ver),
        "trackCount": len(tracks),
        "tracks": tracks,
        "formatMarkers": markers,
        "note": "只读结构探针；不翻译异版本唱法/参数语义（跨界不安全）",
    }


def empty_shell_from(target: dict) -> dict:
    """从目标工程克隆一个轨结构、清空成空 instrumental 壳，保证 schema 与目标版本一致。

    这是'只写不读'纪律下唯一读取目标结构的地方：只搬骨架，清掉全部音符/参数/唱法数据。
    """
    tracks = target.get("tracks") or []
    if not tracks:
        raise ValueError("目标工程没有任何轨，无法克隆 schema 模板")
    shell = copy.deepcopy(tracks[0])
    mg = shell.get("mainGroup") or {}
    mg["notes"] = []
    mg["uuid"] = str(uuid.uuid4())
    # 清空所有参数曲线（保留键与 mode，符合目标版本 schema）
    for pk, pv in (mg.get("parameters") or {}).items():
        if isinstance(pv, dict) and "points" in pv:
            pv["points"] = []
    if "vocalModes" in mg:
        mg["vocalModes"] = {}
    if "pitchControls" in mg:
        mg["pitchControls"] = []
    shell["mainGroup"] = mg
    shell["groups"] = []
    return shell


def iter_note_groups(value):
    """遍历主 Group、library Group，以及新版本可能增加的嵌套 Group。"""
    if isinstance(value, dict):
        if isinstance(value.get("notes"), list):
            yield value
        for child in value.values():
            yield from iter_note_groups(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_note_groups(child)


def strip_group_parameters(project: dict) -> dict:
    """原地清空 Group Automation 与 Smart Pitch，返回可审计计数。"""
    group_count = 0
    curve_count = 0
    point_count = 0
    pitch_control_count = 0
    for group in iter_note_groups(project):
        group_count += 1
        parameters = group.get("parameters")
        if isinstance(parameters, dict):
            for curve in parameters.values():
                if not isinstance(curve, dict) or not isinstance(curve.get("points"), list):
                    continue
                points = curve["points"]
                if points:
                    curve_count += 1
                    point_count += len(points)
                    curve["points"] = []
        controls = group.get("pitchControls")
        if isinstance(controls, list) and controls:
            pitch_control_count += len(controls)
            group["pitchControls"] = []
    return {
        "groups": group_count,
        "parameterCurves": curve_count,
        "parameterPoints": point_count,
        "pitchControls": pitch_control_count,
    }


def cmd_strip_params(args) -> dict:
    d = load_svp(args.svp)
    counts = strip_group_parameters(d)
    out_name = args.out or (pathlib.Path(args.svp).stem + "_no_params.svp")
    out_path = safe_output_path(out_name, subdir="output", suffix=".svp")
    ensure_distinct_output(args.svp, out_path)
    write_svp(d, out_path)
    return {
        "tool": "cvrs/strip-params",
        "source": args.svp,
        "source_version": d.get("version"),
        "source_era": era(d.get("version")),
        "out": str(out_path),
        "cleared": counts,
        "note": "已清空自动化参数点与 Smart Pitch 控制；音符、歌词、音素、歌手/声线和时间轴保持不变，源工程未修改。",
    }


def finite_number(value, default=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    number = float(value)
    return number if math.isfinite(number) else default


def tempo_marks(project: dict) -> list[tuple[float, float]]:
    marks = []
    raw_marks = (project.get("time") or {}).get("tempo") or []
    if isinstance(raw_marks, list):
        for mark in raw_marks:
            if not isinstance(mark, dict):
                continue
            position = finite_number(mark.get("position"))
            bpm = finite_number(mark.get("bpm"))
            if position is not None and bpm is not None and bpm > 0:
                marks.append((position, bpm))
    marks.sort(key=lambda item: item[0])
    deduplicated = []
    for position, bpm in marks:
        if deduplicated and deduplicated[-1][0] == position:
            deduplicated[-1] = (position, bpm)
        else:
            deduplicated.append((position, bpm))
    return deduplicated


def bpm_at(marks: list[tuple[float, float]], position: float) -> float:
    active = marks[0][1] if marks else 120.0
    for mark_position, bpm in marks:
        if mark_position > position:
            break
        active = bpm
    return active


def blick_to_seconds(position: float, marks: list[tuple[float, float]]) -> float:
    """按速度标记分段积分；兼容 0 之前的 Group 偏移。"""
    if position == 0:
        return 0.0
    begin, end = (0.0, position) if position > 0 else (position, 0.0)
    boundaries = [begin]
    boundaries.extend(mark_position for mark_position, _ in marks if begin < mark_position < end)
    boundaries.append(end)
    seconds = 0.0
    for left, right in zip(boundaries, boundaries[1:]):
        seconds += ((right - left) / QUARTER_BLICKS) * (60.0 / bpm_at(marks, left))
    return seconds if position > 0 else -seconds


def group_map(project: dict) -> dict[str, dict]:
    result = {}
    for group in iter_note_groups(project):
        group_id = group.get("uuid") or group.get("groupID") or group.get("id")
        if isinstance(group_id, str) and group_id:
            result[group_id] = group
    return result


def clean_lyric(value) -> tuple[str, bool]:
    if not isinstance(value, str):
        return "", False
    break_before = "\n" in value or "\r" in value
    text = " ".join(value.replace("\r", "\n").splitlines()).strip()
    if text.casefold() in CONTROL_LYRICS:
        return "", break_before
    return text, break_before


def lyric_notes_for_track(project: dict, track_index: int) -> tuple[list[dict], dict]:
    tracks = project.get("tracks") or []
    if not isinstance(tracks, list) or not 1 <= track_index <= len(tracks):
        raise ValueError(f"歌词轨道编号超出范围：工程共有 {len(tracks)} 条轨道")
    track = tracks[track_index - 1]
    if not isinstance(track, dict):
        raise ValueError("歌词轨道结构无效")

    groups_by_id = group_map(project)
    references = [(track.get("mainRef") or {}, track.get("mainGroup"))]
    for reference in track.get("groups") or []:
        if not isinstance(reference, dict):
            continue
        group = reference.get("group")
        if not isinstance(group, dict):
            group = groups_by_id.get(reference.get("groupID"))
        if not isinstance(group, dict) and isinstance(reference.get("notes"), list):
            group = reference
        references.append((reference, group))

    marks = tempo_marks(project)
    notes = []
    unresolved_references = 0
    skipped_control_notes = 0
    for reference, group in references:
        if reference.get("isInstrumental") or not isinstance(group, dict):
            if not reference.get("isInstrumental") and group is None:
                unresolved_references += 1
            continue
        offset = finite_number(reference.get("blickOffset"), 0.0) or 0.0
        absolute_begin = finite_number(reference.get("blickAbsoluteBegin"))
        absolute_end = finite_number(reference.get("blickAbsoluteEnd"))
        for note in group.get("notes") or []:
            if not isinstance(note, dict):
                continue
            onset = finite_number(note.get("onset"))
            duration = finite_number(note.get("duration"))
            if onset is None or duration is None or duration <= 0:
                continue
            absolute_onset = onset + offset
            absolute_note_end = absolute_onset + duration
            if absolute_begin is not None and absolute_note_end <= absolute_begin:
                continue
            if absolute_end is not None and absolute_end >= 0 and absolute_onset >= absolute_end:
                continue
            text, break_before = clean_lyric(note.get("lyrics"))
            if not text:
                skipped_control_notes += 1
            notes.append({
                "text": text,
                "startBlick": absolute_onset,
                "endBlick": absolute_note_end,
                "start": max(0.0, blick_to_seconds(absolute_onset, marks)),
                "end": max(0.0, blick_to_seconds(absolute_note_end, marks)),
                "breakBefore": break_before,
            })
    notes.sort(key=lambda note: (note["startBlick"], note["endBlick"], note["text"]))
    return notes, {
        "unresolvedReferences": unresolved_references,
        "skippedControlNotes": skipped_control_notes,
    }


def lyric_phrases(notes: list[dict], line_gap_seconds: float) -> list[list[dict]]:
    phrases = []
    current = []
    current_end = None
    for note in notes:
        if not note["text"]:
            if current and note["breakBefore"]:
                phrases.append(current)
                current = []
                current_end = None
            elif current and note["start"] - current_end <= line_gap_seconds:
                current_end = max(current_end, note["end"])
            continue
        starts_new = note["breakBefore"] or (
            current_end is not None and note["start"] - current_end > line_gap_seconds
        )
        if current and starts_new:
            phrases.append(current)
            current = []
            current_end = None
        current.append(note)
        current_end = max(current_end or note["end"], note["end"])
    if current:
        phrases.append(current)
    return phrases


def timestamp(seconds: float) -> str:
    centiseconds = max(0, int(round(seconds * 100)))
    minutes, remainder = divmod(centiseconds, 6000)
    whole_seconds, fraction = divmod(remainder, 100)
    return f"{minutes:02d}:{whole_seconds:02d}.{fraction:02d}"


def token_prefix(previous: str | None, current: str) -> str:
    if not previous or not current:
        return ""
    if previous[-1].isascii() and previous[-1].isalnum() and current[0].isascii() and current[0].isalnum():
        return " "
    return ""


def render_lrc(phrases: list[list[dict]], enhanced: bool = False) -> str:
    lines = []
    for phrase in phrases:
        line = f"[{timestamp(phrase[0]['start'])}]"
        previous = None
        for note in phrase:
            if not note["text"]:
                continue
            prefix = token_prefix(previous, note["text"])
            if enhanced:
                line += f"<{timestamp(note['start'])}>{prefix}{note['text']}"
            else:
                line += prefix + note["text"]
            previous = note["text"]
        lines.append(line)
    return "\n".join(lines) + "\n"


def cmd_export_lrc(args) -> dict:
    d = load_svp(args.svp)
    if not math.isfinite(args.line_gap_seconds) or not 0 <= args.line_gap_seconds <= 10:
        raise ValueError("分句空隙必须在 0–10 秒之间")
    notes, diagnostics = lyric_notes_for_track(d, args.track_index)
    timed_unit_count = sum(bool(note["text"]) for note in notes)
    if not timed_unit_count:
        raise ValueError("所选轨道没有可导出的歌词音符")
    phrases = lyric_phrases(notes, args.line_gap_seconds)
    base = pathlib.Path(args.svp).stem
    normal_path = safe_output_path(args.out or (base + ".lrc"), subdir="output", suffix=".lrc")
    word_path = safe_output_path(args.word_out or (base + ".word.lrc"), subdir="output", suffix=".lrc")
    ensure_distinct_output(args.svp, normal_path)
    ensure_distinct_output(args.svp, word_path)
    if normal_path.resolve() == word_path.resolve():
        raise ValueError("普通 LRC 与逐字 LRC 不能使用同一个输出文件名")
    normal_path.write_text(render_lrc(phrases), encoding="utf-8")
    word_path.write_text(render_lrc(phrases, enhanced=True), encoding="utf-8")
    return {
        "tool": "cvrs/export-lrc",
        "source": args.svp,
        "trackIndex": args.track_index,
        "trackName": (d.get("tracks") or [])[args.track_index - 1].get("name"),
        "lineGapSeconds": args.line_gap_seconds,
        "lineCount": len(phrases),
        "timedUnitCount": timed_unit_count,
        "lrcOut": str(normal_path),
        "wordLrcOut": str(word_path),
        **diagnostics,
        "note": "普通 LRC 按停顿分句；逐字 LRC 使用 <mm:ss.xx> 内嵌起音标签。源工程未修改。",
    }


def cmd_add_ref(args) -> dict:
    d = load_svp(args.target)
    ver = d.get("version")
    shell = empty_shell_from(d)

    duration = ffprobe_duration(args.audio)
    # blicks 是四分音符相对量，秒→blicks 须按速度换算（首个 tempo 常速近似；begin=0 时恒为 0）
    tempo_map = (d.get("time") or {}).get("tempo")
    bpm = 120.0
    if isinstance(tempo_map, list) and tempo_map:
        bpm = float(tempo_map[0].get("bpm", 120.0)) or 120.0
    begin_blicks = int(round(args.begin_seconds * (bpm / 60.0) * 705600000))

    mref = shell.get("mainRef") or {}
    mref["groupID"] = shell["mainGroup"]["uuid"]
    mref["isInstrumental"] = True
    mref["blickAbsoluteBegin"] = begin_blicks
    mref["blickAbsoluteEnd"] = -1
    mref["blickOffset"] = begin_blicks
    mref["pitchOffset"] = 0
    if "mute" in mref:  # v187+
        mref["mute"] = True
    audio_obj = {"filename": args.audio}
    if duration is not None:
        audio_obj["duration"] = duration
    mref["audio"] = audio_obj
    # 删掉 vocal 专属字段（这是参考音频轨，不承载唱法）
    for k in ("takes", "pitchTakes", "timbreTakes", "voice", "voicePresetName",
              "vocalModeParams", "vocalModeInherited", "vocalModePreset"):
        mref.pop(k, None)
    shell["mainRef"] = mref

    shell["name"] = args.name or (pathlib.Path(args.audio).stem + " (CVRS ref)")
    shell["renderEnabled"] = False
    mixer = shell.get("mixer") or {}
    mixer["mute"] = True          # 静音：既 mute 又不参与渲染
    mixer["solo"] = False
    shell["mixer"] = mixer
    shell["dispOrder"] = len(d.get("tracks") or [])

    d.setdefault("tracks", []).append(shell)

    out_name = args.out or (pathlib.Path(args.target).stem + "_cvrs.svp")
    out_path = safe_output_path(out_name, subdir="output", suffix=".svp")
    ensure_distinct_output(args.target, out_path)
    write_svp(d, out_path)
    return {
        "tool": "cvrs/add-ref",
        "target": args.target,
        "target_version": ver,
        "target_era": era(ver),
        "added_track": shell["name"],
        "audio": args.audio,
        "audio_duration_sec": duration,
        "muted": True,
        "renderEnabled": False,
        "out": str(out_path),
        "note": "只写：静音参考音频轨已追加；源工程唱法语义未被读取/翻译。源文件未改动。",
    }


def main():
    ap = argparse.ArgumentParser(prog="cvrs", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("probe", help="只读结构探针：版本/时代/轨列表")
    p.add_argument("svp")
    p.set_defaults(fn=cmd_probe)

    a = sub.add_parser("add-ref", help="把 wav 作为静音参考音频轨写进目标工程")
    a.add_argument("target", help="目标 .svp（写入方；不会被覆盖）")
    a.add_argument("--audio", required=True, help="参考 wav 路径（SV 里相对/绝对均可）")
    a.add_argument("--name", help="新轨名")
    a.add_argument("--begin-seconds", type=float, default=0.0, help="音频起始位置（秒）")
    a.add_argument("--out", help="输出文件名（落数据根 output/；默认 <目标>_cvrs.svp）")
    a.set_defaults(fn=cmd_add_ref)

    s = sub.add_parser("strip-params", help="生成清空 Automation 与 Smart Pitch 的无参工程副本")
    s.add_argument("svp", help="源 .svp（不会被覆盖）")
    s.add_argument("--out", help="输出文件名（落数据根 output/；默认 <源>_no_params.svp）")
    s.set_defaults(fn=cmd_strip_params)

    l = sub.add_parser("export-lrc", help="同时生成普通 LRC 与逐字 LRC")
    l.add_argument("svp", help="源 .svp（只读）")
    l.add_argument("--track-index", type=int, default=1, help="歌词轨道编号（从 1 开始）")
    l.add_argument("--line-gap-seconds", type=float, default=0.8, help="超过此停顿时另起一行")
    l.add_argument("--out", help="普通 LRC 输出文件名")
    l.add_argument("--word-out", help="逐字 LRC 输出文件名")
    l.set_defaults(fn=cmd_export_lrc)

    args = ap.parse_args()
    try:
        print(json.dumps(args.fn(args), ensure_ascii=False, indent=1))
    except Exception as e:
        print(json.dumps({"tool": "cvrs", "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
