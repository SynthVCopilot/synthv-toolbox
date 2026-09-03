use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::mcp::{extract_mcp_json, McpManager};

const LOCAL_SCORE_EXTENSIONS: &[&str] = &["xml", "musicxml", "mxl", "mid", "midi"];

#[derive(Debug, Clone)]
pub struct ScoreImportRequest {
    pub score_path: String,
    pub track_index: u32,
    pub group_name: String,
    pub rights_confirmed: bool,
}

struct ValidatedScoreImport {
    score_path: PathBuf,
    track_index: u32,
    group_name: String,
    rights_confirmed: bool,
}

pub async fn import_monophonic_score(
    manager: &McpManager,
    request: ScoreImportRequest,
) -> Result<Value, String> {
    let request = validate_score_import(request)?;
    let score_path = request.score_path.to_string_lossy().into_owned();
    let inspection = call_json(
        manager,
        "sv_query",
        json!({
            "action": "inspect_score_file",
            "args": { "filePath": score_path.clone(), "previewNoteLimit": 64 },
            "contextMode": "readOnly",
            "dense": "never",
            "debug": false
        }),
    )
    .await?;
    let fingerprint = find_string(&inspection, "fileFingerprint")
        .filter(|value| value.starts_with("sha256:"))
        .ok_or_else(|| "Bridge 检查 MIDI 后没有返回文件指纹。".to_string())?;
    let imported = call_json(
        manager,
        "sv_command",
        json!({
            "action": "import_monophonic_score",
            "args": {
                "trackIndex": request.track_index,
                "groupIndex": 1,
                "filePath": score_path,
                "expectedFileFingerprint": fingerprint,
                "rightsConfirmed": request.rights_confirmed,
                "grouping": "ensureNonMain",
                "groupName": request.group_name,
                "sharedGroupPolicy": "reject",
                "previewNoteLimit": 64
            },
            "expectedEffect": "mustChange"
        }),
    )
    .await?;
    Ok(json!({ "inspection": inspection, "import": imported }))
}

pub async fn import_monophonic_midi(
    manager: &McpManager,
    midi_path: &str,
    track_index: u32,
    group_name: &str,
) -> Result<Value, String> {
    import_monophonic_score(
        manager,
        ScoreImportRequest {
            score_path: midi_path.to_string(),
            track_index,
            group_name: group_name.to_string(),
            rights_confirmed: true,
        },
    )
    .await
}

pub async fn current_project_file(manager: &McpManager) -> Result<String, String> {
    let status = call_json(manager, "sv_status", json!({})).await?;
    find_string(&status, "projectFile")
        .filter(|path| !path.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| "当前 SynthV 工程尚未保存为 .svp；无法验证 Cover 工程输出。".to_string())
}

fn validate_score_import(request: ScoreImportRequest) -> Result<ValidatedScoreImport, String> {
    if !request.rights_confirmed {
        return Err("导入 SynthV 前必须确认你有权使用该本地曲谱。".to_string());
    }
    if request.track_index == 0 || request.track_index > 10_000 {
        return Err("SynthV 目标轨道编号必须是 1–10000。".to_string());
    }
    let group_name = request.group_name.trim();
    if group_name.is_empty() || group_name.chars().count() > 200 {
        return Err("导入音符组名称不能为空且不能超过 200 个字符。".to_string());
    }
    let score_path = Path::new(request.score_path.trim());
    if !score_path.is_absolute() {
        return Err("曲谱路径必须是绝对本地路径。".to_string());
    }
    if !score_path.is_file() {
        return Err(format!("曲谱文件不存在：{}", score_path.to_string_lossy()));
    }
    let extension = score_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !LOCAL_SCORE_EXTENSIONS
        .iter()
        .any(|allowed| extension.eq_ignore_ascii_case(allowed))
    {
        return Err("曲谱格式不受支持；请选择 MIDI、MusicXML 或 MXL 文件。".to_string());
    }
    Ok(ValidatedScoreImport {
        score_path: score_path.to_path_buf(),
        track_index: request.track_index,
        group_name: group_name.to_string(),
        rights_confirmed: request.rights_confirmed,
    })
}

#[derive(Debug, Clone)]
pub struct RetakeRequest {
    pub track_index: u32,
    pub group_index: u32,
    pub note_index: u32,
    pub operation: String,
    pub take_id: Option<u32>,
    pub new_duration: bool,
    pub new_pitch: bool,
    pub new_timbre: bool,
    pub activate: bool,
}

pub async fn retake_workbench(
    manager: &McpManager,
    request: RetakeRequest,
) -> Result<Value, String> {
    if request.track_index == 0 || request.group_index == 0 || request.note_index == 0 {
        return Err("轨道、音符组和音符编号都必须从 1 开始。".to_string());
    }
    let before = read_retakes(manager, &request).await?;
    if request.operation == "refresh" {
        return Ok(json!({ "state": before }));
    }
    let context_id = find_string(&before, "contextId")
        .ok_or_else(|| "Bridge 没有返回可用于安全写入的 Retake Context。".to_string())?;
    let (action, args) = match request.operation.as_str() {
        "generate" => {
            if !(request.new_duration || request.new_pitch || request.new_timbre) {
                return Err("至少选择一种 Retake 变化维度。".to_string());
            }
            (
                "generate_note_retake",
                json!({
                    "noteIndex": request.note_index,
                    "newDuration": request.new_duration,
                    "newPitch": request.new_pitch,
                    "newTimbre": request.new_timbre,
                    "activate": request.activate
                }),
            )
        }
        "activate" => (
            "activate_note_retake",
            json!({
                "noteIndex": request.note_index,
                "takeId": request.take_id.ok_or_else(|| "切换 Retake 需要 takeId。".to_string())?
            }),
        ),
        "delete" => {
            let take_id = request.take_id.filter(|value| *value > 0).ok_or_else(|| {
                "删除 Retake 需要大于 0 的 takeId；默认 Take 不能删除。".to_string()
            })?;
            (
                "delete_note_retake",
                json!({ "noteIndex": request.note_index, "takeId": take_id }),
            )
        }
        _ => return Err("不支持的 Retake 操作。".to_string()),
    };
    let command = call_json(
        manager,
        "sv_command",
        json!({
            "action": action,
            "args": args,
            "contextId": context_id,
            "expectedEffect": if request.operation == "activate" { "allowAlreadySatisfied" } else { "mustChange" }
        }),
    )
    .await?;
    let after = read_retakes(manager, &request).await?;
    Ok(json!({ "before": before, "command": command, "state": after }))
}

async fn read_retakes(manager: &McpManager, request: &RetakeRequest) -> Result<Value, String> {
    call_json(
        manager,
        "sv_query",
        json!({
            "action": "get_note_retakes",
            "args": {
                "trackIndex": request.track_index,
                "groupIndex": request.group_index,
                "noteIndex": request.note_index
            },
            "contextMode": "writeIntent",
            "dense": "never",
            "debug": false
        }),
    )
    .await
}

async fn call_json(manager: &McpManager, tool: &str, arguments: Value) -> Result<Value, String> {
    let response = manager.call_bridge_tool(tool, arguments).await?;
    extract_mcp_json(&response)
}

fn find_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    match value {
        Value::Object(object) => object
            .get(key)
            .and_then(Value::as_str)
            .or_else(|| object.values().find_map(|value| find_string(value, key))),
        Value::Array(items) => items.iter().find_map(|value| find_string(value, key)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn recursively_finds_bridge_projection_fields() {
        let value = json!({ "result": { "fileFingerprint": "sha256:abc" } });
        assert_eq!(find_string(&value, "fileFingerprint"), Some("sha256:abc"));
    }

    #[test]
    fn score_import_requires_explicit_rights_confirmation_before_bridge_access() {
        let error = validate_score_import(ScoreImportRequest {
            score_path: "missing.mid".to_string(),
            track_index: 1,
            group_name: "Imported Score".to_string(),
            rights_confirmed: false,
        })
        .err()
        .expect("rights confirmation should be required");
        assert!(error.contains("确认"));
    }

    #[test]
    fn score_import_accepts_midi_and_musicxml_but_rejects_svp() {
        for extension in ["mid", "midi", "xml", "musicxml", "mxl"] {
            let path = temporary_score_path(extension);
            fs::write(&path, b"fixture").expect("write score fixture");
            let validated = validate_score_import(ScoreImportRequest {
                score_path: path.to_string_lossy().into_owned(),
                track_index: 2,
                group_name: " Imported Score ".to_string(),
                rights_confirmed: true,
            })
            .expect("supported score extension");
            assert_eq!(validated.score_path, path);
            assert_eq!(validated.track_index, 2);
            assert_eq!(validated.group_name, "Imported Score");
            fs::remove_file(path).expect("remove score fixture");
        }

        let path = temporary_score_path("svp");
        fs::write(&path, b"{}").expect("write svp fixture");
        let error = validate_score_import(ScoreImportRequest {
            score_path: path.to_string_lossy().into_owned(),
            track_index: 1,
            group_name: "Imported Score".to_string(),
            rights_confirmed: true,
        })
        .err()
        .expect("svp must not be accepted as a score source");
        assert!(error.contains("格式不受支持"));
        fs::remove_file(path).expect("remove svp fixture");
    }

    fn temporary_score_path(extension: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "synthv-toolbox-score-import-{}-{nonce}.{extension}",
            std::process::id()
        ))
    }
}
