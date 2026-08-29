//! Deterministic, offline diagnostics for saved Synthesizer V projects and renders.
//!
//! This module deliberately does not mutate projects.  The public functions are
//! suitable for thin Tauri commands, but contain no Tauri dependency themselves.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, fs, path::Path};

const MAX_PROJECT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_LYRIC_CHARS: usize = 200_000;
const SV1_MAX: i64 = 134;
const SV2_MIN: i64 = 153;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDoctorRequest {
    pub project_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PronunciationRequest {
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub lyrics: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RenderReviewExpectations {
    #[serde(default)]
    pub expected_duration_sec: Option<f64>,
    #[serde(default)]
    pub expected_bpm: Option<f64>,
    #[serde(default)]
    pub require_notes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderReviewRequest {
    /// JSON object (or the stdout containing that object) from `pi-audio probe`.
    pub probe_json: String,
    #[serde(default)]
    pub expectations: RenderReviewExpectations,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticIssue {
    pub code: String,
    pub severity: Severity,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    pub kind: String,
    pub ok: bool,
    pub summary: String,
    pub inspected_items: usize,
    pub issues: Vec<DiagnosticIssue>,
}

pub fn diagnose_project(request: ProjectDoctorRequest) -> Result<DiagnosticReport, String> {
    let project = load_project(&request.project_path)?;
    let mut issues = Vec::new();
    let version = project.get("version").and_then(Value::as_i64);
    match version {
        None => issue(
            &mut issues,
            "PROJECT_VERSION_MISSING",
            Severity::Warning,
            "工程没有可识别的 version 字段。",
            Some("version"),
            Some("用当前 Synthesizer V 另存一次工程。"),
        ),
        Some(v) if v > SV1_MAX && v < SV2_MIN => issue(
            &mut issues,
            "PROJECT_VERSION_BOUNDARY",
            Severity::Warning,
            "工程版本位于 SV1/SV2 已知断裂区间。",
            Some("version"),
            Some("避免跨版本复制唱法与参数。"),
        ),
        _ => {}
    }
    let tracks = project.get("tracks").and_then(Value::as_array);
    if tracks.is_none() {
        issue(
            &mut issues,
            "TRACKS_MISSING",
            Severity::Error,
            "工程缺少 tracks 数组。",
            Some("tracks"),
            None,
        );
    }
    let mut inspected = 0usize;
    let mut ids = HashSet::new();
    if let Some(library) = project.get("library").and_then(Value::as_array) {
        for group in library {
            if let Some(id) = group.get("uuid").and_then(Value::as_str) {
                ids.insert(id);
            }
        }
    }
    for (ti, track) in tracks.into_iter().flatten().enumerate() {
        let base = format!("tracks[{ti}]");
        let Some(main) = track.get("mainGroup") else {
            issue(
                &mut issues,
                "MAIN_GROUP_MISSING",
                Severity::Error,
                "轨道缺少 mainGroup。",
                Some(&base),
                None,
            );
            continue;
        };
        inspect_group(
            main,
            &format!("{base}.mainGroup"),
            &mut inspected,
            &mut issues,
        );
        if let Some(refs) = track.get("groups").and_then(Value::as_array) {
            for (ri, reference) in refs.iter().enumerate() {
                if let Some(id) = reference.get("groupID").and_then(Value::as_str) {
                    if !ids.contains(id) {
                        issue(
                            &mut issues,
                            "GROUP_REFERENCE_BROKEN",
                            Severity::Error,
                            "轨道引用了不存在的 library group。",
                            Some(&format!("{base}.groups[{ri}]")),
                            Some("重新链接或删除失效的音符组引用。"),
                        );
                    }
                }
            }
        }
    }
    finish("project-doctor", inspected, issues)
}

pub fn diagnose_pronunciation(request: PronunciationRequest) -> Result<DiagnosticReport, String> {
    let entries: Vec<(String, String, Option<f64>)> = match (request.project_path, request.lyrics) {
        (Some(path), None) => collect_project_lyrics(&load_project(&path)?),
        (None, Some(text)) => {
            if text.chars().count() > MAX_LYRIC_CHARS {
                return Err("歌词文本超过 200000 字符限制。".into());
            }
            text.lines()
                .enumerate()
                .map(|(i, s)| (format!("lyrics.line{}", i + 1), s.to_owned(), None))
                .collect()
        }
        _ => return Err("projectPath 与 lyrics 必须且只能提供一个。".into()),
    };
    let mut issues = Vec::new();
    for (location, lyric, duration) in &entries {
        let trimmed = lyric.trim();
        if trimmed.is_empty() {
            issue(
                &mut issues,
                "LYRIC_EMPTY",
                Severity::Warning,
                "音符或歌词行为空。",
                Some(location),
                Some("填入歌词，或明确使用 br/sil 等控制音节。"),
            );
            continue;
        }
        if matches!(
            trimmed.to_ascii_lowercase().as_str(),
            "-" | "+" | "br" | "sil" | "sp" | "ap"
        ) {
            continue;
        }
        if trimmed.chars().any(char::is_whitespace) {
            issue(
                &mut issues,
                "MULTIPLE_SYLLABLES",
                Severity::Warning,
                "单个音符/行包含空格，可能承载了多个音节。",
                Some(location),
                Some("按实际音节拆分并逐音符核对。"),
            );
        }
        if trimmed.contains('/') || trimmed.contains('\\') {
            issue(
                &mut issues,
                "AMBIGUOUS_SEPARATOR",
                Severity::Info,
                "歌词含斜线，可能被误当作音素或备选读音。",
                Some(location),
                Some("使用明确的歌词与 phonemes 字段。"),
            );
        }
        let scripts = script_count(trimmed);
        if scripts > 1 {
            issue(
                &mut issues,
                "MIXED_LANGUAGE",
                Severity::Info,
                "同一音节混合了多种文字系统。",
                Some(location),
                Some("确认语言/音素集覆盖是否正确。"),
            );
        }
        if duration.is_some_and(|d| d > 0.0 && d < 88_200_000.0) {
            issue(
                &mut issues,
                "VERY_SHORT_NOTE",
                Severity::Warning,
                "音符极短，辅音可能无法完整发出。",
                Some(location),
                Some("延长音符或把辅音移交相邻音符。"),
            );
        }
    }
    finish("pronunciation-diagnostics", entries.len(), issues)
}

pub fn review_render(request: RenderReviewRequest) -> Result<DiagnosticReport, String> {
    let probe = parse_json_object(&request.probe_json)?;
    let mut issues = Vec::new();
    if probe.get("tool").and_then(Value::as_str) != Some("pi-audio/probe") {
        issue(
            &mut issues,
            "PROBE_TOOL_UNKNOWN",
            Severity::Warning,
            "输入不是已知的 pi-audio/probe 结果。",
            Some("tool"),
            None,
        );
    }
    let duration = finite_field(&probe, "duration_sec", &mut issues);
    let bpm = finite_field(&probe, "bpm", &mut issues);
    if duration.is_some_and(|v| v <= 0.05) {
        issue(
            &mut issues,
            "RENDER_EMPTY",
            Severity::Error,
            "渲染时长接近零。",
            Some("duration_sec"),
            Some("检查导出区间和渲染文件。"),
        );
    }
    if let (Some(actual), Some(expected)) = (duration, request.expectations.expected_duration_sec) {
        if !expected.is_finite() || expected <= 0.0 {
            return Err("expectedDurationSec 必须是正有限数。".into());
        }
        if (actual - expected).abs() > (expected * 0.02).max(0.25) {
            issue(
                &mut issues,
                "DURATION_MISMATCH",
                Severity::Warning,
                "渲染时长与预期不符。",
                Some("duration_sec"),
                Some("检查导出起止、小节尾音和静音裁切。"),
            );
        }
    }
    if let (Some(actual), Some(expected)) = (bpm, request.expectations.expected_bpm) {
        if !expected.is_finite() || expected <= 0.0 {
            return Err("expectedBpm 必须是正有限数。".into());
        }
        let ratios = [
            (actual / expected - 1.0).abs(),
            (actual * 2.0 / expected - 1.0).abs(),
            (actual / 2.0 / expected - 1.0).abs(),
        ];
        if ratios.into_iter().fold(f64::INFINITY, f64::min) > 0.06 {
            issue(
                &mut issues,
                "BPM_MISMATCH",
                Severity::Warning,
                "探测 BPM 与预期不符（已容忍半拍/双拍歧义）。",
                Some("bpm"),
                None,
            );
        }
    }
    let arc = probe.get("energy_arc_6seg").and_then(Value::as_str);
    if arc.is_some_and(|s| s.len() != 6 || !s.bytes().all(|b| b.is_ascii_digit())) {
        issue(
            &mut issues,
            "ENERGY_ARC_INVALID",
            Severity::Warning,
            "六段能量弧格式无效。",
            Some("energy_arc_6seg"),
            None,
        );
    } else if arc.is_some_and(|s| s.bytes().all(|b| b == b'0')) {
        issue(
            &mut issues,
            "RENDER_SILENT",
            Severity::Error,
            "六段能量均为零，渲染可能是静音。",
            Some("energy_arc_6seg"),
            Some("检查轨道静音、歌手加载和导出总线。"),
        );
    }
    if probe
        .get("clipped_sample_ratio")
        .and_then(Value::as_f64)
        .is_some_and(|ratio| ratio > 0.0001)
        || probe
            .get("peak_dbfs")
            .and_then(Value::as_f64)
            .is_some_and(|peak| peak > -0.1)
    {
        issue(
            &mut issues,
            "RENDER_CLIPPING",
            Severity::Error,
            "渲染包含明显削波或峰值过度贴近 0 dBFS。",
            Some("clipped_sample_ratio"),
            Some("降低轨道/总线增益后重新渲染。"),
        );
    }
    if probe
        .get("silent_frame_ratio")
        .and_then(Value::as_f64)
        .is_some_and(|ratio| ratio > 0.98)
        || probe
            .get("rms_dbfs")
            .and_then(Value::as_f64)
            .is_some_and(|rms| rms < -70.0)
    {
        issue(
            &mut issues,
            "RENDER_NEAR_SILENT",
            Severity::Error,
            "渲染几乎全程静音。",
            Some("silent_frame_ratio"),
            Some("检查导出区间、轨道静音、歌手加载和总线路由。"),
        );
    }
    if let Some(segments) = probe.get("energy_dbfs_6seg").and_then(Value::as_array) {
        let values = segments
            .iter()
            .filter_map(Value::as_f64)
            .collect::<Vec<_>>();
        if values.len() == 6
            && values
                .windows(2)
                .any(|window| (window[0] - window[1]).abs() > 18.0)
        {
            issue(
                &mut issues,
                "LOUDNESS_DISCONTINUITY",
                Severity::Warning,
                "相邻段落的平均能量突变超过 18 dB。",
                Some("energy_dbfs_6seg"),
                Some("确认是否存在漏渲染、突发静音或总线自动化跳变。"),
            );
        }
    }
    if request.expectations.require_notes
        && probe
            .pointer("/notes/total")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            == 0
    {
        issue(
            &mut issues,
            "NOTES_NOT_DETECTED",
            Severity::Warning,
            "未探测到音高事件。",
            Some("notes.total"),
            Some("重新以 --notes 探测，或检查人声音量。"),
        );
    }
    finish("render-review", 1, issues)
}

fn load_project(path: &str) -> Result<Value, String> {
    let p = Path::new(path);
    if p.extension()
        .and_then(|s| s.to_str())
        .is_none_or(|s| !s.eq_ignore_ascii_case("svp"))
    {
        return Err("工程路径必须以 .svp 结尾。".into());
    }
    let metadata = fs::metadata(p).map_err(|e| format!("无法读取工程元数据: {e}"))?;
    if !metadata.is_file() {
        return Err("工程路径不是文件。".into());
    }
    if metadata.len() > MAX_PROJECT_BYTES {
        return Err("工程超过 64 MiB 安全限制。".into());
    }
    let raw = fs::read(p).map_err(|e| format!("无法读取工程: {e}"))?;
    let raw = raw.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&raw);
    let text = std::str::from_utf8(raw)
        .map_err(|_| "工程不是有效 UTF-8。".to_string())?
        .trim_end_matches(['\0', ' ', '\r', '\n', '\t']);
    let mut stream = serde_json::Deserializer::from_str(text).into_iter::<Value>();
    let value = stream
        .next()
        .ok_or_else(|| "工程为空。".to_string())?
        .map_err(|e| format!("工程 JSON 无效: {e}"))?;
    if !value.is_object() {
        return Err("工程 JSON 根节点必须是对象。".into());
    }
    Ok(value)
}

fn inspect_group(
    group: &Value,
    location: &str,
    count: &mut usize,
    issues: &mut Vec<DiagnosticIssue>,
) {
    let Some(notes) = group.get("notes").and_then(Value::as_array) else {
        return;
    };
    let mut previous_end = None::<f64>;
    for (i, note) in notes.iter().enumerate() {
        *count += 1;
        let loc = format!("{location}.notes[{i}]");
        let onset = note.get("onset").and_then(Value::as_f64);
        let duration = note.get("duration").and_then(Value::as_f64);
        match (onset, duration) {
            (Some(onset), Some(duration))
                if onset.is_finite() && onset >= 0.0 && duration.is_finite() && duration > 0.0 =>
            {
                if previous_end.is_some_and(|end| onset < end) {
                    issue(
                        issues,
                        "NOTE_OVERLAP",
                        Severity::Warning,
                        "相邻音符发生重叠。",
                        Some(&loc),
                        Some("确认是否为有意的连音或复音。"),
                    );
                }
                previous_end = Some(previous_end.unwrap_or(0.0).max(onset + duration));
            }
            _ => issue(
                issues,
                "NOTE_TIMING_INVALID",
                Severity::Error,
                "音符起点或时值无效。",
                Some(&loc),
                None,
            ),
        }
        if note
            .get("pitch")
            .and_then(Value::as_f64)
            .is_some_and(|p| !(0.0..=127.0).contains(&p))
        {
            issue(
                issues,
                "PITCH_OUT_OF_RANGE",
                Severity::Error,
                "音高超出 MIDI 0..127。",
                Some(&loc),
                None,
            );
        }
        if note.get("lyrics").and_then(Value::as_str).is_none() {
            issue(
                issues,
                "LYRIC_MISSING",
                Severity::Warning,
                "音符缺少字符串 lyrics。",
                Some(&loc),
                None,
            );
        }
    }
    if let Some(parameters) = group.get("parameters").and_then(Value::as_object) {
        for (name, curve) in parameters {
            if let Some(points) = curve.get("points").and_then(Value::as_array) {
                if points.len() > 100_000 {
                    issue(
                        issues,
                        "PARAMETER_DENSE",
                        Severity::Warning,
                        "参数曲线点数异常密集。",
                        Some(&format!("{location}.parameters.{name}")),
                        Some("在副本中简化自动化曲线。"),
                    );
                }
                if points.iter().any(|p| {
                    p.as_array().is_none_or(|a| {
                        a.len() < 2
                            || a[..2]
                                .iter()
                                .any(|v| v.as_f64().is_none_or(|n| !n.is_finite()))
                    })
                }) {
                    issue(
                        issues,
                        "PARAMETER_POINT_INVALID",
                        Severity::Error,
                        "参数曲线包含无效点。",
                        Some(&format!("{location}.parameters.{name}")),
                        None,
                    );
                }
            }
        }
    }
}

fn collect_project_lyrics(project: &Value) -> Vec<(String, String, Option<f64>)> {
    let mut out = Vec::new();
    fn visit(value: &Value, path: &str, out: &mut Vec<(String, String, Option<f64>)>) {
        match value {
            Value::Object(map) => {
                if let Some(notes) = map.get("notes").and_then(Value::as_array) {
                    for (i, note) in notes.iter().enumerate() {
                        if let Some(lyric) = note.get("lyrics").and_then(Value::as_str) {
                            out.push((
                                format!("{path}.notes[{i}]"),
                                lyric.to_owned(),
                                note.get("duration").and_then(Value::as_f64),
                            ));
                        }
                    }
                }
                for (key, child) in map {
                    if key != "notes" {
                        visit(child, &format!("{path}.{key}"), out);
                    }
                }
            }
            Value::Array(items) => {
                for (i, child) in items.iter().enumerate() {
                    visit(child, &format!("{path}[{i}]"), out);
                }
            }
            _ => {}
        }
    }
    visit(project, "$", &mut out);
    out
}

fn script_count(text: &str) -> usize {
    let mut latin = false;
    let mut cjk = false;
    let mut kana = false;
    let mut hangul = false;
    for c in text.chars() {
        let u = c as u32;
        latin |= c.is_ascii_alphabetic();
        cjk |= (0x3400..=0x9fff).contains(&u);
        kana |= (0x3040..=0x30ff).contains(&u);
        hangul |= (0xac00..=0xd7af).contains(&u);
    }
    [latin, cjk, kana, hangul]
        .into_iter()
        .filter(|v| *v)
        .count()
}

fn parse_json_object(text: &str) -> Result<Value, String> {
    if text.len() > 4 * 1024 * 1024 {
        return Err("探测 JSON 超过 4 MiB 限制。".into());
    }
    let start = text.find('{').ok_or("探测输出中没有 JSON 对象。")?;
    let value: Value =
        serde_json::from_str(&text[start..]).map_err(|e| format!("探测 JSON 无效: {e}"))?;
    if !value.is_object() {
        return Err("探测 JSON 根节点必须是对象。".into());
    }
    Ok(value)
}

fn finite_field(value: &Value, key: &str, issues: &mut Vec<DiagnosticIssue>) -> Option<f64> {
    match value.get(key).and_then(Value::as_f64) {
        Some(v) if v.is_finite() => Some(v),
        _ => {
            issue(
                issues,
                "PROBE_FIELD_INVALID",
                Severity::Warning,
                &format!("探测字段 {key} 缺失或无效。"),
                Some(key),
                None,
            );
            None
        }
    }
}

fn issue(
    out: &mut Vec<DiagnosticIssue>,
    code: &str,
    severity: Severity,
    message: &str,
    location: Option<&str>,
    suggestion: Option<&str>,
) {
    out.push(DiagnosticIssue {
        code: code.into(),
        severity,
        message: message.into(),
        location: location.map(str::to_owned),
        suggestion: suggestion.map(str::to_owned),
    });
}

fn finish(
    kind: &str,
    inspected: usize,
    mut issues: Vec<DiagnosticIssue>,
) -> Result<DiagnosticReport, String> {
    issues.sort_by(|a, b| {
        b.severity
            .cmp(&a.severity)
            .then_with(|| a.code.cmp(&b.code))
            .then_with(|| a.location.cmp(&b.location))
    });
    let errors = issues
        .iter()
        .filter(|i| i.severity == Severity::Error)
        .count();
    let warnings = issues
        .iter()
        .filter(|i| i.severity == Severity::Warning)
        .count();
    Ok(DiagnosticReport {
        kind: kind.into(),
        ok: errors == 0,
        summary: format!("检查 {inspected} 项：{errors} 个错误，{warnings} 个警告。"),
        inspected_items: inspected,
        issues,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_path(contents: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "creative-tools-{}-{}.svp",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn doctor_finds_broken_reference_and_bad_note() {
        let path = fixture_path(
            r#"{"version":187,"library":[],"tracks":[{"mainGroup":{"notes":[{"onset":0,"duration":0,"pitch":200}]},"groups":[{"groupID":"gone"}]}]}"#,
        );
        let report = diagnose_project(ProjectDoctorRequest {
            project_path: path.to_string_lossy().into(),
        })
        .unwrap();
        fs::remove_file(path).unwrap();
        assert!(!report.ok);
        assert!(report
            .issues
            .iter()
            .any(|i| i.code == "GROUP_REFERENCE_BROKEN"));
        assert!(report
            .issues
            .iter()
            .any(|i| i.code == "NOTE_TIMING_INVALID"));
    }

    #[test]
    fn pronunciation_is_deterministic_and_structured() {
        let report = diagnose_pronunciation(PronunciationRequest {
            project_path: None,
            lyrics: Some("hello world\n你a\nbr".into()),
        })
        .unwrap();
        assert_eq!(report.inspected_items, 3);
        assert_eq!(
            report
                .issues
                .iter()
                .map(|i| i.code.as_str())
                .collect::<Vec<_>>(),
            vec!["MULTIPLE_SYLLABLES", "MIXED_LANGUAGE"]
        );
    }

    #[test]
    fn render_review_accepts_pi_audio_stdout_and_half_time_bpm() {
        let report = review_render(RenderReviewRequest { probe_json: "log\n{\"tool\":\"pi-audio/probe\",\"duration_sec\":10,\"bpm\":60,\"energy_arc_6seg\":\"123456\",\"notes\":{\"total\":2}}".into(), expectations: RenderReviewExpectations { expected_duration_sec: Some(10.1), expected_bpm: Some(120.0), require_notes: true } }).unwrap();
        assert!(report.ok);
        assert!(report.issues.is_empty());
    }

    #[test]
    fn render_review_flags_silence() {
        let report = review_render(RenderReviewRequest {
            probe_json:
                r#"{"tool":"pi-audio/probe","duration_sec":1,"bpm":120,"energy_arc_6seg":"000000"}"#
                    .into(),
            expectations: Default::default(),
        })
        .unwrap();
        assert!(!report.ok);
        assert_eq!(report.issues[0].code, "RENDER_SILENT");
    }
}
