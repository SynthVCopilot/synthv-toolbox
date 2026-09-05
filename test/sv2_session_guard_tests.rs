use super::*;

fn fixture() -> (PathBuf, PathBuf, String, Sv2SessionGuardStore) {
    let root = std::env::temp_dir().join(format!("sv2-session-guard-{}", Uuid::new_v4()));
    let metadata = root.join("metadata");
    let data = root.join("data");
    fs::create_dir_all(data.join("license")).unwrap();
    let slot_id = Uuid::new_v4().to_string();
    let store = Sv2SessionGuardStore::new(&metadata);
    (root, data, slot_id, store)
}

#[test]
fn missing_session_becomes_recoverable_and_is_restored_before_next_launch() {
    let (root, data, slot_id, store) = fixture();
    fs::write(session_path(&data), b"opaque-session").unwrap();
    let first = store.prepare_launch(&slot_id, &data).unwrap();
    assert!(first.snapshot_armed);
    fs::remove_file(session_path(&data)).unwrap();

    let pending = store.view(&slot_id, &data, false).unwrap();
    assert_eq!(pending.status, Sv2SessionProtectionStatus::RecoveryPending);

    let second = store.prepare_launch(&slot_id, &data).unwrap();
    assert!(second.restored_before_launch);
    assert!(second.snapshot_armed);
    assert_eq!(fs::read(session_path(&data)).unwrap(), b"opaque-session");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_new_session_is_never_overwritten_by_the_snapshot() {
    let (root, data, slot_id, store) = fixture();
    fs::write(session_path(&data), b"old-session").unwrap();
    store.prepare_launch(&slot_id, &data).unwrap();
    fs::remove_file(session_path(&data)).unwrap();
    store.view(&slot_id, &data, false).unwrap();
    fs::write(session_path(&data), b"new-session").unwrap();

    let next = store.prepare_launch(&slot_id, &data).unwrap();
    assert!(!next.restored_before_launch);
    assert_eq!(fs::read(session_path(&data)).unwrap(), b"new-session");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn clean_exit_removes_the_short_lived_snapshot() {
    let (root, data, slot_id, store) = fixture();
    fs::write(session_path(&data), b"session").unwrap();
    store.prepare_launch(&slot_id, &data).unwrap();
    let clean = store.view(&slot_id, &data, false).unwrap();
    assert_eq!(clean.status, Sv2SessionProtectionStatus::Ready);
    assert!(!clean.snapshot_available);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_session_removed_outside_the_window_is_not_attributed_or_restored() {
    let (root, data, slot_id, store) = fixture();
    fs::write(session_path(&data), b"session").unwrap();
    store.prepare_launch(&slot_id, &data).unwrap();
    let mut record = store.load_record(&slot_id).unwrap();
    record.armed_at_utc = Some(
        (Utc::now() - chrono::Duration::seconds(SESSION_RECOVERY_WINDOW_SECONDS + 1)).to_rfc3339(),
    );
    store.save_record(&record).unwrap();
    fs::remove_file(session_path(&data)).unwrap();

    let view = store.view(&slot_id, &data, false).unwrap();
    assert_eq!(view.status, Sv2SessionProtectionStatus::SessionAbsent);
    assert!(!view.snapshot_available);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn one_slot_uses_one_guard_record() {
    let (root, data, slot_id, store) = fixture();
    fs::write(session_path(&data), b"session").unwrap();
    store.prepare_launch(&slot_id, &data).unwrap();
    assert!(store.record_path(&slot_id).is_file());
    assert!(store.snapshot_path(&slot_id).is_file());
    assert_eq!(fs::read_dir(store.root.join(&slot_id)).unwrap().count(), 2);
    fs::remove_dir_all(root).unwrap();
}
