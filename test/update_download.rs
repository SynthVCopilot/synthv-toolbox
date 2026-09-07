use super::*;

#[test]
fn cancel_preserves_a_safe_observable_state() {
    let state = cancel();
    assert!(matches!(
        state.status.as_str(),
        "idle" | "downloading" | "ready" | "failed" | "cancelled"
    ));
}
