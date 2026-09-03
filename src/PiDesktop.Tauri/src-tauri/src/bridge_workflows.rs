use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

use crate::mcp::{extract_mcp_json, McpManager};
use crate::synthv::find_node;
use crate::tuning_profiles::TuningProfile;

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
    current_project_file_from_standard_reads(&status, &Value::Null)
}

pub fn current_project_file_from_standard_reads(
    project: &Value,
    status: &Value,
) -> Result<String, String> {
    [project, status]
        .into_iter()
        .find_map(find_standard_project_file)
        .map(str::to_string)
        .ok_or_else(|| "当前 SynthV 工程尚未保存为 .svp；无法验证 Cover 工程输出。".to_string())
}

pub fn parse_cover_midi(bridge_dir: &Path, midi_path: &str) -> Result<Value, String> {
    let path = Path::new(midi_path);
    if !path.is_absolute() || !path.is_file() {
        return Err("Cover MIDI 路径必须是存在的绝对本地文件。".to_string());
    }
    let node = find_node().ok_or_else(|| "未找到兼容的本地扩展运行时。".to_string())?;
    let script = bridge_dir.join("scripts/cover-score-notes.mjs");
    if !script.is_file() || !bridge_dir.join("dist/src/score-import.js").is_file() {
        return Err("当前应用包不包含 Cover 曲谱转换器。".to_string());
    }
    let output = Command::new(node)
        .arg(script)
        .arg(path)
        .current_dir(bridge_dir)
        .output()
        .map_err(|error| format!("无法启动 Cover 曲谱转换器：{error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "Cover 曲谱转换器失败。".to_string()
        } else {
            format!("Cover 曲谱转换器失败：{detail}")
        });
    }
    let parsed: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Cover 曲谱转换器输出无效：{error}"))?;
    let note_count = parsed
        .get("notes")
        .and_then(Value::as_array)
        .map(Vec::len)
        .filter(|count| (1..=512).contains(count))
        .ok_or_else(|| "Cover 曲谱转换器没有返回 1–512 个可写入音符。".to_string())?;
    if parsed.get("noteCount").and_then(Value::as_u64) != Some(note_count as u64) {
        return Err("Cover 曲谱转换器返回的音符计数不一致。".to_string());
    }
    Ok(parsed)
}

pub async fn apply_tuning_profile(
    manager: &McpManager,
    profile: &TuningProfile,
    track_index: u32,
    group_index: u32,
) -> Result<Value, String> {
    if track_index == 0 || group_index == 0 {
        return Err("轨道和音符组编号必须从 1 开始。".to_string());
    }
    let context = call_json(
        manager,
        "sv_query",
        json!({
            "action": "get_track_notes",
            "args": { "trackIndex": track_index, "groupIndex": group_index, "offset": 0, "limit": 512 },
            "contextMode": "writeIntent",
            "dense": "never",
            "debug": false
        }),
    )
    .await?;
    let context_id = find_string(&context, "contextId")
        .ok_or_else(|| "Bridge 没有返回可安全写入的音符组 Context。".to_string())?;
    let parameters = &profile.parameters;
    let note_edits = collect_note_indices(&context)
        .into_iter()
        .map(|note_index| {
            json!({
                "noteIndex": note_index,
                "changes": { "attributes": { "dF0VbrMod": parameters.vibrato_strength } }
            })
        })
        .collect::<Vec<_>>();
    let mut args = json!({
        "trackIndex": track_index,
        "groupIndex": group_index,
        "summary": format!("应用 {} 的本地学习调声档案", profile.voice_name),
        "requireCurrentEditorGroup": false,
        "voice": {
            "parameters": {
                "loudness": parameters.loudness,
                "tension": parameters.tension,
                "breathiness": parameters.breathiness,
                "gender": parameters.gender,
                "toneShift": parameters.tone_shift
            }
        }
    });
    if !note_edits.is_empty() {
        args["noteEdits"] = Value::Array(note_edits);
    }
    let applied = call_json(
        manager,
        "sv_command",
        json!({
            "action": "apply_group_tuning",
            "args": args,
            "contextId": context_id,
            "expectedEffect": "allowAlreadySatisfied"
        }),
    )
    .await?;
    Ok(json!({
        "profile": profile,
        "context": context,
        "applied": applied,
        "vibratoStrength": parameters.vibrato_strength,
        "vibratoApplied": !collect_note_indices(&context).is_empty(),
        "vibratoNoteCount": collect_note_indices(&context).len()
    }))
}

fn collect_note_indices(value: &Value) -> Vec<u64> {
    let mut output = Vec::new();
    collect_note_indices_into(value, &mut output);
    output.sort_unstable();
    output.dedup();
    output.truncate(512);
    output
}

fn collect_note_indices_into(value: &Value, output: &mut Vec<u64>) {
    match value {
        Value::Object(object) => {
            if let Some(notes) = object.get("notes").and_then(Value::as_array) {
                output.extend(
                    notes
                        .iter()
                        .filter_map(|note| note.get("noteIndex")?.as_u64()),
                );
            }
            for child in object.values() {
                collect_note_indices_into(child, output);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_note_indices_into(item, output);
            }
        }
        _ => {}
    }
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

fn find_standard_project_file(value: &Value) -> Option<&str> {
    match value {
        Value::Object(object) => ["projectFile", "fileName", "filePath"]
            .into_iter()
            .find_map(|key| {
                object
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|path| !path.trim().is_empty())
            })
            .or_else(|| object.values().find_map(find_standard_project_file)),
        Value::Array(items) => items.iter().find_map(find_standard_project_file),
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
    fn finds_project_path_from_standard_project_or_status_reads() {
        let path = current_project_file_from_standard_reads(
            &json!({ "fileName": "" }),
            &json!({ "project": { "filePath": "/tmp/cover.svp" } }),
        )
        .expect("standard host path");
        assert_eq!(path, "/tmp/cover.svp");
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
