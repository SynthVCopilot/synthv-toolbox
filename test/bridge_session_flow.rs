use super::*;
use serde_json::json;

fn heartbeat(connected: bool, fresh: bool, state: &str, session_token: &str) -> serde_json::Value {
    json!({
        "connected": connected,
        "fresh": fresh,
        "status": { "state": state, "sessionToken": session_token }
    })
}

#[test]
fn accepts_only_a_fresh_running_heartbeat_with_a_nested_session_token() {
    assert_eq!(
        synthv_unified::bridge_session_token(&heartbeat(true, true, "running", "session-a"))
            .unwrap(),
        "session-a"
    );
    for status in [
        heartbeat(false, true, "running", "session-a"),
        heartbeat(true, false, "running", "session-a"),
        heartbeat(true, true, "stopped", "session-a"),
        heartbeat(true, true, "running", ""),
    ] {
        assert!(synthv_unified::bridge_session_token(&status).is_err());
    }
}

#[tokio::test]
async fn a_new_session_clears_the_unverified_activation_request() {
    let manager = mcp::McpManager::default();
    assert_eq!(
        manager
            .observe_official_bridge_session("session-a".to_string(), Some(42))
            .await,
        Some(42)
    );
    assert_eq!(
        manager
            .observe_official_bridge_session("session-a".to_string(), None)
            .await,
        Some(42)
    );
    assert_eq!(
        manager
            .observe_official_bridge_session("session-b".to_string(), None)
            .await,
        None
    );
}
