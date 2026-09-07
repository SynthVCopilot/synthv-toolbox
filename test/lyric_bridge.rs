use serde_json::json;

use crate::lyric_bridge::{
    consume_preview_token, preview, seed_selection, selection_from_value, selections_match,
    slots_are_valid, LyricBridgePreviewRequest, LyricBridgeSlot,
};

fn selection(notes: serde_json::Value) -> serde_json::Value {
    json!({
        "contextId": "selection-context",
        "current": { "trackIndex": 2, "groupIndex": 1 },
        "selectedNotes": notes,
    })
}

#[test]
fn selection_requires_at_least_one_note() {
    assert!(selection_from_value(&selection(json!([])), "session-a").is_err());
}

#[test]
fn unfinished_edits_are_refused() {
    let unfinished = json!({
        "contextId": "selection-context",
        "pianoRollHasUnfinishedEdits": true,
        "current": { "trackIndex": 2, "groupIndex": 1 },
        "selectedNotes": [{ "noteIndex": 1 }],
    });
    assert!(selection_from_value(&unfinished, "session-a").is_err());
}

#[test]
fn inconsistent_or_duplicate_selection_is_refused() {
    let inconsistent = json!({
        "contextId": "selection-context",
        "selectedNoteCount": 2,
        "current": { "trackIndex": 2, "groupIndex": 1 },
        "selectedNotes": [{ "noteIndex": 1 }],
    });
    assert!(selection_from_value(&inconsistent, "session-a").is_err());
    let duplicate = selection(json!([{ "noteIndex": 1 }, { "noteIndex": 1 }]));
    assert!(selection_from_value(&duplicate, "session-a").is_err());
}

#[test]
fn selection_change_invalidates_an_existing_preview_snapshot() {
    let original = selection_from_value(
        &selection(json!([{ "noteIndex": 1 }, { "noteIndex": 2 }])),
        "session-a",
    )
    .unwrap();
    let changed = selection_from_value(
        &selection(json!([{ "noteIndex": 1 }, { "noteIndex": 3 }])),
        "session-a",
    )
    .unwrap();
    assert!(!selections_match(&original, &changed));
}

#[test]
fn slots_must_match_the_selected_note_count() {
    let slots = vec![LyricBridgeSlot {
        text: "你".to_string(),
        phoneme: None,
    }];
    assert!(slots_are_valid(&slots, 2).is_err());
    assert!(slots_are_valid(
        &[LyricBridgeSlot {
            text: " ".to_string(),
            phoneme: None
        }],
        1
    )
    .is_err());
    assert!(slots_are_valid(&slots, 1).is_ok());
}

#[test]
fn preview_token_is_single_use_for_confirmation() {
    let selection_token =
        seed_selection(&selection(json!([{ "noteIndex": 1 }])), "session-a").unwrap();
    let preview = preview(LyricBridgePreviewRequest {
        selection_token,
        session_token: "session-a".to_string(),
        slots: vec![LyricBridgeSlot {
            text: "你".to_string(),
            phoneme: None,
        }],
    })
    .unwrap();
    assert!(consume_preview_token(&preview.preview_token).is_ok());
    assert!(consume_preview_token(&preview.preview_token).is_err());
}
