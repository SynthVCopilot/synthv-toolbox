use serde_json::{json, Value};

use crate::mcp::{extract_mcp_json, McpManager};

pub async fn import_monophonic_midi(
    manager: &McpManager,
    midi_path: &str,
    track_index: u32,
    group_name: &str,
) -> Result<Value, String> {
    if track_index == 0 || track_index > 10_000 {
        return Err("SynthV 目标轨道编号必须从 1 开始。".to_string());
    }
    let group_name = group_name.trim();
    if group_name.is_empty() || group_name.chars().count() > 200 {
        return Err("导入音符组名称不能为空且不能超过 200 个字符。".to_string());
    }
    let inspection = call_json(
        manager,
        "sv_query",
        json!({
            "action": "inspect_score_file",
            "args": { "filePath": midi_path, "previewNoteLimit": 64 },
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
                "trackIndex": track_index,
                "groupIndex": 1,
                "filePath": midi_path,
                "expectedFileFingerprint": fingerprint,
                "rightsConfirmed": true,
                "grouping": "ensureNonMain",
                "groupName": group_name,
                "sharedGroupPolicy": "reject",
                "previewNoteLimit": 64
            },
            "expectedEffect": "mustChange"
        }),
    )
    .await?;
    Ok(json!({ "inspection": inspection, "import": imported }))
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
    use super::*;

    #[test]
    fn recursively_finds_bridge_projection_fields() {
        let value = json!({ "result": { "fileFingerprint": "sha256:abc" } });
        assert_eq!(find_string(&value, "fileFingerprint"), Some("sha256:abc"));
    }
}
