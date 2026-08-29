use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const MAX_HISTORY_ITEMS: usize = 200;
const MAX_RESULT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreativeHistoryEntry {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub created_at_utc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(default)]
    pub parameters: Value,
    #[serde(default)]
    pub result: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRecipe {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub kind: &'static str,
    pub input_kind: &'static str,
    pub supports_batch: bool,
    pub requires_bridge: bool,
    pub requires_ai: bool,
    pub default_parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCheckpoint {
    pub id: String,
    pub label: String,
    pub source_path: String,
    pub snapshot_path: String,
    pub source_sha256: String,
    pub source_size: u64,
    pub created_at_utc: String,
}

pub fn builtin_recipes() -> Vec<WorkflowRecipe> {
    vec![
        recipe(
            "audio-to-project",
            "音频到 SynthV 工程",
            "从配对音频提取单音旋律，生成受校验 MIDI，并可经 Bridge 导入当前工程。",
            "audio-to-project",
            "pairedAudio",
            false,
            false,
            false,
            json!({ "tolerance": 0.08, "advanced": false, "importToSynthv": false }),
        ),
        recipe(
            "project-doctor",
            "工程医生",
            "只读检查音符、歌词、参数和结构风险，输出可定位的问题清单。",
            "project-doctor",
            "svp",
            true,
            false,
            false,
            json!({}),
        ),
        recipe(
            "pronunciation-check",
            "发音诊断",
            "扫描歌词中的占位词、多音节拥挤、混合文字与不一致发音风险。",
            "pronunciation-check",
            "svpOrText",
            true,
            false,
            false,
            json!({ "language": "auto" }),
        ),
        recipe(
            "render-quality-check",
            "渲染质量复检",
            "复用本地音频分析结果检查削波、静音、动态和异常频谱趋势。",
            "render-quality-check",
            "audio",
            true,
            false,
            false,
            json!({ "advanced": false }),
        ),
        recipe(
            "project-probe",
            "工程结构清单",
            "批量生成工程版本、时代和轨道结构摘要，不修改源文件。",
            "project-probe",
            "svp",
            true,
            false,
            false,
            json!({}),
        ),
        recipe(
            "project-no-params",
            "无参交付副本",
            "批量清除 Automation 与 Smart Pitch 控制并生成独立交付副本。",
            "project-no-params",
            "svp",
            true,
            false,
            false,
            json!({ "suffix": "_no_params" }),
        ),
        recipe(
            "retake-workbench",
            "Retake A/B 工作台",
            "读取指定音符的 Retake，生成、切换或删除候选，并保留 SynthV Undo 边界。",
            "retake-workbench",
            "synthvSelection",
            false,
            true,
            false,
            json!({ "newDuration": true, "newPitch": true, "newTimbre": true }),
        ),
        recipe(
            "profile-selective-sync",
            "账号资源选择性同步",
            "仅比较并同步词典、脚本和安全预设，明确排除登录态与产品数据库。",
            "profile-selective-sync",
            "sv2Profile",
            false,
            false,
            false,
            json!({ "categories": ["dictionaries", "scripts", "presets"] }),
        ),
    ]
}

#[allow(clippy::too_many_arguments)]
fn recipe(
    id: &'static str,
    title: &'static str,
    description: &'static str,
    kind: &'static str,
    input_kind: &'static str,
    supports_batch: bool,
    requires_bridge: bool,
    requires_ai: bool,
    default_parameters: Value,
) -> WorkflowRecipe {
    WorkflowRecipe {
        id,
        title,
        description,
        kind,
        input_kind,
        supports_batch,
        requires_bridge,
        requires_ai,
        default_parameters,
    }
}

pub fn record(
    kind: impl Into<String>,
    title: impl Into<String>,
    summary: impl Into<String>,
    output_path: Option<String>,
    parameters: Value,
    result: Value,
) -> Result<CreativeHistoryEntry, String> {
    let kind = validate_kind(kind.into())?;
    let entry = CreativeHistoryEntry {
        id: Uuid::new_v4().to_string(),
        kind,
        title: limit_text(title.into(), 160),
        summary: limit_text(summary.into(), 2_000),
        created_at_utc: Utc::now().to_rfc3339(),
        output_path,
        parameters: bounded_value(parameters),
        result: bounded_value(result),
    };
    let directory = history_dir();
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建工作流历史目录：{error}"))?;
    let path = directory.join(format!("{}.json", entry.id));
    write_json_atomic(&path, &entry)?;
    prune(&directory)?;
    Ok(entry)
}

pub fn list(limit: usize) -> Result<Vec<CreativeHistoryEntry>, String> {
    let directory = history_dir();
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut items = fs::read_dir(&directory)
        .map_err(|error| format!("无法读取工作流历史：{error}"))?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                return None;
            }
            fs::read_to_string(path)
                .ok()
                .and_then(|text| serde_json::from_str::<CreativeHistoryEntry>(&text).ok())
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| right.created_at_utc.cmp(&left.created_at_utc));
    items.truncate(limit.clamp(1, MAX_HISTORY_ITEMS));
    Ok(items)
}

pub fn create_checkpoint(project_path: &str, label: &str) -> Result<ProjectCheckpoint, String> {
    let source = PathBuf::from(project_path.trim());
    if !source.is_file()
        || source
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("svp"))
    {
        return Err("检查点源文件必须是存在的 .svp 工程。".to_string());
    }
    let label = label.trim();
    if label.is_empty() || label.chars().count() > 100 {
        return Err("检查点名称不能为空且不能超过 100 个字符。".to_string());
    }
    let metadata = fs::metadata(&source).map_err(|error| error.to_string())?;
    if metadata.len() > 128 * 1024 * 1024 {
        return Err("工程超过 128 MiB 检查点限制。".to_string());
    }
    let id = Uuid::new_v4().to_string();
    let directory = checkpoint_dir().join(&id);
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建检查点目录：{error}"))?;
    let snapshot = directory.join("project.svp");
    fs::copy(&source, &snapshot).map_err(|error| format!("无法复制工程检查点：{error}"))?;
    let source_sha256 = sha256_file(&snapshot)?;
    let checkpoint = ProjectCheckpoint {
        id,
        label: label.to_string(),
        source_path: source.to_string_lossy().into_owned(),
        snapshot_path: snapshot.to_string_lossy().into_owned(),
        source_sha256,
        source_size: metadata.len(),
        created_at_utc: Utc::now().to_rfc3339(),
    };
    write_json_atomic(&directory.join("checkpoint.json"), &checkpoint)?;
    Ok(checkpoint)
}

pub fn list_checkpoints(limit: usize) -> Result<Vec<ProjectCheckpoint>, String> {
    let directory = checkpoint_dir();
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut items = fs::read_dir(directory)
        .map_err(|error| format!("无法读取工程检查点：{error}"))?
        .flatten()
        .filter_map(|entry| {
            fs::read_to_string(entry.path().join("checkpoint.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<ProjectCheckpoint>(&text).ok())
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| right.created_at_utc.cmp(&left.created_at_utc));
    items.truncate(limit.clamp(1, 200));
    Ok(items)
}

pub fn restore_checkpoint_copy(id: &str, output_name: &str) -> Result<String, String> {
    validate_uuid(id)?;
    let file_name = validate_output_name(output_name)?;
    let directory = checkpoint_dir().join(id);
    let metadata_path = directory.join("checkpoint.json");
    let checkpoint: ProjectCheckpoint = serde_json::from_str(
        &fs::read_to_string(&metadata_path).map_err(|_| "找不到该工程检查点。".to_string())?,
    )
    .map_err(|error| format!("检查点元数据无效：{error}"))?;
    if checkpoint.id != id {
        return Err("检查点元数据与请求 ID 不一致，已拒绝恢复。".to_string());
    }
    // The persisted display path is never trusted for restore; snapshots always live under
    // the UUID directory selected above, so edited metadata cannot escape the checkpoint root.
    let snapshot = directory.join("project.svp");
    if sha256_file(&snapshot)? != checkpoint.source_sha256 {
        return Err("工程检查点哈希校验失败，已拒绝恢复。".to_string());
    }
    let output_dir = crate::agent::output_dir();
    fs::create_dir_all(&output_dir).map_err(|error| format!("无法创建输出目录：{error}"))?;
    let output = output_dir.join(file_name);
    if output.exists() {
        return Err("输出文件已经存在；请换一个文件名，检查点不会覆盖现有文件。".to_string());
    }
    fs::copy(snapshot, &output).map_err(|error| format!("无法恢复检查点副本：{error}"))?;
    Ok(output.to_string_lossy().into_owned())
}

fn history_dir() -> PathBuf {
    crate::agent::data_root().join("creative-history")
}

fn checkpoint_dir() -> PathBuf {
    crate::agent::data_root().join("project-checkpoints")
}

fn validate_uuid(value: &str) -> Result<(), String> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| "检查点 ID 无效。".to_string())
}

fn validate_output_name(value: &str) -> Result<String, String> {
    let path = Path::new(value.trim());
    if value.trim().is_empty()
        || path.is_absolute()
        || path.components().count() != 1
        || value.contains(['/', '\\'])
    {
        return Err("恢复输出只接受一个文件名。".to_string());
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "恢复输出文件名无效。".to_string())?;
    Ok(format!("{stem}.svp"))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("无法读取检查点：{error}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn validate_kind(value: String) -> Result<String, String> {
    if value.is_empty()
        || value.len() > 80
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("工作流历史类型无效。".to_string());
    }
    Ok(value)
}

fn bounded_value(value: Value) -> Value {
    match serde_json::to_vec(&value) {
        Ok(serialized) if serialized.len() <= MAX_RESULT_BYTES => value,
        Ok(serialized) => json!({
            "truncated": true,
            "originalBytes": serialized.len(),
            "detail": "结果超过历史记录上限；完整结果仍保留在本次工作流界面。"
        }),
        Err(_) => Value::Null,
    }
}

fn limit_text(value: String, max: usize) -> String {
    value.chars().take(max).collect()
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(&temporary, text).map_err(|error| format!("无法写入工作流历史：{error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("无法提交工作流历史：{error}"))
}

fn prune(directory: &Path) -> Result<(), String> {
    let mut files = fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| right.0.cmp(&left.0));
    for (_, path) in files.into_iter().skip(MAX_HISTORY_ITEMS) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recipe_catalog_covers_the_new_vertical_slices() {
        let recipes = builtin_recipes();
        assert_eq!(recipes.len(), 8);
        assert!(recipes.iter().any(|recipe| recipe.id == "audio-to-project"));
        assert!(recipes.iter().any(|recipe| recipe.id == "retake-workbench"));
        assert!(recipes
            .iter()
            .any(|recipe| recipe.id == "profile-selective-sync"));
    }

    #[test]
    fn oversized_history_payload_is_replaced_by_a_bounded_marker() {
        let value = json!({ "payload": "x".repeat(MAX_RESULT_BYTES + 1) });
        let bounded = bounded_value(value);
        assert_eq!(
            bounded.get("truncated").and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn history_kind_rejects_path_like_values() {
        assert!(validate_kind("../../history".to_string()).is_err());
        assert_eq!(
            validate_kind("project-doctor".to_string()).unwrap(),
            "project-doctor"
        );
    }
}
