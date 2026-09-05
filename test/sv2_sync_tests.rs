use super::*;

fn roots() -> (PathBuf, PathBuf, PathBuf) {
    let base = std::env::temp_dir().join(format!("sv2-sync-test-{}", Uuid::new_v4()));
    let source = base.join("source");
    let target = base.join("target");
    fs::create_dir_all(source.join("dicts")).unwrap();
    fs::create_dir_all(&target).unwrap();
    (base, source, target)
}

#[test]
fn preview_and_execute_copy_only_allowlisted_content() {
    let (base, source, target) = roots();
    fs::write(source.join("dicts/user.json"), b"hello").unwrap();
    fs::create_dir_all(source.join("license")).unwrap();
    fs::write(source.join("license/token"), b"secret").unwrap();
    let selected = [Sv2SyncCategoryId::UserDictionaries];
    let preview = dry_run(&source, &target, &selected, false).unwrap();
    assert_eq!(preview.entries.len(), 1);
    assert_eq!(preview.entries[0].action, Sv2SyncAction::Copy);
    let result = execute(&source, &target, &selected, &preview, &preview.token).unwrap();
    assert_eq!(result.copied, 1);
    assert!(!target.join("license/token").exists());
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn differing_target_is_conflict_unless_overwrite_was_previewed() {
    let (base, source, target) = roots();
    fs::write(source.join("dicts/a"), b"new").unwrap();
    fs::create_dir_all(target.join("dicts")).unwrap();
    fs::write(target.join("dicts/a"), b"old").unwrap();
    let selected = [Sv2SyncCategoryId::UserDictionaries];
    assert_eq!(
        dry_run(&source, &target, &selected, false).unwrap().entries[0].action,
        Sv2SyncAction::Conflict
    );
    assert_eq!(
        dry_run(&source, &target, &selected, true).unwrap().entries[0].action,
        Sv2SyncAction::Update
    );
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn stale_or_tampered_manifest_is_rejected() {
    let (base, source, target) = roots();
    fs::write(source.join("dicts/a"), b"one").unwrap();
    let selected = [Sv2SyncCategoryId::UserDictionaries];
    let preview = dry_run(&source, &target, &selected, false).unwrap();
    fs::write(source.join("dicts/a"), b"two").unwrap();
    assert!(execute(&source, &target, &selected, &preview, &preview.token).is_err());
    assert!(execute(&source, &target, &selected, &preview, "bad").is_err());
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn manifest_is_bound_to_the_previewed_slot_pair() {
    let (base, source, target) = roots();
    let alternate_target = base.join("alternate-target");
    fs::create_dir_all(&alternate_target).unwrap();
    fs::write(source.join("dicts/a"), b"one").unwrap();
    let selected = [Sv2SyncCategoryId::UserDictionaries];
    let preview = dry_run(&source, &target, &selected, false).unwrap();
    assert!(execute(
        &source,
        &alternate_target,
        &selected,
        &preview,
        &preview.token
    )
    .is_err());
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn traversal_and_protected_names_are_rejected() {
    assert!(safe_relative(Path::new("../license")).is_err());
    assert!(safe_relative(Path::new("settings/session/cache")).is_err());
    assert!(safe_relative(Path::new("dicts/good.json")).is_ok());
}

#[cfg(unix)]
#[test]
fn symlink_in_category_is_rejected() {
    use std::os::unix::fs::symlink;
    let (base, source, target) = roots();
    symlink(&target, source.join("dicts/link")).unwrap();
    assert!(dry_run(
        &source,
        &target,
        &[Sv2SyncCategoryId::UserDictionaries],
        false
    )
    .is_err());
    fs::remove_dir_all(base).unwrap();
}

#[cfg(windows)]
#[test]
fn directory_junction_in_category_is_rejected() {
    use std::os::windows::fs::symlink_dir;
    let (base, source, target) = roots();
    if symlink_dir(&target, source.join("dicts/link")).is_ok() {
        assert!(dry_run(
            &source,
            &target,
            &[Sv2SyncCategoryId::UserDictionaries],
            false
        )
        .is_err());
    }
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn defaults_update_settings_and_scripts_without_protected_data() {
    let (base, source, target) = roots();
    fs::create_dir_all(source.join("settings")).unwrap();
    fs::create_dir_all(source.join("scripts")).unwrap();
    fs::write(source.join("settings/settings.xml"), b"new-settings").unwrap();
    fs::write(source.join("scripts/tool.lua"), b"script").unwrap();
    fs::create_dir_all(source.join("database")).unwrap();
    fs::write(source.join("database/token"), b"secret").unwrap();
    fs::create_dir_all(target.join("settings")).unwrap();
    fs::write(target.join("settings/settings.xml"), b"old-settings").unwrap();
    let result = sync_defaults(&source, &target).unwrap();
    assert_eq!(result.updated, 1);
    assert_eq!(result.copied, 1);
    assert_eq!(
        fs::read(target.join("settings/settings.xml")).unwrap(),
        b"new-settings"
    );
    assert_eq!(
        fs::read(target.join("scripts/tool.lua")).unwrap(),
        b"script"
    );
    assert!(!target.join("database/token").exists());
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn settings_file_root_is_supported_and_symlink_is_rejected() {
    let (base, source, target) = roots();
    fs::create_dir_all(source.join("settings")).unwrap();
    fs::write(source.join("settings/settings.xml"), b"settings").unwrap();
    let selected = [Sv2SyncCategoryId::SafeSettings];
    let preview = dry_run(&source, &target, &selected, true).unwrap();
    assert_eq!(preview.entries[0].action, Sv2SyncAction::Copy);
    let _ = execute(&source, &target, &selected, &preview, &preview.token).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(&target, source.join("scripts")).unwrap();
        assert!(dry_run(&source, &target, &[Sv2SyncCategoryId::Scripts], true).is_err());
    }
    fs::remove_dir_all(base).unwrap();
}
