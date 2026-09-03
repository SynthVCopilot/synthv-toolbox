use std::fs;
use std::path::PathBuf;

use synthv_toolbox_lib::agent_files::FileApprovalManager;
use synthv_toolbox_lib::config::AgentWorkMode;
use uuid::Uuid;

fn test_dir() -> PathBuf {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .or_else(|| std::env::var_os("HOME"))
        .expect("home");
    PathBuf::from(home).join(format!(".SynthVcopilot-approval-test-{}", Uuid::new_v4()))
}

#[test]
fn approval_is_format_aware_session_bound_and_fingerprint_bound() {
    let root = test_dir();
    fs::create_dir_all(&root).expect("create test directory");
    let wav = root.join("voice.wav");
    let docx = root.join("notes.docx");
    let denied = root.join("private.docx");
    fs::write(&wav, b"wav").expect("write wav");
    fs::write(&docx, b"first").expect("write docx");
    fs::write(&denied, b"deny").expect("write denied docx");
    let manager = FileApprovalManager::default();
    let session = "conversation-a";

    assert_eq!(
        manager
            .admit_or_request(
                wav.to_str().unwrap(),
                "analyse audio",
                AgentWorkMode::Edit,
                session
            )
            .unwrap()
            .decision,
        "pass"
    );
    let pending = manager
        .admit_or_request(
            docx.to_str().unwrap(),
            "review document",
            AgentWorkMode::Edit,
            session,
        )
        .unwrap();
    assert_eq!(pending.decision, "human-approval-required");
    let request_id = pending.request_id.expect("request id");
    assert_eq!(manager.pending(session).len(), 1);
    manager.decide(&request_id, true, session).expect("approve");
    assert_eq!(
        manager
            .admit_or_request(
                docx.to_str().unwrap(),
                "review document",
                AgentWorkMode::Edit,
                session
            )
            .unwrap()
            .decision,
        "pass"
    );
    assert_eq!(
        manager
            .admit_or_request(
                docx.to_str().unwrap(),
                "review document",
                AgentWorkMode::Solo,
                "conversation-b"
            )
            .unwrap()
            .decision,
        "pass"
    );

    fs::write(&docx, b"replacement with a different size").expect("replace docx");
    assert_eq!(
        manager
            .admit_or_request(
                docx.to_str().unwrap(),
                "review replacement",
                AgentWorkMode::Edit,
                session
            )
            .unwrap()
            .decision,
        "human-approval-required"
    );

    let denied_request = manager
        .admit_or_request(
            denied.to_str().unwrap(),
            "review private document",
            AgentWorkMode::Edit,
            session,
        )
        .unwrap();
    manager
        .decide(&denied_request.request_id.unwrap(), false, session)
        .expect("deny");
    assert!(manager
        .admit_or_request(
            denied.to_str().unwrap(),
            "review private document",
            AgentWorkMode::Edit,
            session
        )
        .unwrap_err()
        .contains("被拒绝"));
    fs::remove_dir_all(root).expect("cleanup");
}
