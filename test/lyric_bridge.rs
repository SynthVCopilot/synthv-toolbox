use serde_json::json;
use std::fs;
use std::path::PathBuf;

use super::*;
use crate::mcp::McpManager;

fn selection(notes: serde_json::Value) -> serde_json::Value {
    json!({
        "contextId": "selection-context",
        "current": { "trackIndex": 2, "groupIndex": 1 },
        "selectedNotes": notes,
    })
}

#[test]
fn selection_requires_at_least_one_note() {
    assert!(parse_selection(&selection(json!([])), "session-a".to_string()).is_err());
}

#[test]
fn unfinished_edits_are_refused() {
    let unfinished = json!({
        "contextId": "selection-context",
        "pianoRollHasUnfinishedEdits": true,
        "current": { "trackIndex": 2, "groupIndex": 1 },
        "selectedNotes": [{ "noteIndex": 1 }],
    });
    assert!(parse_selection(&unfinished, "session-a".to_string()).is_err());
}

#[test]
fn inconsistent_or_duplicate_selection_is_refused() {
    let inconsistent = json!({
        "contextId": "selection-context",
        "selectedNoteCount": 2,
        "current": { "trackIndex": 2, "groupIndex": 1 },
        "selectedNotes": [{ "noteIndex": 1 }],
    });
    assert!(parse_selection(&inconsistent, "session-a".to_string()).is_err());
    let duplicate = selection(json!([{ "noteIndex": 1 }, { "noteIndex": 1 }]));
    assert!(parse_selection(&duplicate, "session-a".to_string()).is_err());
}

#[test]
fn selection_change_invalidates_an_existing_preview_snapshot() {
    let original = parse_selection(
        &selection(json!([{ "noteIndex": 1 }, { "noteIndex": 2 }])),
        "session-a".to_string(),
    )
    .unwrap();
    let changed = parse_selection(
        &selection(json!([{ "noteIndex": 1 }, { "noteIndex": 3 }])),
        "session-a".to_string(),
    )
    .unwrap();
    assert!(!same_selection(&original, &changed));
}

#[test]
fn slots_must_match_the_selected_note_count() {
    let slots = vec![LyricBridgeSlot {
        text: "你".to_string(),
        phoneme: None,
    }];
    assert!(validate_slots(&slots, 2).is_err());
    assert!(validate_slots(
        &[LyricBridgeSlot {
            text: " ".to_string(),
            phoneme: None
        }],
        1
    )
    .is_err());
    assert!(validate_slots(&slots, 1).is_ok());
}

#[test]
fn preview_token_is_single_use_for_confirmation() {
    let selection_token = Uuid::new_v4().to_string();
    store_selection(
        selection_token.clone(),
        parse_selection(
            &selection(json!([{ "noteIndex": 1 }])),
            "session-a".to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    let preview = preview(LyricBridgePreviewRequest {
        selection_token,
        session_token: "session-a".to_string(),
        slots: vec![LyricBridgeSlot {
            text: "你".to_string(),
            phoneme: None,
        }],
    })
    .unwrap();
    assert!(take_preview(&preview.preview_token).is_ok());
    assert!(take_preview(&preview.preview_token).is_err());
}

#[test]
fn expired_preview_token_is_rejected() {
    let selection_token = Uuid::new_v4().to_string();
    store_selection(
        selection_token.clone(),
        parse_selection(
            &selection(json!([{ "noteIndex": 1 }])),
            "session-a".to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    let preview = preview(LyricBridgePreviewRequest {
        selection_token,
        session_token: "session-a".to_string(),
        slots: vec![LyricBridgeSlot {
            text: "你".to_string(),
            phoneme: None,
        }],
    })
    .unwrap();
    PREVIEWS
        .get()
        .unwrap()
        .lock()
        .unwrap()
        .get_mut(&preview.preview_token)
        .unwrap()
        .expires_at = Instant::now() - Duration::from_secs(1);
    assert!(take_preview(&preview.preview_token).is_err());
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/fixtures/lyric-bridge-mcp.mjs")
}

fn log_path(mode: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "lyric-bridge-{mode}-{}.jsonl",
        uuid::Uuid::new_v4()
    ))
}

async fn connected_fixture(mode: &str) -> (McpManager, PathBuf) {
    let manager = McpManager::default();
    let log = log_path(mode);
    manager
        .connect_stdio_host(
            "synthv".to_string(),
            "fixture".to_string(),
            "node".to_string(),
            vec![
                fixture_path().to_string_lossy().into_owned(),
                mode.to_string(),
                log.to_string_lossy().into_owned(),
            ],
            None,
        )
        .await
        .expect("connect fixture");
    (manager, log)
}

fn calls(log: &PathBuf) -> Vec<serde_json::Value> {
    fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).expect("fixture log JSON"))
        .collect()
}

#[tokio::test]
async fn confirm_uses_the_original_context_and_omits_empty_phonemes() {
    let (manager, log) = connected_fixture("stable").await;
    let selection = read_selection(&manager).await.unwrap();
    assert_eq!(selection.notes[0].note_index, 1);
    let preview = preview(LyricBridgePreviewRequest {
        selection_token: selection.selection_token,
        session_token: selection.session_token,
        slots: vec![
            LyricBridgeSlot {
                text: "新".to_string(),
                phoneme: None,
            },
            LyricBridgeSlot {
                text: "词".to_string(),
                phoneme: None,
            },
        ],
    })
    .unwrap();
    confirm(
        &manager,
        LyricBridgeConfirmRequest {
            preview_token: preview.preview_token.clone(),
        },
    )
    .await
    .unwrap();
    assert!(confirm(
        &manager,
        LyricBridgeConfirmRequest {
            preview_token: preview.preview_token,
        },
    )
    .await
    .is_err());
    manager.disconnect("synthv").await;
    let commands = calls(&log)
        .into_iter()
        .filter(|call| call["name"] == "sv_command")
        .collect::<Vec<_>>();
    assert_eq!(commands.len(), 1);
    let command = &commands[0];
    assert_eq!(command["args"]["contextId"], "old-selection-context");
    assert_eq!(command["args"]["action"], "fit_lyrics");
    assert_eq!(
        command["args"]["args"]["notes"],
        json!([{ "noteIndex": 1 }, { "noteIndex": 2 }])
    );
    assert_eq!(command["args"]["args"]["syllables"], json!(["新", "词"]));
    assert!(command["args"]["args"].get("phonemes").is_none());
    assert_eq!(command["args"]["args"]["sharedGroupPolicy"], "reject");
    let _ = fs::remove_file(log);
}

#[tokio::test]
async fn changed_session_or_selection_rejects_before_writing() {
    for mode in ["session-change", "selection-change"] {
        let (manager, log) = connected_fixture(mode).await;
        let selection = read_selection(&manager).await.unwrap();
        let preview = preview(LyricBridgePreviewRequest {
            selection_token: selection.selection_token,
            session_token: selection.session_token,
            slots: vec![
                LyricBridgeSlot {
                    text: "新".to_string(),
                    phoneme: None,
                },
                LyricBridgeSlot {
                    text: "词".to_string(),
                    phoneme: None,
                },
            ],
        })
        .unwrap();
        assert!(confirm(
            &manager,
            LyricBridgeConfirmRequest {
                preview_token: preview.preview_token
            }
        )
        .await
        .is_err());
        manager.disconnect("synthv").await;
        assert!(calls(&log)
            .into_iter()
            .all(|call| call["name"] != "sv_command"));
        let _ = fs::remove_file(log);
    }
}

#[test]
fn selection_can_be_previewed_again_after_a_text_correction() {
    let selection_token = Uuid::new_v4().to_string();
    store_selection(
        selection_token.clone(),
        parse_selection(&selection(json!([{ "noteIndex": 1 }])), "session-a".into()).unwrap(),
    )
    .unwrap();
    let request = |text: &str| LyricBridgePreviewRequest {
        selection_token: selection_token.clone(),
        session_token: "session-a".into(),
        slots: vec![LyricBridgeSlot {
            text: text.into(),
            phoneme: None,
        }],
    };
    assert!(preview(request("")).is_err());
    let first = preview(request("晨")).unwrap();
    let corrected = preview(request("风")).unwrap();
    assert_ne!(first.preview_token, corrected.preview_token);
    assert_eq!(corrected.notes[0].text, "风");
}
