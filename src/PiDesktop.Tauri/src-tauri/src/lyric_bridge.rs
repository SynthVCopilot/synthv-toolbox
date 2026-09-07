use std::collections::{BTreeSet, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::mcp::{extract_mcp_json, McpManager};

const PREVIEW_LIFETIME: Duration = Duration::from_secs(300);
const MAX_NOTES: usize = 512;
const MAX_STORED_TOKENS: usize = 128;
const BRIDGE_CALL_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricBridgeNote {
    pub note_index: u32,
    pub lyric: String,
    pub onset: Option<i64>,
    pub duration: Option<i64>,
    pub pitch: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricBridgeTarget {
    pub track_index: u32,
    pub group_index: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricBridgeSelection {
    pub selection_token: String,
    pub session_token: String,
    pub target: LyricBridgeTarget,
    pub notes: Vec<LyricBridgeNote>,
    pub note_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricBridgeSlot {
    pub text: String,
    #[serde(default)]
    pub phoneme: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricBridgePreviewRequest {
    pub selection_token: String,
    pub session_token: String,
    pub slots: Vec<LyricBridgeSlot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricBridgePreviewNote {
    pub note_index: u32,
    pub current_lyric: String,
    pub text: String,
    pub phoneme: Option<String>,
    pub onset: Option<i64>,
    pub duration: Option<i64>,
    pub pitch: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricBridgePreview {
    pub preview_token: String,
    pub session_token: String,
    pub target: LyricBridgeTarget,
    pub notes: Vec<LyricBridgePreviewNote>,
    pub slot_count: usize,
    pub expires_in_seconds: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricBridgeConfirmRequest {
    pub preview_token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricBridgeCommit {
    pub applied: bool,
    pub target: LyricBridgeTarget,
    pub note_count: usize,
}

#[derive(Debug, Clone)]
struct GuardedNote {
    view: LyricBridgeNote,
}

#[derive(Debug, Clone)]
struct StoredSelection {
    session_token: String,
    context_id: String,
    selection_revision: Option<String>,
    target: LyricBridgeTarget,
    notes: Vec<GuardedNote>,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
struct StoredPreview {
    selection: StoredSelection,
    slots: Vec<LyricBridgeSlot>,
    expires_at: Instant,
}

static SELECTIONS: OnceLock<Mutex<HashMap<String, StoredSelection>>> = OnceLock::new();
static PREVIEWS: OnceLock<Mutex<HashMap<String, StoredPreview>>> = OnceLock::new();

pub async fn read_selection(manager: &McpManager) -> Result<LyricBridgeSelection, String> {
    let session_token = bridge_session_token(manager).await?;
    let selection = call_json(
        manager,
        "sv_query",
        json!({ "action": "get_selection", "args": {}, "contextMode": "writeIntent", "dense": "never", "debug": false }),
    )
    .await?;
    let current_session = bridge_session_token(manager).await?;
    if current_session != session_token {
        return Err("SynthV 会话在读取选区时变化；请重新读取。".to_string());
    }
    let stored = parse_selection(&selection, session_token)?;
    let selection_token = Uuid::new_v4().to_string();
    store_selection(selection_token.clone(), stored.clone())?;
    let note_count = stored.notes.len();
    Ok(LyricBridgeSelection {
        selection_token,
        session_token: stored.session_token,
        target: stored.target,
        notes: stored
            .notes
            .into_iter()
            .map(|note| note.view)
            .collect::<Vec<_>>(),
        note_count,
    })
}

pub fn preview(request: LyricBridgePreviewRequest) -> Result<LyricBridgePreview, String> {
    let selection = get_selection(&request.selection_token)?;
    if request.session_token != selection.session_token {
        return Err("当前 SynthV 会话已变化；请重新读取选中的音符。".to_string());
    }
    validate_slots(&request.slots, selection.notes.len())?;
    let preview_token = Uuid::new_v4().to_string();
    store_preview(
        preview_token.clone(),
        StoredPreview {
            selection: selection.clone(),
            slots: request.slots.clone(),
            expires_at: Instant::now() + PREVIEW_LIFETIME,
        },
    )?;
    Ok(LyricBridgePreview {
        preview_token,
        session_token: selection.session_token,
        target: selection.target,
        notes: selection
            .notes
            .iter()
            .zip(&request.slots)
            .map(|(note, slot)| LyricBridgePreviewNote {
                note_index: note.view.note_index,
                current_lyric: note.view.lyric.clone(),
                text: slot.text.trim().to_string(),
                phoneme: normalized_phoneme(slot),
                onset: note.view.onset,
                duration: note.view.duration,
                pitch: note.view.pitch,
            })
            .collect(),
        slot_count: request.slots.len(),
        expires_in_seconds: PREVIEW_LIFETIME.as_secs(),
    })
}

pub async fn confirm(
    manager: &McpManager,
    request: LyricBridgeConfirmRequest,
) -> Result<LyricBridgeCommit, String> {
    let preview = take_preview(&request.preview_token)?;
    let session_token = bridge_session_token(manager).await?;
    if session_token != preview.selection.session_token {
        return Err("当前 SynthV 会话已变化；预览已失效，请重新读取选区。".to_string());
    }
    let current = call_json(manager, "sv_query", json!({ "action": "get_selection", "args": {}, "contextMode": "writeIntent", "dense": "never", "debug": false })).await?;
    let current = parse_selection(&current, session_token)?;
    if !same_selection(&preview.selection, &current) {
        return Err("SynthV 选区或音符已变化；预览已失效，请重新读取选区。".to_string());
    }
    let notes = preview
        .selection
        .notes
        .iter()
        .map(|note| json!({ "noteIndex": note.view.note_index }))
        .collect::<Vec<_>>();
    let syllables = preview
        .slots
        .iter()
        .map(|slot| slot.text.trim())
        .collect::<Vec<_>>();
    let mut args = json!({ "trackIndex": preview.selection.target.track_index, "groupIndex": preview.selection.target.group_index, "notes": notes, "syllables": syllables, "fillRemainder": "reject", "sharedGroupPolicy": "reject" });
    if preview.slots.first().and_then(normalized_phoneme).is_some() {
        args["phonemes"] = json!(preview
            .slots
            .iter()
            .filter_map(normalized_phoneme)
            .collect::<Vec<_>>());
    }
    let final_session = bridge_session_token(manager).await?;
    if final_session != preview.selection.session_token {
        return Err("SynthV 会话在确认时变化；预览已失效。".to_string());
    }
    call_json(
        manager,
        "sv_command",
        json!({
            "action": "fit_lyrics",
            "args": args,
            "contextId": preview.selection.context_id,
            "expectedEffect": "mustChange"
        }),
    )
    .await?;
    Ok(LyricBridgeCommit {
        applied: true,
        target: preview.selection.target,
        note_count: preview.selection.notes.len(),
    })
}

fn validate_slots(slots: &[LyricBridgeSlot], expected: usize) -> Result<(), String> {
    if slots.len() != expected {
        return Err(format!(
            "歌词槽位数量必须与选中的 {expected} 个音符完全一致。"
        ));
    }
    if slots.is_empty() || slots.len() > MAX_NOTES {
        return Err("必须选择 1–512 个音符并为每个音符提供一个歌词槽位。".to_string());
    }
    if slots.iter().any(|slot| {
        slot.text.trim().is_empty()
            || slot.text.chars().count() > 1000
            || slot
                .phoneme
                .as_ref()
                .is_some_and(|value| value.chars().count() > 4000)
    }) {
        return Err(
            "每个歌词槽位必须包含不超过 1000 个字符的文本；音素不能超过 4000 个字符。".to_string(),
        );
    }
    let phoneme_count = slots.iter().filter_map(normalized_phoneme).count();
    if phoneme_count != 0 && phoneme_count != slots.len() {
        return Err("音素必须为所有歌词槽位同时提供，或全部留空。".to_string());
    }
    Ok(())
}

fn normalized_phoneme(slot: &LyricBridgeSlot) -> Option<String> {
    slot.phoneme
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn same_selection(left: &StoredSelection, right: &StoredSelection) -> bool {
    left.target.track_index == right.target.track_index
        && left.target.group_index == right.target.group_index
        && left.selection_revision == right.selection_revision
        && left.notes.len() == right.notes.len()
        && left.notes.iter().zip(&right.notes).all(|(a, b)| {
            a.view.note_index == b.view.note_index
                && a.view.lyric == b.view.lyric
                && a.view.onset == b.view.onset
                && a.view.duration == b.view.duration
                && a.view.pitch == b.view.pitch
        })
}

fn parse_selection(value: &Value, session_token: String) -> Result<StoredSelection, String> {
    let current = value
        .get("current")
        .and_then(Value::as_object)
        .ok_or_else(|| "Bridge 没有返回当前音符组。".to_string())?;
    if value
        .get("pianoRollHasUnfinishedEdits")
        .and_then(Value::as_bool)
        == Some(true)
        || value
            .get("arrangementHasUnfinishedEdits")
            .and_then(Value::as_bool)
            == Some(true)
    {
        return Err("SynthV 有未完成的编辑；请先完成或取消编辑后再填词。".to_string());
    }
    let target = LyricBridgeTarget {
        track_index: positive(current.get("trackIndex"))?,
        group_index: positive(current.get("groupIndex"))?,
    };
    let context_id = string_field(value, "contextId")
        .ok_or_else(|| "Bridge 没有返回可写入的选区上下文。".to_string())?;
    let mut notes = value
        .get("selectedNotes")
        .and_then(Value::as_array)
        .ok_or_else(|| "Bridge 没有返回选中的音符。".to_string())?
        .iter()
        .map(parse_note)
        .collect::<Result<Vec<_>, _>>()?;
    if notes.is_empty() || notes.len() > MAX_NOTES {
        return Err("请选择 1–512 个可写入的音符。".to_string());
    }
    if value
        .get("selectedNoteCount")
        .and_then(Value::as_u64)
        .is_some_and(|count| count != notes.len() as u64)
    {
        return Err("Bridge 返回的选中音符计数不一致；请重新读取选区。".to_string());
    }
    let indices = notes
        .iter()
        .map(|note| note.view.note_index)
        .collect::<BTreeSet<_>>();
    if indices.len() != notes.len() {
        return Err("Bridge 返回了重复的选中音符；请重新读取选区。".to_string());
    }
    notes.sort_by_key(|note| (note.view.onset.unwrap_or(i64::MAX), note.view.note_index));
    Ok(StoredSelection {
        session_token,
        context_id,
        selection_revision: value.get("selectionRevision").map(Value::to_string),
        target,
        notes,
        expires_at: Instant::now() + PREVIEW_LIFETIME,
    })
}

fn parse_note(value: &Value) -> Result<GuardedNote, String> {
    let note_index = positive(value.get("noteIndex"))?;
    Ok(GuardedNote {
        view: LyricBridgeNote {
            note_index,
            lyric: string_field(value, "lyrics").unwrap_or_default(),
            onset: integer(value.get("onset")),
            duration: integer(value.get("duration")),
            pitch: integer(value.get("pitch")),
        },
    })
}

fn positive(value: Option<&Value>) -> Result<u32, String> {
    value
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "Bridge 返回了无效的音符组定位信息。".to_string())
}
fn integer(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}
fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

async fn bridge_session_token(manager: &McpManager) -> Result<String, String> {
    let status = call_json(manager, "sv_status", json!({ "operation": "bridge" })).await?;
    crate::synthv_unified::bridge_session_token(&status)
}
async fn call_json(manager: &McpManager, tool: &str, arguments: Value) -> Result<Value, String> {
    let response = tokio::time::timeout(
        BRIDGE_CALL_TIMEOUT,
        manager.call_bridge_tool(tool, arguments),
    )
    .await
    .map_err(|_| "SynthV Bridge 调用超时。".to_string())??;
    extract_mcp_json(&response)
}

fn store_selection(token: String, selection: StoredSelection) -> Result<(), String> {
    let mut store = SELECTIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "选区服务暂时不可用。".to_string())?;
    store.retain(|_, value| value.expires_at > Instant::now());
    if store.len() >= MAX_STORED_TOKENS {
        store.clear();
    }
    store.insert(token, selection);
    Ok(())
}
fn get_selection(token: &str) -> Result<StoredSelection, String> {
    let store = SELECTIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "选区服务暂时不可用。".to_string())?;
    let value = store
        .get(token)
        .cloned()
        .ok_or_else(|| "选区身份已失效；请重新读取选中的音符。".to_string())?;
    if value.expires_at <= Instant::now() {
        Err("选区身份已过期；请重新读取选中的音符。".to_string())
    } else {
        Ok(value)
    }
}
fn store_preview(token: String, preview: StoredPreview) -> Result<(), String> {
    let mut store = PREVIEWS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "预览服务暂时不可用。".to_string())?;
    store.retain(|_, value| value.expires_at > Instant::now());
    if store.len() >= MAX_STORED_TOKENS {
        store.clear();
    }
    store.insert(token, preview);
    Ok(())
}
fn take_preview(token: &str) -> Result<StoredPreview, String> {
    let mut store = PREVIEWS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "预览服务暂时不可用。".to_string())?;
    let value = store
        .remove(token)
        .ok_or_else(|| "预览已失效；请重新预览后再确认。".to_string())?;
    if value.expires_at <= Instant::now() {
        Err("预览已过期；请重新预览后再确认。".to_string())
    } else {
        Ok(value)
    }
}

#[cfg(test)]
#[path = "../../../../test/lyric_bridge.rs"]
mod tests;
