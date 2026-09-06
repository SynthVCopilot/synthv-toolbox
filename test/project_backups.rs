use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use crate::project_backups::{worker_with_store, Message, ProjectBackupStore};

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

fn wait_for_backup_count(
    state: &Arc<Mutex<crate::project_backups::ProjectBackupState>>,
    count: usize,
) {
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline {
        if state.lock().unwrap().projects[0].backup_count == count {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(state.lock().unwrap().projects[0].backup_count, count);
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
    assert_eq!(state.projects[0].backup_count, 1, "{state:?}");
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
    let changed_snapshot = checkpoint_paths(&root)
        .into_iter()
        .find(|path| {
            fs::read(path.join("project.svp"))
                .unwrap()
                .starts_with(br#"{"version":2"#)
        })
        .unwrap();
    fs::remove_dir_all(changed_snapshot).unwrap();
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

#[test]
fn registers_a_missing_project_and_recovers_when_it_is_saved() {
    let root = temporary_root("missing-then-saved");
    let source = root.join("later.svp");
    let mut store = ProjectBackupStore::open(root.clone());
    assert!(store.observe_path(&source.to_string_lossy()).unwrap());
    store.process_once();
    assert_eq!(store.state().projects[0].backup_count, 0);
    project(&source, 1);
    store.process_once();
    assert_eq!(store.state().projects[0].backup_count, 1);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn retries_a_temporary_registry_write_failure_without_registering_unsaved_projects() {
    let root = temporary_root("registry-retry");
    let first = root.join("first.svp");
    let second = root.join("second.svp");
    project(&first, 1);
    project(&second, 1);
    let mut store = ProjectBackupStore::open(root.clone());
    store.observe_path(&first.to_string_lossy()).unwrap();
    fs::remove_file(root.join("project-backups.json")).unwrap();
    fs::create_dir(root.join("project-backups.json")).unwrap();
    assert!(store.observe_path(&second.to_string_lossy()).is_err());
    assert_eq!(store.state().projects.len(), 2);
    fs::remove_dir(root.join("project-backups.json")).unwrap();
    store.process_once();
    assert_eq!(store.state().projects.len(), 2);
    let registry: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("project-backups.json")).unwrap()).unwrap();
    assert_eq!(registry["projects"].as_object().unwrap().len(), 2);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn never_overwrites_a_corrupt_registry() {
    let root = temporary_root("corrupt-registry");
    let source = root.join("song.svp");
    project(&source, 1);
    let registry = root.join("project-backups.json");
    fs::write(&registry, "not json").unwrap();
    let mut store = ProjectBackupStore::open(root.clone());
    assert!(store.observe_path(&source.to_string_lossy()).is_err());
    assert_eq!(fs::read_to_string(registry).unwrap(), "not json");
    assert!(store.state().last_error.is_some());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn replaces_a_corrupt_snapshot_when_source_is_unchanged() {
    let root = temporary_root("corrupt-snapshot");
    let source = root.join("song.svp");
    project(&source, 1);
    let mut store = ProjectBackupStore::open(root.clone());
    store.observe_path(&source.to_string_lossy()).unwrap();
    store.process_once();
    let snapshot = checkpoint_paths(&root)[0].join("project.svp");
    fs::write(snapshot, br#"{"truncated":true}"#).unwrap();
    store.process_once();
    assert_eq!(store.state().projects[0].backup_count, 2);
    assert_eq!(checkpoint_paths(&root).len(), 2);
    let _ = fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn excludes_windows_canonical_snapshot_paths() {
    let root = temporary_root("windows-canonical");
    let source = root.join("song.svp");
    project(&source, 1);
    let mut store = ProjectBackupStore::open(root.clone());
    store.observe_path(&source.to_string_lossy()).unwrap();
    store.process_once();
    let snapshot = checkpoint_paths(&root)[0].join("project.svp");
    let extended = format!(r"\\?\{}", snapshot.to_string_lossy());
    assert!(store.observe_path(&extended).is_err());
    assert_eq!(store.state().projects.len(), 1);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn worker_only_backs_up_existing_projects_on_its_interval() {
    let root = temporary_root("worker-schedule");
    let source = root.join("song.svp");
    project(&source, 1);
    let store = ProjectBackupStore::open(root.clone());
    let state = Arc::new(Mutex::new(store.state()));
    let (sender, receiver) = mpsc::channel();
    let worker_state = state.clone();
    let handle = std::thread::spawn(move || {
        worker_with_store(store, receiver, worker_state, Duration::from_millis(250));
    });
    let (done, done_receiver) = mpsc::sync_channel(1);
    sender
        .send(Message::Observe {
            path: source.to_string_lossy().into_owned(),
            completed: Some(done),
        })
        .unwrap();
    done_receiver.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(state.lock().unwrap().projects[0].backup_count, 1);
    project(&source, 2);
    let (done, done_receiver) = mpsc::sync_channel(1);
    sender
        .send(Message::Observe {
            path: source.to_string_lossy().into_owned(),
            completed: Some(done),
        })
        .unwrap();
    done_receiver.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(state.lock().unwrap().projects[0].backup_count, 1);
    wait_for_backup_count(&state, 2);
    drop(sender);
    handle.join().unwrap();
    let _ = fs::remove_dir_all(root);
}
