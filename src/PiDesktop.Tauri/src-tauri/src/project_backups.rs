use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const INTERVAL_SECONDS: u64 = 60;
const DISCOVERY_INTERVAL_SECONDS: u64 = 5;
const MAX_PROJECT_BYTES: u64 = 128 * 1024 * 1024;
const REGISTRY_NAME: &str = "project-backups.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBackupState {
    pub interval_seconds: u64,
    pub projects: Vec<TrackedProject>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedProject {
    pub source_path: String,
    pub last_seen_at_utc: String,
    pub last_backup_at_utc: Option<String>,
    pub last_error: Option<String>,
    pub backup_count: usize,
    #[serde(default)]
    last_sha256: Option<String>,
    #[serde(default)]
    last_snapshot_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    #[serde(default = "registry_version")]
    version: u8,
    #[serde(default)]
    projects: BTreeMap<String, TrackedProject>,
}

fn registry_version() -> u8 {
    1
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            version: registry_version(),
            projects: BTreeMap::new(),
        }
    }
}

pub(crate) struct ProjectBackupStore {
    root: PathBuf,
    registry: Registry,
    registry_blocked: Option<String>,
    last_error: Option<String>,
}

impl ProjectBackupStore {
    pub(crate) fn open(root: PathBuf) -> Self {
        let registry_path = root.join(REGISTRY_NAME);
        let (registry, registry_blocked) = match fs::read_to_string(&registry_path) {
            Ok(text) => match serde_json::from_str(&text) {
                Ok(registry) => (registry, None),
                Err(error) => (
                    Registry::default(),
                    Some(format!("自动备份注册表无效，未覆盖原文件：{error}")),
                ),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (Registry::default(), None)
            }
            Err(error) => (
                Registry::default(),
                Some(format!("无法读取自动备份注册表：{error}")),
            ),
        };
        Self {
            root: normalize_path(&root),
            registry,
            last_error: registry_blocked.clone(),
            registry_blocked,
        }
    }

    pub(crate) fn observe_path(&mut self, path: &str) -> Result<bool, String> {
        if let Some(error) = &self.registry_blocked {
            return Err(error.clone());
        }
        let source = accepted_source(path, &self.root)?;
        let key = source.to_string_lossy().into_owned();
        if let Some(project) = self.registry.projects.get_mut(&key) {
            let previous = project.last_seen_at_utc.clone();
            project.last_seen_at_utc = Utc::now().to_rfc3339();
            if let Err(error) = self.save_registry() {
                self.registry
                    .projects
                    .get_mut(&key)
                    .unwrap()
                    .last_seen_at_utc = previous;
                self.last_error = Some(error.clone());
                return Err(error);
            }
            self.last_error = None;
            return Ok(false);
        }
        self.registry.projects.insert(
            key.clone(),
            TrackedProject {
                source_path: key.clone(),
                last_seen_at_utc: Utc::now().to_rfc3339(),
                last_backup_at_utc: None,
                last_error: None,
                backup_count: 0,
                last_sha256: None,
                last_snapshot_path: None,
            },
        );
        if let Err(error) = self.save_registry() {
            self.last_error = Some(error.clone());
            return Err(error);
        }
        self.last_error = None;
        Ok(true)
    }

    pub(crate) fn process_once(&mut self) {
        if self.registry_blocked.is_some() {
            return;
        }
        if let Err(error) = self.save_registry() {
            self.last_error = Some(error);
            return;
        }
        let keys = self.registry.projects.keys().cloned().collect::<Vec<_>>();
        for key in keys {
            let result = self.backup_if_needed(Path::new(&key));
            if let Err(error) = result {
                if let Some(project) = self.registry.projects.get_mut(&key) {
                    project.last_error = Some(error);
                }
            }
        }
        self.last_error = self.save_registry().err();
    }

    fn discover_paths(&mut self, paths: Vec<String>) -> bool {
        let mut discovered = false;
        for path in paths {
            let Ok(source) = accepted_source(&path, &self.root) else {
                continue;
            };
            if !self
                .registry
                .projects
                .contains_key(source.to_string_lossy().as_ref())
            {
                discovered |= self.observe_path(&path).unwrap_or(false);
            }
        }
        discovered
    }

    pub(crate) fn state(&self) -> ProjectBackupState {
        let mut projects = self.registry.projects.values().cloned().collect::<Vec<_>>();
        projects.sort_by(|a, b| a.source_path.cmp(&b.source_path));
        ProjectBackupState {
            interval_seconds: INTERVAL_SECONDS,
            projects,
            last_error: self.last_error.clone(),
        }
    }

    fn backup_if_needed(&mut self, source: &Path) -> Result<(), String> {
        let key = source.to_string_lossy().into_owned();
        let (bytes, source_stamp) = read_stable_svp(source)?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let project = self
            .registry
            .projects
            .get(&key)
            .ok_or_else(|| "工程未注册。".to_string())?;
        let snapshot_present = project
            .last_snapshot_path
            .as_ref()
            .is_some_and(|path| snapshot_is_trusted(&self.root, path, &hash));
        if project.last_sha256.as_deref() == Some(&hash) && snapshot_present {
            if let Some(project) = self.registry.projects.get_mut(&key) {
                project.last_error = None;
            }
            return Ok(());
        }
        let checkpoint = write_checkpoint(&self.root, source, &bytes, &hash, &source_stamp)?;
        let project = self
            .registry
            .projects
            .get_mut(&key)
            .ok_or_else(|| "工程未注册。".to_string())?;
        project.last_sha256 = Some(hash);
        project.last_snapshot_path = Some(checkpoint.snapshot_path);
        project.last_backup_at_utc = Some(checkpoint.created_at_utc);
        project.backup_count += 1;
        project.last_error = None;
        Ok(())
    }

    fn save_registry(&self) -> Result<(), String> {
        fs::create_dir_all(&self.root).map_err(|error| format!("无法创建自动备份目录：{error}"))?;
        let destination = self.root.join(REGISTRY_NAME);
        let temporary = self
            .root
            .join(format!(".{REGISTRY_NAME}.{}.tmp", Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(&self.registry).map_err(|error| error.to_string())?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("无法创建自动备份注册表：{error}"))?;
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&temporary);
            return Err(format!("无法写入自动备份注册表：{error}"));
        }
        drop(file);
        if let Err(error) = fs::rename(&temporary, &destination) {
            let _ = fs::remove_file(&temporary);
            return Err(format!("无法提交自动备份注册表：{error}"));
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Checkpoint {
    id: String,
    label: String,
    source_path: String,
    snapshot_path: String,
    source_sha256: String,
    source_size: u64,
    created_at_utc: String,
}

fn write_checkpoint(
    root: &Path,
    source: &Path,
    bytes: &[u8],
    hash: &str,
    source_stamp: &FileStamp,
) -> Result<Checkpoint, String> {
    let checkpoints = root.join("project-checkpoints");
    fs::create_dir_all(&checkpoints).map_err(|error| format!("无法创建工程检查点目录：{error}"))?;
    let id = Uuid::new_v4().to_string();
    let temporary = checkpoints.join(format!(".{id}.tmp"));
    let final_dir = checkpoints.join(&id);
    fs::create_dir(&temporary).map_err(|error| format!("无法创建检查点临时目录：{error}"))?;
    let snapshot = temporary.join("project.svp");
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&snapshot)
            .map_err(|error| format!("无法创建工程检查点：{error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("无法写入工程检查点：{error}"))?;
        drop(file);
        let final_snapshot = final_dir.join("project.svp");
        let checkpoint = Checkpoint {
            id: id.clone(),
            label: "自动备份".to_string(),
            source_path: source.to_string_lossy().into_owned(),
            snapshot_path: final_snapshot.to_string_lossy().into_owned(),
            source_sha256: hash.to_string(),
            source_size: bytes.len() as u64,
            created_at_utc: Utc::now().to_rfc3339(),
        };
        let metadata = serde_json::to_vec_pretty(&checkpoint).map_err(|error| error.to_string())?;
        let mut metadata_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temporary.join("checkpoint.json"))
            .map_err(|error| format!("无法创建检查点元数据：{error}"))?;
        metadata_file
            .write_all(&metadata)
            .and_then(|_| metadata_file.sync_all())
            .map_err(|error| format!("无法写入检查点元数据：{error}"))?;
        drop(metadata_file);
        if &file_stamp(source)? != source_stamp {
            return Err("工程正在写入，稍后会重试自动备份。".to_string());
        }
        fs::rename(&temporary, &final_dir)
            .map_err(|error| format!("无法提交工程检查点：{error}"))?;
        Ok(checkpoint)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}

fn accepted_source(value: &str, root: &Path) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if !path.is_absolute()
        || !path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("svp"))
    {
        return Err("自动备份只跟踪已保存的绝对 .svp 工程路径。".to_string());
    }
    let source = normalize_path(&path);
    let backup_root = normalize_path(&root.join("project-checkpoints"));
    if source.starts_with(&backup_root) {
        return Err("不会跟踪自动备份快照。".to_string());
    }
    Ok(source)
}

fn normalize_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path)
        }
    })
}

fn snapshot_is_trusted(root: &Path, snapshot_path: &str, expected_hash: &str) -> bool {
    let checkpoints = normalize_path(&root.join("project-checkpoints"));
    let snapshot = normalize_path(Path::new(snapshot_path));
    if !snapshot.starts_with(&checkpoints)
        || snapshot.file_name().and_then(|name| name.to_str()) != Some("project.svp")
        || !snapshot.is_file()
    {
        return false;
    }
    let Some(directory) = snapshot.parent() else {
        return false;
    };
    let Ok(metadata) = fs::read_to_string(directory.join("checkpoint.json")) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&metadata) else {
        return false;
    };
    let source_size = value.get("sourceSize").and_then(Value::as_u64);
    let metadata_valid = value.get("sourceSha256").and_then(Value::as_str) == Some(expected_hash)
        && value
            .get("snapshotPath")
            .and_then(Value::as_str)
            .is_some_and(|path| normalize_path(Path::new(path)) == snapshot)
        && value.get("sourcePath").and_then(Value::as_str).is_some()
        && value.get("label").and_then(Value::as_str).is_some()
        && value.get("createdAtUtc").and_then(Value::as_str).is_some()
        && value.get("id").and_then(Value::as_str).is_some_and(|id| {
            directory.file_name().and_then(|name| name.to_str()) == Some(id)
                && Uuid::parse_str(id).is_ok()
        });
    metadata_valid
        && source_size == fs::metadata(&snapshot).ok().map(|metadata| metadata.len())
        && sha256_limited(&snapshot).is_ok_and(|hash| hash == expected_hash)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: Option<std::time::SystemTime>,
}

fn file_stamp(path: &Path) -> Result<FileStamp, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取工程：{error}"))?;
    Ok(FileStamp {
        len: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

fn read_stable_svp(path: &Path) -> Result<(Vec<u8>, FileStamp), String> {
    let before = file_stamp(path)?;
    if before.len > MAX_PROJECT_BYTES {
        return Err("工程超过 128 MiB 自动备份限制。".to_string());
    }
    let bytes = read_limited(path)?;
    let after = file_stamp(path)?;
    if before != after {
        return Err("工程正在写入，稍后会重试自动备份。".to_string());
    }
    if bytes.len() as u64 > MAX_PROJECT_BYTES || bytes.len() as u64 != after.len {
        return Err("工程正在写入，稍后会重试自动备份。".to_string());
    }
    let json = bytes.strip_suffix(&[0]).unwrap_or(&bytes);
    let value = serde_json::from_slice::<Value>(json)
        .map_err(|error| format!("工程 JSON 无效，稍后会重试自动备份：{error}"))?;
    if !value.is_object() {
        return Err("工程 JSON 必须是对象，稍后会重试自动备份。".to_string());
    }
    Ok((bytes, after))
}

fn read_limited(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|error| format!("无法读取工程：{error}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_PROJECT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取工程：{error}"))?;
    if bytes.len() as u64 > MAX_PROJECT_BYTES {
        return Err("工程超过 128 MiB 自动备份限制。".to_string());
    }
    Ok(bytes)
}

fn sha256_limited(path: &Path) -> Result<String, String> {
    Ok(format!("{:x}", Sha256::digest(read_limited(path)?)))
}

pub(crate) enum Message {
    Observe {
        path: String,
        completed: Option<mpsc::SyncSender<()>>,
    },
}
struct Service {
    sender: mpsc::Sender<Message>,
    state: Arc<Mutex<ProjectBackupState>>,
}
static SERVICE: OnceLock<Service> = OnceLock::new();

pub fn start() {
    SERVICE.get_or_init(|| {
        let (sender, receiver) = mpsc::channel();
        let state = Arc::new(Mutex::new(
            ProjectBackupStore::open(crate::agent::data_root()).state(),
        ));
        let state_for_worker = state.clone();
        thread::spawn(move || worker(receiver, state_for_worker));
        Service { sender, state }
    });
}

pub fn observe_path(path: &str) {
    enqueue(path, false);
}

pub fn observe_path_and_wait(path: &str) {
    enqueue(path, true);
}

fn enqueue(path: &str, wait: bool) {
    if !is_candidate_path(path) {
        return;
    }
    start();
    if let Some(service) = SERVICE.get() {
        let (completed, receiver) = mpsc::sync_channel(1);
        let completed = wait.then_some(completed);
        if service
            .sender
            .send(Message::Observe {
                path: path.to_owned(),
                completed,
            })
            .is_ok()
            && wait
        {
            let _ = receiver.recv_timeout(Duration::from_secs(5));
        }
    }
}

fn is_candidate_path(value: &str) -> bool {
    let path = Path::new(value.trim());
    path.is_absolute()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("svp"))
}

pub fn observe_value(value: &Value) {
    fn collect(value: &Value, paths: &mut Vec<String>) {
        match value {
            Value::String(path) => paths.push(path.clone()),
            Value::Array(values) => {
                for value in values {
                    collect(value, paths);
                }
            }
            Value::Object(values) => {
                for value in values.values() {
                    collect(value, paths);
                }
            }
            _ => {}
        }
    }
    let mut paths = Vec::new();
    collect(value, &mut paths);
    for path in paths {
        observe_path(&path);
    }
}

pub fn status() -> Result<ProjectBackupState, String> {
    start();
    SERVICE
        .get()
        .ok_or_else(|| "自动备份服务未启动。".to_string())?
        .state
        .lock()
        .map(|state| state.clone())
        .map_err(|_| "自动备份状态锁已中断。".to_string())
}

fn worker(receiver: mpsc::Receiver<Message>, state: Arc<Mutex<ProjectBackupState>>) {
    worker_with_discovery(
        ProjectBackupStore::open(crate::agent::data_root()),
        receiver,
        state,
        Duration::from_secs(INTERVAL_SECONDS),
        Duration::from_secs(DISCOVERY_INTERVAL_SECONDS),
        crate::project_discovery::discover_project_paths,
    );
}

#[cfg(test)]
pub(crate) fn worker_with_store(
    store: ProjectBackupStore,
    receiver: mpsc::Receiver<Message>,
    state: Arc<Mutex<ProjectBackupState>>,
    interval: Duration,
) {
    worker_with_discovery(store, receiver, state, interval, interval, Vec::new);
}

pub(crate) fn worker_with_discovery(
    mut store: ProjectBackupStore,
    receiver: mpsc::Receiver<Message>,
    state: Arc<Mutex<ProjectBackupState>>,
    interval: Duration,
    discovery_interval: Duration,
    mut discover: impl FnMut() -> Vec<String>,
) {
    let mut next_run = Instant::now() + interval;
    let mut next_discovery = Instant::now();
    loop {
        let mut completed = Vec::new();
        let mut should_process = false;
        match receiver.recv_timeout(
            next_run
                .min(next_discovery)
                .saturating_duration_since(Instant::now()),
        ) {
            Ok(Message::Observe {
                path,
                completed: done,
            }) => {
                should_process |= store.observe_path(&path).unwrap_or(false);
                if let Some(done) = done {
                    completed.push(done);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        if Instant::now() >= next_discovery {
            should_process |= store.discover_paths(discover());
            next_discovery = Instant::now() + discovery_interval;
        }
        for _ in 0..256 {
            let Ok(Message::Observe {
                path,
                completed: done,
            }) = receiver.try_recv()
            else {
                break;
            };
            should_process |= store.observe_path(&path).unwrap_or(false);
            if let Some(done) = done {
                completed.push(done);
            }
        }
        if Instant::now() >= next_run {
            should_process = true;
        }
        if should_process {
            store.process_once();
            next_run = Instant::now() + interval;
        }
        if let Ok(mut current) = state.lock() {
            *current = store.state();
        }
        for done in completed {
            let _ = done.send(());
        }
    }
}
