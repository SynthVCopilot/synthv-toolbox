use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use serde_json::Value;

use crate::config::model_config_path;

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
    let runtime = python_component("audio")?;
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
    let runtime = python_component("audio")?;
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

pub fn project_probe(project_path: String, resource_dir: &Path) -> Result<WorkflowResult, String> {
    let project = validate_input(&project_path, "SynthV 工程", &["svp"])?;
    let runtime = python_component("cvrs")?;
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
    let runtime = python_component("cvrs")?;
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

const AUDIO_EXTENSIONS: &[&str] = &["wav", "flac", "mp3", "m4a", "aac", "ogg", "opus"];

struct PythonRuntime {
    python: PathBuf,
    script: PathBuf,
}

fn python_component(key: &str) -> Result<PythonRuntime, String> {
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
    let script = section
        .get("script")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .ok_or_else(|| "组件脚本已丢失，请重新安装组件。".to_string())?;
    Ok(PythonRuntime { python, script })
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
    prepend_bundled_ffmpeg(&mut command, resource_dir);
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

fn prepend_bundled_ffmpeg(command: &mut Command, resource_dir: &Path) {
    let ffmpeg_dir = resource_dir.join("ffmpeg");
    let binary = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    if !ffmpeg_dir.join(binary).is_file() {
        return;
    }
    let mut paths = vec![ffmpeg_dir];
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    if let Ok(joined) = std::env::join_paths(paths) {
        command.env("PATH", joined);
    }
}

fn component_name(key: &str) -> &str {
    match key {
        "audio" => "pi-audio",
        "cvrs" => "CVRS",
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
    }
}
