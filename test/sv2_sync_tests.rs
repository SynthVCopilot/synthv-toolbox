#[path = "../src/PiDesktop.Tauri/src-tauri/src/sv2_sync.rs"]
mod sync;

use std::fs;
use std::path::PathBuf;
use sync::{dry_run, execute, sync_defaults, Sv2SyncAction, Sv2SyncCategoryId};

fn roots() -> (PathBuf, PathBuf, PathBuf) {
    let base = std::env::temp_dir().join(format!("sv2-sync-test-{}", uuid::Uuid::new_v4()));
    let source = base.join("source");
    let target = base.join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    (base, source, target)
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
    assert_eq!(fs::read(target.join("settings/settings.xml")).unwrap(), b"new-settings");
    assert_eq!(fs::read(target.join("scripts/tool.lua")).unwrap(), b"script");
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
    #[cfg(unix)] {
        use std::os::unix::fs::symlink;
        symlink(&target, source.join("scripts")).unwrap();
        assert!(dry_run(&source, &target, &[Sv2SyncCategoryId::Scripts], true).is_err());
    }
    fs::remove_dir_all(base).unwrap();
}
