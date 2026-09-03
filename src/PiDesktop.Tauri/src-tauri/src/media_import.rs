use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;
use uuid::Uuid;

use crate::agent::data_root;
use crate::components::{managed_media_fetcher_binary, resolved_ffmpeg_directory};
use crate::synthv::{find_node, quiet_command};

const MAX_METADATA_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSourcePreview {
    pub source_url: String,
    pub canonical_url: String,
    pub platform: String,
    pub media_id: String,
    pub title: String,
    pub uploader: String,
    pub duration_seconds: Option<f64>,
    pub thumbnail_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaImportResult {
    pub import_id: String,
    pub source: MediaSourcePreview,
    pub audio_path: String,
    pub metadata_path: String,
    pub manifest_path: String,
    pub sha256: String,
    pub imported_at_utc: String,
}

pub fn preview(source: &str) -> Result<MediaSourcePreview, String> {
    let source_url = normalize_source(source)?;
    let runtime = media_fetcher()?;
    let mut args = safe_common_args()?;
    args.extend(["--dump-single-json".to_string(), source_url.clone()]);
    let output = run_fetcher(&runtime, &args, "读取媒体元数据")?;
    if output.stdout.len() > MAX_METADATA_BYTES {
        return Err("媒体元数据超过 4 MiB 限制。".to_string());
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("无法解析媒体元数据：{error}"))?;
    if value.get("is_live").and_then(Value::as_bool) == Some(true) {
        return Err("当前不支持直播或进行中的媒体。".to_string());
    }
    let canonical_url = value
        .get("webpage_url")
        .and_then(Value::as_str)
        .unwrap_or(&source_url)
        .to_string();
    Ok(MediaSourcePreview {
        source_url,
        canonical_url,
        platform: value
            .get("extractor_key")
            .or_else(|| value.get("extractor"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        media_id: required_text(&value, "id", "媒体 ID")?,
        title: required_text(&value, "title", "标题")?,
        uploader: value
            .get("uploader")
            .or_else(|| value.get("channel"))
            .and_then(Value::as_str)
            .unwrap_or("未知作者")
            .to_string(),
        duration_seconds: value.get("duration").and_then(Value::as_f64),
        thumbnail_url: value
            .get("thumbnail")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

pub fn import_audio(
    source: &str,
    rights_confirmed: bool,
    resource_root: &Path,
) -> Result<MediaImportResult, String> {
    if !rights_confirmed {
        return Err("下载前必须确认你拥有该内容或已取得足够授权。".to_string());
    }
    let source_preview = preview(source)?;
    let runtime = media_fetcher()?;
    let import_id = Uuid::new_v4().to_string();
    let directory = imports_root()?.join(&import_id);
    fs::create_dir(&directory).map_err(|error| format!("无法创建媒体导入目录：{error}"))?;
    let mut args = match safe_common_args() {
        Ok(args) => args,
        Err(error) => {
            let _ = fs::remove_dir(&directory);
            return Err(error);
        }
    };
    args.extend([
        "--extract-audio".to_string(),
        "--audio-format".to_string(),
        "wav".to_string(),
        "--format".to_string(),
        "bestaudio/best".to_string(),
        "--max-filesize".to_string(),
        "2G".to_string(),
        "--output".to_string(),
        directory
            .join("source.%(ext)s")
            .to_string_lossy()
            .into_owned(),
    ]);
    if let Some(ffmpeg) = resolved_ffmpeg_directory(resource_root) {
        args.push("--ffmpeg-location".to_string());
        args.push(ffmpeg.to_string_lossy().into_owned());
    }
    args.push(source_preview.source_url.clone());
    if let Err(error) = run_fetcher(&runtime, &args, "下载并抽取音频") {
        let _ = fs::remove_dir_all(&directory);
        return Err(error);
    }
    let audio_path = fs::read_dir(&directory)
        .map_err(|error| error.to_string())?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("wav"))
        })
        .ok_or_else(|| "媒体导入完成，但没有找到输出 WAV。".to_string())?;
    let sha256 = sha256_file(&audio_path)?;
    let imported_at_utc = Utc::now().to_rfc3339();
    let metadata_path = directory.join("source.json");
    let manifest_path = directory.join("manifest.json");
    write_json(&metadata_path, &source_preview)?;
    write_json(
        &manifest_path,
        &json!({
            "schemaVersion": 1,
            "importId": import_id,
            "sourceUrl": source_preview.source_url,
            "canonicalUrl": source_preview.canonical_url,
            "rightsConfirmed": true,
            "rightsConfirmedAtUtc": imported_at_utc,
            "audio": audio_path.file_name().and_then(|name| name.to_str()).unwrap_or("source.wav"),
            "sha256": sha256,
        }),
    )?;
    Ok(MediaImportResult {
        import_id,
        source: source_preview,
        audio_path: audio_path.to_string_lossy().into_owned(),
        metadata_path: metadata_path.to_string_lossy().into_owned(),
        manifest_path: manifest_path.to_string_lossy().into_owned(),
        sha256,
        imported_at_utc,
    })
}

fn normalize_source(source: &str) -> Result<String, String> {
    let source = source.trim();
    if source.len() == 12
        && source.starts_with("BV")
        && source
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Ok(format!("https://www.bilibili.com/video/{source}"));
    }
    let parsed = Url::parse(source)
        .map_err(|_| "请输入完整的 Bilibili/YouTube URL 或 BV 号。".to_string())?;
    if parsed.scheme() != "https" {
        return Err("媒体来源必须使用 HTTPS。".to_string());
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let allowed = host == "youtu.be"
        || host == "youtube.com"
        || host.ends_with(".youtube.com")
        || host == "bilibili.com"
        || host.ends_with(".bilibili.com")
        || host == "b23.tv";
    if !allowed {
        return Err("当前只支持 Bilibili 与 YouTube 来源。".to_string());
    }
    Ok(parsed.to_string())
}

fn safe_common_args() -> Result<Vec<String>, String> {
    let node = find_node().ok_or_else(|| "媒体导入需要 Node.js 22 或更高版本。".to_string())?;
    Ok(vec![
        "--ignore-config".to_string(),
        "--no-playlist".to_string(),
        "--no-remote-components".to_string(),
        "--no-js-runtimes".to_string(),
        "--js-runtimes".to_string(),
        format!("node:{}", node),
        "--no-progress".to_string(),
        "--no-warnings".to_string(),
    ])
}

fn media_fetcher() -> Result<PathBuf, String> {
    managed_media_fetcher_binary(&data_root())
        .ok_or_else(|| "媒体导入器尚未安装；请先在组件中心安装 media-fetcher。".to_string())
}

fn run_fetcher(
    runtime: &Path,
    args: &[String],
    operation: &str,
) -> Result<std::process::Output, String> {
    let output = quiet_command(runtime)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("无法启动媒体导入器：{error}"))?;
    if output.status.success() {
        Ok(output)
    } else {
        let detail = String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(2_000)
            .collect::<String>();
        Err(format!(
            "{operation}失败（退出码 {:?}）：{}",
            output.status.code(),
            detail.trim()
        ))
    }
}

fn imports_root() -> Result<PathBuf, String> {
    let root = data_root().join("media-imports");
    fs::create_dir_all(&root).map_err(|error| format!("无法创建媒体导入根目录：{error}"))?;
    let metadata = fs::symlink_metadata(&root).map_err(|error| error.to_string())?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        Ok(root)
    } else {
        Err("媒体导入根目录不是安全的普通目录。".to_string())
    }
}

fn required_text(value: &Value, key: &str, label: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("媒体元数据缺少{label}。"))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| format!("无法读取导入音频：{error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let temporary = path.with_extension(format!("json.{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}
