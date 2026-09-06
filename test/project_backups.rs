use std::fs;
use std::path::{Path, PathBuf};

use crate::project_backups::ProjectBackupStore;

fn temporary_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("synthv-toolbox-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    root
}

fn project(path: &Path, version: u8) {
    let mut content = format!(r#"{{"version":{version},"tracks":[]}}"#).into_bytes();
    content.push(0);
    fs::write(path, content).unwrap();
}

fn checkpoint_paths(root: &Path) -> Vec<PathBuf> {
    let mut paths = fs::read_dir(root.join("project-checkpoints"))
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

#[test]
fn backs_up_once_then_deduplicates_and_preserves_source() {
    let root = temporary_root("dedupe");
    let source = root.join("song.svp");
    project(&source, 1);
    let original = fs::read(&source).unwrap();
    let mut store = ProjectBackupStore::open(root.clone());
    assert!(store.observe_path(&source.to_string_lossy()).unwrap());
    store.process_once();
    let state = store.state();
    assert_eq!(state.projects[0].backup_count, 1);
    assert_eq!(fs::read(&source).unwrap(), original);
    let checkpoints = checkpoint_paths(&root);
    assert_eq!(checkpoints.len(), 1);
    assert_eq!(
        fs::read(checkpoints[0].join("project.svp")).unwrap(),
        original
    );
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(checkpoints[0].join("checkpoint.json")).unwrap()).unwrap();
    assert_eq!(metadata["label"], "自动备份");
    store.process_once();
    assert_eq!(store.state().projects[0].backup_count, 1);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn changes_and_missing_snapshots_create_new_checkpoints_across_restart() {
    let root = temporary_root("restart");
    let source = root.join("song.svp");
    project(&source, 1);
    let mut first = ProjectBackupStore::open(root.clone());
    first.observe_path(&source.to_string_lossy()).unwrap();
    first.process_once();
    project(&source, 2);
    let mut restarted = ProjectBackupStore::open(root.clone());
    restarted.process_once();
    assert_eq!(restarted.state().projects[0].backup_count, 2);
    let newest = checkpoint_paths(&root).pop().unwrap();
    fs::remove_dir_all(newest).unwrap();
    restarted.process_once();
    assert_eq!(restarted.state().projects[0].backup_count, 3);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn retries_invalid_or_unavailable_projects_without_losing_registration() {
    let root = temporary_root("recovery");
    let source = root.join("song.svp");
    fs::write(&source, br#"{"tracks":"partial"#).unwrap();
    let mut store = ProjectBackupStore::open(root.clone());
    store.observe_path(&source.to_string_lossy()).unwrap();
    store.process_once();
    assert_eq!(store.state().projects[0].backup_count, 0);
    assert!(store.state().projects[0].last_error.is_some());
    project(&source, 1);
    store.process_once();
    assert_eq!(store.state().projects[0].backup_count, 1);
    assert!(store.state().projects[0].last_error.is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn excludes_its_own_snapshots() {
    let root = temporary_root("self-exclusion");
    let source = root.join("song.svp");
    project(&source, 1);
    let mut store = ProjectBackupStore::open(root.clone());
    store.observe_path(&source.to_string_lossy()).unwrap();
    store.process_once();
    let snapshot = checkpoint_paths(&root)[0].join("project.svp");
    assert!(store.observe_path(&snapshot.to_string_lossy()).is_err());
    assert_eq!(store.state().projects.len(), 1);
    let _ = fs::remove_dir_all(root);
}
