use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tokio::process::Command as AsyncCommand;
use uuid::Uuid;

use crate::agent::data_root;
use crate::audio_prep::configure_ffmpeg_environment;
use crate::components::{component_usage_guard, ComponentUsageGuard};
use crate::config::model_config_path;
use crate::tuning_profiles::SourceStyleFeatures;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowResult {
    pub kind: String,
    pub summary: String,
    pub output_path: Option<String>,
    pub data: Value,
}

pub fn audio_probe(
    audio_path: String,
    advanced: bool,
    resource_dir: &Path,
) -> Result<WorkflowResult, String> {
    let audio = validate_input(&audio_path, "音频", AUDIO_EXTENSIONS)?;
    let runtime = python_component("audio", None)?;
    let mut args = vec!["probe".to_string(), audio.to_string_lossy().into_owned()];
    if advanced {
        args.extend(["--notes".to_string(), "--panns".to_string()]);
    }
    let data = run_python(&runtime, &args, "音频分析", resource_dir)?;
    let summary = if advanced {
        "高级音频分析已完成，包含音符统计、乐器/风格倾向与人声置信判断。"
    } else {
        "基础音频分析已完成，包含 BPM、调性、能量与频谱趋势。"
    };
    Ok(WorkflowResult {
        kind: "audio-insight".to_string(),
        summary: summary.to_string(),
        output_path: None,
        data,
    })
}

pub fn source_style(
    audio_path: String,
    resource_dir: &Path,
) -> Result<SourceStyleFeatures, String> {
    let audio = validate_input(&audio_path, "参考人声", AUDIO_EXTENSIONS)?;
    let runtime = python_component("audio", None)?;
    let args = vec![
        "source-style".to_string(),
        audio.to_string_lossy().into_owned(),
    ];
    let data = run_python(&runtime, &args, "参考人声特征学习", resource_dir)?;
    serde_json::from_value(data).map_err(|error| format!("参考人声特征格式无效：{error}"))
}

pub async fn separate_audio_cancellable(
    audio_path: String,
    resource_dir: PathBuf,
    cancelled: Arc<AtomicBool>,
    output_id: String,
) -> Result<WorkflowResult, String> {
    Uuid::parse_str(&output_id).map_err(|_| "分离任务 ID 无效。".to_string())?;
    let audio = validate_input(&audio_path, "待分离音频", AUDIO_EXTENSIONS)?;
    let runtime = python_component("separation", None)?;
    let args = vec![
        runtime.script.to_string_lossy().into_owned(),
        audio.to_string_lossy().into_owned(),
        "--output-id".to_string(),
        output_id.clone(),
    ];
    let mut command = AsyncCommand::new(&runtime.python);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_ffmpeg_environment(command.as_std_mut(), &resource_dir)?;
    let output =
        crate::managed_process::run_managed_command(command, &cancelled, "人声伴奏分离").await;
    let output_directory = data_root()
        .join("output")
        .join("separations")
        .join(&output_id);
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            let _ = fs::remove_dir_all(&output_directory);
            return Err(error);
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let data: Value = serde_json::from_str(stdout.trim()).map_err(|error| {
        let _ = fs::remove_dir_all(&output_directory);
        format!(
            "人声伴奏分离未返回有效结果：{error}\n{}",
            tail(&String::from_utf8_lossy(&output.stderr), 1200)
        )
    })?;
    if !output.status.success() || data.get("error").is_some() {
        let _ = fs::remove_dir_all(&output_directory);
        let detail = data
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| tail(&String::from_utf8_lossy(&output.stderr), 1600));
        return Err(format!("人声伴奏分离失败：{detail}"));
    }
    separation_result(data)
}

fn separation_result(data: Value) -> Result<WorkflowResult, String> {
    let vocal_path = data.get("vocalPath").and_then(Value::as_str);
    let instrumental_path = data.get("instrumentalPath").and_then(Value::as_str);
    if vocal_path.is_none() || instrumental_path.is_none() {
        return Err("分离组件没有返回 vocals/inst 输出路径。".to_string());
    }
    Ok(WorkflowResult {
        kind: "source-separation".to_string(),
        summary: "人声与伴奏分离完成，已生成受管 vocals/inst WAV。".to_string(),
        output_path: vocal_path.map(str::to_string),
        data,
    })
}

pub fn game_to_midi(
    vocal_path: String,
    instrumental_path: String,
    output_name: String,
    tolerance: f64,
    advanced: bool,
    resource_dir: &Path,
) -> Result<WorkflowResult, String> {
    let vocal = validate_input(&vocal_path, "有词/演唱音频", AUDIO_EXTENSIONS)?;
    let instrumental = validate_input(&instrumental_path, "无词/伴奏音频", AUDIO_EXTENSIONS)?;
    let output = validate_output_name(&output_name, "mid")?;
    if !(0.02..=0.25).contains(&tolerance) {
        return Err("匹配容差必须在 0.02–0.25 秒之间。".to_string());
    }
    let runtime = python_component("audio", None)?;
    let mut args = vec![
        "pair-diff".to_string(),
        vocal.to_string_lossy().into_owned(),
        instrumental.to_string_lossy().into_owned(),
        "--midi".to_string(),
        output,
        "--tol".to_string(),
        format!("{tolerance:.3}"),
    ];
    if advanced {
        args.push("--advanced".to_string());
    }
    let data = run_python(&runtime, &args, "Game → MIDI", resource_dir)?;
    game_midi_result(data, advanced)
}

pub struct GameToMidiRequest {
    pub vocal_path: String,
    pub instrumental_path: String,
    pub lyrics: Option<String>,
    pub tolerance: f64,
    pub advanced: bool,
    pub resource_dir: PathBuf,
    pub cancelled: Arc<AtomicBool>,
    pub task_id: String,
}

pub async fn game_to_midi_cancellable(
    request: GameToMidiRequest,
) -> Result<WorkflowResult, String> {
    Uuid::parse_str(&request.task_id).map_err(|_| "Cover 任务 ID 无效。".to_string())?;
    let vocal = validate_input(&request.vocal_path, "人声轨", AUDIO_EXTENSIONS)?;
    let instrumental = validate_input(&request.instrumental_path, "伴奏轨", AUDIO_EXTENSIONS)?;
    if !(0.02..=0.25).contains(&request.tolerance) {
        return Err("匹配容差必须在 0.02–0.25 秒之间。".to_string());
    }
    let output_directory = data_root()
        .join("output")
        .join("covers")
        .join(&request.task_id);
    if let Ok(metadata) = fs::symlink_metadata(&output_directory) {
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Cover 输出目录不是安全的普通目录。".to_string());
        }
        fs::remove_dir_all(&output_directory)
            .map_err(|error| format!("无法清理上次 Cover 临时输出：{error}"))?;
    }
    fs::create_dir_all(&output_directory)
        .map_err(|error| format!("无法创建 Cover 输出目录：{error}"))?;
    let midi_path = output_directory.join("cover.mid");
    let runtime = python_component("audio", None)?;
    let mut args = vec![
        runtime.script.to_string_lossy().into_owned(),
        "pair-diff".to_string(),
        vocal.to_string_lossy().into_owned(),
        instrumental.to_string_lossy().into_owned(),
        "--midi".to_string(),
        midi_path.to_string_lossy().into_owned(),
        "--tol".to_string(),
        format!("{:.3}", request.tolerance),
    ];
    if request.advanced {
        args.push("--advanced".to_string());
    }
    if let Some(lyrics) = request.lyrics.filter(|value| !value.trim().is_empty()) {
        if lyrics.len() > 256 * 1024 {
            let _ = fs::remove_dir_all(&output_directory);
            return Err("Cover 歌词超过 256 KiB 限制。".to_string());
        }
        let lyrics_path = output_directory.join("lyrics.txt");
        fs::write(&lyrics_path, lyrics.as_bytes())
            .map_err(|error| format!("无法写入 Cover 歌词：{error}"))?;
        args.push("--lyrics-file".to_string());
        args.push(lyrics_path.to_string_lossy().into_owned());
    }
    let mut command = AsyncCommand::new(&runtime.python);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_ffmpeg_environment(command.as_std_mut(), &request.resource_dir)?;
    let output =
        crate::managed_process::run_managed_command(command, &request.cancelled, "Cover 旋律提取")
            .await;
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            let _ = fs::remove_dir_all(&output_directory);
            return Err(error);
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let data: Value = serde_json::from_str(stdout.trim()).map_err(|error| {
        let _ = fs::remove_dir_all(&output_directory);
        format!(
            "Cover 旋律提取未返回有效结果：{error}\n{}",
            tail(&String::from_utf8_lossy(&output.stderr), 1200)
        )
    })?;
    if !output.status.success() || data.get("error").is_some() {
        let _ = fs::remove_dir_all(&output_directory);
        let detail = data
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| tail(&String::from_utf8_lossy(&output.stderr), 1600));
        return Err(format!("Cover 旋律提取失败：{detail}"));
    }
    game_midi_result(data, request.advanced)
}

fn game_midi_result(data: Value, advanced: bool) -> Result<WorkflowResult, String> {
    let output_path = data
        .get("midi_out")
        .and_then(Value::as_str)
        .map(str::to_string);
    let note_count = data
        .get("mono_notes")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let summary = if advanced {
        format!("高级 MIDI 提取完成：已导出 {note_count} 个音符，并执行参数寻优、自动纠正和置信度检查。")
    } else {
        format!("基础 MIDI 提取完成：已按固定容差导出 {note_count} 个单音音符。")
    };
    Ok(WorkflowResult {
        kind: "game-midi".to_string(),
        summary,
        output_path,
        data,
    })
}

pub fn project_probe(
    project_path: String,
    resource_dir: &Path,
    components_dir: &Path,
) -> Result<WorkflowResult, String> {
    let project = validate_input(&project_path, "SynthV 工程", &["svp"])?;
    let runtime = python_component("cvrs", Some(components_dir))?;
    let args = vec!["probe".to_string(), project.to_string_lossy().into_owned()];
    let data = run_python(&runtime, &args, "SV 工程探测", resource_dir)?;
    let era = data.get("era").and_then(Value::as_str).unwrap_or("unknown");
    let tracks = data
        .get("trackCount")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    Ok(WorkflowResult {
        kind: "project-probe".to_string(),
        summary: format!("工程探测完成：{era} 工程，共 {tracks} 条轨道；源文件未修改。"),
        output_path: None,
        data,
    })
}

pub fn add_project_reference(
    project_path: String,
    audio_path: String,
    track_name: String,
    begin_seconds: f64,
    output_name: String,
    resource_dir: &Path,
    components_dir: &Path,
) -> Result<WorkflowResult, String> {
    let project = validate_input(&project_path, "SynthV 工程", &["svp"])?;
    let audio = validate_input(&audio_path, "参考音频", AUDIO_EXTENSIONS)?;
    if !begin_seconds.is_finite() || !(0.0..=86_400.0).contains(&begin_seconds) {
        return Err("参考音频起始位置必须在 0–86400 秒之间。".to_string());
    }
    let output = validate_output_name(&output_name, "svp")?;
    let name = track_name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err("参考轨名称不能为空且不能超过 100 个字符。".to_string());
    }
    let runtime = python_component("cvrs", Some(components_dir))?;
    let args = vec![
        "add-ref".to_string(),
        project.to_string_lossy().into_owned(),
        "--audio".to_string(),
        audio.to_string_lossy().into_owned(),
        "--name".to_string(),
        name.to_string(),
        "--begin-seconds".to_string(),
        format!("{begin_seconds:.3}"),
        "--out".to_string(),
        output,
    ];
    let data = run_python(&runtime, &args, "添加参考音频轨", resource_dir)?;
    let output_path = data.get("out").and_then(Value::as_str).map(str::to_string);
    Ok(WorkflowResult {
        kind: "project-reference".to_string(),
        summary: "安全工程副本已生成：参考音频轨保持静音且不参与渲染，源工程未修改。".to_string(),
        output_path,
        data,
    })
}

pub fn export_project_without_parameters(
    project_path: String,
    output_name: String,
    resource_dir: &Path,
    components_dir: &Path,
) -> Result<WorkflowResult, String> {
    let project = validate_input(&project_path, "SynthV 工程", &["svp"])?;
    let output = validate_output_name(&output_name, "svp")?;
    let runtime = python_component("cvrs", Some(components_dir))?;
    let args = vec![
        "strip-params".to_string(),
        project.to_string_lossy().into_owned(),
        "--out".to_string(),
        output,
    ];
    let data = run_python(&runtime, &args, "导出无参工程", resource_dir)?;
    let output_path = data.get("out").and_then(Value::as_str).map(str::to_string);
    let cleared_points = data
        .pointer("/cleared/parameterPoints")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let cleared_controls = data
        .pointer("/cleared/pitchControls")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    Ok(WorkflowResult {
        kind: "project-no-params".to_string(),
        summary: format!(
            "无参工程副本已生成：清空 {cleared_points} 个自动化点和 {cleared_controls} 个 Smart Pitch 控制；源工程未修改。"
        ),
        output_path,
        data,
    })
}

pub fn export_project_lyrics(
    project_path: String,
    track_index: u32,
    line_gap_seconds: f64,
    output_name: String,
    word_output_name: String,
    resource_dir: &Path,
    components_dir: &Path,
) -> Result<WorkflowResult, String> {
    let project = validate_input(&project_path, "SynthV 工程", &["svp"])?;
    if track_index == 0 || track_index > 10_000 {
        return Err("歌词轨道编号必须是从 1 开始的有效整数。".to_string());
    }
    if !line_gap_seconds.is_finite() || !(0.0..=10.0).contains(&line_gap_seconds) {
        return Err("分句空隙必须在 0–10 秒之间。".to_string());
    }
    let output = validate_output_name(&output_name, "lrc")?;
    let word_output = validate_output_name(&word_output_name, "lrc")?;
    if output.eq_ignore_ascii_case(&word_output) {
        return Err("普通 LRC 与逐字 LRC 不能使用同一个输出文件名。".to_string());
    }
    let runtime = python_component("cvrs", Some(components_dir))?;
    let args = vec![
        "export-lrc".to_string(),
        project.to_string_lossy().into_owned(),
        "--track-index".to_string(),
        track_index.to_string(),
        "--line-gap-seconds".to_string(),
        format!("{line_gap_seconds:.3}"),
        "--out".to_string(),
        output,
        "--word-out".to_string(),
        word_output,
    ];
    let data = run_python(&runtime, &args, "生成 LRC", resource_dir)?;
    let output_path = data
        .get("lrcOut")
        .and_then(Value::as_str)
        .map(str::to_string);
    let line_count = data
        .get("lineCount")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let timed_unit_count = data
        .get("timedUnitCount")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    Ok(WorkflowResult {
        kind: "project-lyrics".to_string(),
        summary: format!(
            "普通 LRC 与逐字 LRC 已生成：{line_count} 行、{timed_unit_count} 个歌词时间单元；源工程未修改。"
        ),
        output_path,
        data,
    })
}

const AUDIO_EXTENSIONS: &[&str] = &["wav", "flac", "mp3", "m4a", "aac", "ogg", "opus"];

struct PythonRuntime {
    _usage_guard: ComponentUsageGuard,
    python: PathBuf,
    script: PathBuf,
}

fn python_component(key: &str, components_dir: Option<&Path>) -> Result<PythonRuntime, String> {
    let usage_guard = component_usage_guard()?;
    let value: Value = serde_json::from_str(
        &fs::read_to_string(model_config_path())
            .map_err(|_| format!("组件尚未安装。请先在组件中心安装 {}。", component_name(key)))?,
    )
    .map_err(|error| format!("组件配置无法解析：{error}"))?;
    let section = value
        .get(key)
        .ok_or_else(|| format!("组件尚未安装。请先在组件中心安装 {}。", component_name(key)))?;
    let python = section
        .get("python")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .ok_or_else(|| "组件 Python 运行时已丢失，请重新安装组件。".to_string())?;
    let configured_script = section
        .get("script")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|path| path.is_file());
    let bundled_script = components_dir
        .map(|directory| directory.join(key).join(format!("{key}.py")))
        .filter(|path| path.is_file());
    let script = bundled_script
        .or(configured_script)
        .ok_or_else(|| "组件脚本已丢失，请重新安装组件。".to_string())?;
    Ok(PythonRuntime {
        _usage_guard: usage_guard,
        python,
        script,
    })
}

fn run_python(
    runtime: &PythonRuntime,
    args: &[String],
    label: &str,
    resource_dir: &Path,
) -> Result<Value, String> {
    let mut command = Command::new(&runtime.python);
    command
        .arg(&runtime.script)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let _ = configure_ffmpeg_environment(&mut command, resource_dir);
    let output = command
        .output()
        .map_err(|error| format!("无法启动{label}：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let data: Value = serde_json::from_str(stdout.trim()).map_err(|error| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        format!("{label}未返回有效结果：{error}\n{}", tail(&stderr, 1200))
    })?;
    if !output.status.success() || data.get("error").is_some() {
        let detail = data
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| tail(&String::from_utf8_lossy(&output.stderr), 1600));
        return Err(format!("{label}失败：{detail}"));
    }
    Ok(data)
}

fn validate_input(value: &str, label: &str, extensions: &[&str]) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if !path.is_file() {
        return Err(format!("{label}文件不存在：{}", path.to_string_lossy()));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !extensions
        .iter()
        .any(|allowed| extension.eq_ignore_ascii_case(allowed))
    {
        return Err(format!("{label}格式不受支持：.{extension}"));
    }
    Ok(path)
}

fn validate_output_name(value: &str, extension: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let path = Path::new(trimmed);
    if trimmed.is_empty()
        || trimmed.len() > 180
        || path.is_absolute()
        || path.components().count() != 1
        || trimmed.contains(['/', '\\'])
        || trimmed == "."
        || trimmed == ".."
    {
        return Err("输出只接受一个文件名，不能包含目录或路径穿透。".to_string());
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if stem.is_empty() {
        return Err("输出文件名无效。".to_string());
    }
    Ok(format!("{stem}.{extension}"))
}

fn component_name(key: &str) -> &str {
    match key {
        "audio" => "pi-audio",
        "cvrs" => "CVRS",
        "separation" => "人声伴奏分离",
        _ => key,
    }
}

fn tail(value: &str, count: usize) -> String {
    value
        .chars()
        .rev()
        .take(count)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_names_are_forced_under_the_managed_output_directory() {
        assert_eq!(
            validate_output_name("voice.mid", "mid").unwrap(),
            "voice.mid"
        );
        assert_eq!(
            validate_output_name("voice.wav", "mid").unwrap(),
            "voice.mid"
        );
        assert!(validate_output_name("../voice.mid", "mid").is_err());
        assert!(validate_output_name("folder/voice.mid", "mid").is_err());
        assert_eq!(
            validate_output_name("song.word.lrc", "lrc").unwrap(),
            "song.word.lrc"
        );
    }
}
