use std::fs;
use std::path::{Path, PathBuf};

use crate::sv2_data_backup::create_verified_sv2_data_backup;
use sha2::{Digest, Sha256};
use uuid::Uuid;

fn temporary_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("{name}-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    root
}

fn hash(path: &Path) -> String {
    hex::encode(Sha256::digest(fs::read(path).unwrap()))
}

#[test]
fn copies_every_regular_file_and_writes_a_verified_manifest() {
    let root = temporary_root("sv2-data-backup");
    let source = root.join("data");
    let backups = root.join("backups");
    fs::create_dir_all(source.join("license")).unwrap();
    fs::create_dir_all(source.join("nested").join("empty")).unwrap();
    fs::create_dir_all(&backups).unwrap();
    fs::write(source.join("license").join("session"), b"session-state").unwrap();
    fs::write(source.join("settings.json"), b"{\"setting\":true}").unwrap();
    fs::write(source.join("nested").join("cache"), b"cache-state").unwrap();

    let backup = create_verified_sv2_data_backup(&source, &backups, false).unwrap();

    assert!(backup.backup_root.starts_with(&backups));
    assert_eq!(backup.file_count, 3);
    assert_eq!(
        backup.session_path,
        Some(PathBuf::from("license").join("session"))
    );
    assert_eq!(
        backup.session_sha256,
        Some(hash(&source.join("license").join("session")))
    );
    assert_eq!(
        fs::read(backup.backup_root.join("settings.json")).unwrap(),
        b"{\"setting\":true}"
    );
    assert_eq!(
        fs::read(backup.backup_root.join("nested").join("cache")).unwrap(),
        b"cache-state"
    );
    assert!(backup.backup_root.join("nested").join("empty").is_dir());
    let manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(backup.backup_root.join("sv2-data-backup-manifest.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest["files"].as_array().unwrap().len(), 3);
    assert_eq!(manifest["files"][0]["path"], "license/session");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn refuses_an_active_source_without_creating_a_backup() {
    let root = temporary_root("sv2-data-backup-active");
    let source = root.join("data");
    let backups = root.join("backups");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&backups).unwrap();

    let error = create_verified_sv2_data_backup(&source, &backups, true).unwrap_err();

    assert!(error.contains("in use"));
    assert!(fs::read_dir(&backups).unwrap().next().is_none());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn refuses_a_backup_parent_inside_the_source_tree() {
    let root = temporary_root("sv2-data-backup-contained");
    let source = root.join("data");
    let nested_backup_parent = source.join("backups");
    fs::create_dir_all(&nested_backup_parent).unwrap();
    fs::write(source.join("state"), b"state").unwrap();

    let error = create_verified_sv2_data_backup(&source, &nested_backup_parent, false).unwrap_err();

    assert!(error.contains("outside"));
    assert!(fs::read_dir(&nested_backup_parent)
        .unwrap()
        .next()
        .is_none());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn accepts_a_canonical_root_junction_but_rejects_nested_junctions() {
    let root = temporary_root("sv2-data-backup-junction");
    let source = root.join("data");
    let source_alias = root.join("canonical-data");
    let backups = root.join("backups");
    let outside = root.join("outside");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&backups).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(source.join("state"), b"state").unwrap();
    junction::create(&source, &source_alias).unwrap();

    let backup = create_verified_sv2_data_backup(&source_alias, &backups, false).unwrap();

    assert_eq!(
        backup.canonical_source_root,
        fs::canonicalize(&source).unwrap()
    );
    junction::create(&outside, source.join("unexpected-link")).unwrap();
    let error = create_verified_sv2_data_backup(&source, &backups, false).unwrap_err();
    assert!(error.contains("reparse point"));
    junction::delete(source.join("unexpected-link")).unwrap();
    junction::delete(source_alias).unwrap();
    fs::remove_dir_all(root).unwrap();
}
