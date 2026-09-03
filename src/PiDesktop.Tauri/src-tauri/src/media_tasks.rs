use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::agent::data_root;
use crate::media_import;
use crate::workflows;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaTaskStatus {
    Queued,
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
}

impl MediaTaskStatus {
    fn active(self) -> bool {
        matches!(self, Self::Queued | Self::Running | Self::Cancelling)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaTaskSnapshot {
    pub id: String,
    pub kind: String,
    pub status: MediaTaskStatus,
    pub progress: u8,
    pub detail: String,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum MediaTaskRequest {
    MediaImport {
        source: String,
        rights_confirmed: bool,
    },
    SourceSeparation {
        audio_path: String,
    },
}

struct TaskRecord {
    snapshot: MediaTaskSnapshot,
    request: MediaTaskRequest,
    cancelled: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedTask {
    snapshot: MediaTaskSnapshot,
    request: MediaTaskRequest,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedTasks {
    schema_version: u32,
    tasks: Vec<PersistedTask>,
}

#[derive(Default)]
struct TaskState {
    tasks: Vec<TaskRecord>,
    worker_running: bool,
}

pub struct MediaTaskManager {
    resource_dir: PathBuf,
    store_path: PathBuf,
    inner: Mutex<TaskState>,
}

impl MediaTaskManager {
    pub fn persistent(resource_dir: PathBuf) -> Arc<Self> {
        let store_path = data_root().join("tasks/media-tasks.json");
        let mut tasks = match load_tasks(&store_path) {
            Ok(tasks) => tasks,
            Err(error) => {
                eprintln!("无法恢复媒体任务：{error}");
                Vec::new()
            }
        };
        let now = Utc::now().to_rfc3339();
        let mut changed = false;
        for task in &mut tasks {
            if task.snapshot.status.active() {
                task.snapshot.status = MediaTaskStatus::Failed;
                task.snapshot.progress = task.snapshot.progress.min(99);
                task.snapshot.detail = "应用在任务完成前退出；可从相同请求重试。".to_string();
                task.snapshot.error = Some("任务被应用退出中断。".to_string());
                task.snapshot.updated_at = now.clone();
                changed = true;
            }
        }
        let manager = Arc::new(Self {
            resource_dir,
            store_path,
            inner: Mutex::new(TaskState {
                tasks: tasks
                    .into_iter()
                    .map(|task| TaskRecord {
                        snapshot: task.snapshot,
                        request: task.request,
                        cancelled: Arc::new(AtomicBool::new(false)),
                    })
                    .collect(),
                worker_running: false,
            }),
        });
        if changed {
            if let Ok(state) = manager.inner.lock() {
                if let Err(error) = manager.persist(&state) {
                    eprintln!("无法保存恢复后的媒体任务：{error}");
                }
            }
        }
        manager
    }

    pub fn snapshot(&self) -> Vec<MediaTaskSnapshot> {
        self.inner
            .lock()
            .map(|state| {
                state
                    .tasks
                    .iter()
                    .map(|task| task.snapshot.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn enqueue_import(
        &self,
        source: String,
        rights_confirmed: bool,
    ) -> Result<(MediaTaskSnapshot, bool), String> {
        if !rights_confirmed {
            return Err("下载前必须确认你拥有该内容或已取得足够授权。".to_string());
        }
        if source.trim().is_empty() || source.chars().count() > 2_048 {
            return Err("媒体来源为空或过长。".to_string());
        }
        self.enqueue(MediaTaskRequest::MediaImport {
            source: source.trim().to_string(),
            rights_confirmed,
        })
    }

    pub fn enqueue_separation(
        &self,
        audio_path: String,
    ) -> Result<(MediaTaskSnapshot, bool), String> {
        if audio_path.trim().is_empty() || audio_path.chars().count() > 4_096 {
            return Err("待分离音频路径为空或过长。".to_string());
        }
        self.enqueue(MediaTaskRequest::SourceSeparation {
            audio_path: audio_path.trim().to_string(),
        })
    }

    fn enqueue(&self, request: MediaTaskRequest) -> Result<(MediaTaskSnapshot, bool), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "媒体任务状态锁已损坏。".to_string())?;
        let now = Utc::now().to_rfc3339();
        let snapshot = MediaTaskSnapshot {
            id: Uuid::new_v4().to_string(),
            kind: request_kind(&request).to_string(),
            status: MediaTaskStatus::Queued,
            progress: 0,
            detail: "等待前面的媒体任务完成。".to_string(),
            result: None,
            error: None,
            created_at: now.clone(),
            updated_at: now,
        };
        state.tasks.push(TaskRecord {
            snapshot: snapshot.clone(),
            request,
            cancelled: Arc::new(AtomicBool::new(false)),
        });
        while state.tasks.len() > 50 {
            let Some(index) = state
                .tasks
                .iter()
                .position(|task| !task.snapshot.status.active())
            else {
                break;
            };
            state.tasks.remove(index);
        }
        let start_worker = !state.worker_running;
        if start_worker {
            state.worker_running = true;
        }
        if let Err(error) = self.persist(&state) {
            state.tasks.retain(|task| task.snapshot.id != snapshot.id);
            if start_worker {
                state.worker_running = false;
            }
            return Err(error);
        }
        Ok((snapshot, start_worker))
    }

    pub fn cancel(&self, id: &str) -> Result<MediaTaskSnapshot, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "媒体任务状态锁已损坏。".to_string())?;
        let index = state
            .tasks
            .iter()
            .position(|task| task.snapshot.id == id)
            .ok_or_else(|| "没有找到该媒体任务。".to_string())?;
        let previous = state.tasks[index].snapshot.clone();
        let task = &mut state.tasks[index];
        match task.snapshot.status {
            MediaTaskStatus::Queued => {
                task.cancelled.store(true, Ordering::SeqCst);
                task.snapshot.status = MediaTaskStatus::Cancelled;
                task.snapshot.detail = "已在开始前取消。".to_string();
            }
            MediaTaskStatus::Running | MediaTaskStatus::Cancelling => {
                task.cancelled.store(true, Ordering::SeqCst);
                task.snapshot.status = MediaTaskStatus::Cancelling;
                task.snapshot.detail = "正在终止媒体进程树。".to_string();
            }
            _ => return Err("该媒体任务已经结束。".to_string()),
        }
        task.snapshot.updated_at = Utc::now().to_rfc3339();
        if let Err(error) = self.persist(&state) {
            state.tasks[index].snapshot = previous;
            state.tasks[index].cancelled.store(false, Ordering::SeqCst);
            return Err(error);
        }
        Ok(state.tasks[index].snapshot.clone())
    }

    pub fn retry(&self, id: &str) -> Result<(MediaTaskSnapshot, bool), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "媒体任务状态锁已损坏。".to_string())?;
        let index = state
            .tasks
            .iter()
            .position(|task| task.snapshot.id == id)
            .ok_or_else(|| "没有找到该媒体任务。".to_string())?;
        if !matches!(
            state.tasks[index].snapshot.status,
            MediaTaskStatus::Failed | MediaTaskStatus::Cancelled
        ) {
            return Err("只有失败或已取消的媒体任务可以重试。".to_string());
        }
        let previous = state.tasks[index].snapshot.clone();
        let task = &mut state.tasks[index];
        task.cancelled = Arc::new(AtomicBool::new(false));
        task.snapshot.status = MediaTaskStatus::Queued;
        task.snapshot.progress = 0;
        task.snapshot.detail = "等待前面的媒体任务完成。".to_string();
        task.snapshot.result = None;
        task.snapshot.error = None;
        task.snapshot.updated_at = Utc::now().to_rfc3339();
        let start_worker = !state.worker_running;
        if start_worker {
            state.worker_running = true;
        }
        if let Err(error) = self.persist(&state) {
            state.tasks[index].snapshot = previous;
            if start_worker {
                state.worker_running = false;
            }
            return Err(error);
        }
        Ok((state.tasks[index].snapshot.clone(), start_worker))
    }

    pub async fn run_worker(self: Arc<Self>) {
        loop {
            let Some((id, request, cancelled)) = self.take_next() else {
                return;
            };
            let result = match request {
                MediaTaskRequest::MediaImport {
                    source,
                    rights_confirmed,
                } => {
                    self.update(&id, 10, "正在读取媒体元数据。", None);
                    media_import::import_audio_cancellable(
                        source,
                        rights_confirmed,
                        self.resource_dir.clone(),
                        cancelled.clone(),
                    )
                    .await
                    .and_then(|result| {
                        serde_json::to_value(result).map_err(|error| error.to_string())
                    })
                }
                MediaTaskRequest::SourceSeparation { audio_path } => {
                    self.update(&id, 10, "正在启动人声伴奏分离。", None);
                    workflows::separate_audio_cancellable(
                        audio_path,
                        self.resource_dir.clone(),
                        cancelled.clone(),
                        id.clone(),
                    )
                    .await
                    .and_then(|result| {
                        serde_json::to_value(result).map_err(|error| error.to_string())
                    })
                }
            };
            self.finish(&id, cancelled.load(Ordering::SeqCst), result);
        }
    }

    fn take_next(&self) -> Option<(String, MediaTaskRequest, Arc<AtomicBool>)> {
        let mut state = self.inner.lock().ok()?;
        let Some(index) = state
            .tasks
            .iter()
            .position(|task| task.snapshot.status == MediaTaskStatus::Queued)
        else {
            state.worker_running = false;
            return None;
        };
        let task = &mut state.tasks[index];
        task.snapshot.status = MediaTaskStatus::Running;
        task.snapshot.progress = 2;
        task.snapshot.detail = "媒体任务已开始。".to_string();
        task.snapshot.updated_at = Utc::now().to_rfc3339();
        let next = (
            task.snapshot.id.clone(),
            task.request.clone(),
            task.cancelled.clone(),
        );
        if let Err(error) = self.persist(&state) {
            eprintln!("无法持久化媒体任务开始状态：{error}");
        }
        Some(next)
    }

    fn update(&self, id: &str, progress: u8, detail: &str, error: Option<String>) {
        if let Ok(mut state) = self.inner.lock() {
            if let Some(task) = state.tasks.iter_mut().find(|task| task.snapshot.id == id) {
                task.snapshot.progress = progress.min(99);
                task.snapshot.detail = detail.to_string();
                task.snapshot.error = error;
                task.snapshot.updated_at = Utc::now().to_rfc3339();
            }
            if let Err(error) = self.persist(&state) {
                eprintln!("无法持久化媒体任务进度：{error}");
            }
        }
    }

    fn finish(&self, id: &str, cancelled: bool, result: Result<Value, String>) {
        if let Ok(mut state) = self.inner.lock() {
            if let Some(task) = state.tasks.iter_mut().find(|task| task.snapshot.id == id) {
                task.snapshot.updated_at = Utc::now().to_rfc3339();
                match result {
                    Ok(value) => {
                        task.snapshot.status = MediaTaskStatus::Completed;
                        task.snapshot.progress = 100;
                        task.snapshot.detail = "媒体任务已完成。".to_string();
                        task.snapshot.result = Some(value);
                        task.snapshot.error = None;
                    }
                    Err(_) if cancelled => {
                        task.snapshot.status = MediaTaskStatus::Cancelled;
                        task.snapshot.detail = "媒体进程树已终止，临时输出已清理。".to_string();
                        task.snapshot.error = None;
                    }
                    Err(error) => {
                        task.snapshot.status = MediaTaskStatus::Failed;
                        task.snapshot.detail = "媒体任务失败；可保留请求并重试。".to_string();
                        task.snapshot.error = Some(error);
                    }
                }
            }
            if let Err(error) = self.persist(&state) {
                eprintln!("无法持久化媒体任务结果：{error}");
            }
        }
    }

    fn persist(&self, state: &TaskState) -> Result<(), String> {
        let tasks = state
            .tasks
            .iter()
            .map(|task| PersistedTask {
                snapshot: task.snapshot.clone(),
                request: task.request.clone(),
            })
            .collect();
        write_tasks(
            &self.store_path,
            &PersistedTasks {
                schema_version: 1,
                tasks,
            },
        )
    }
}

fn request_kind(request: &MediaTaskRequest) -> &'static str {
    match request {
        MediaTaskRequest::MediaImport { .. } => "media-import",
        MediaTaskRequest::SourceSeparation { .. } => "source-separation",
    }
}

fn load_tasks(path: &Path) -> Result<Vec<PersistedTask>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("无法读取媒体任务：{error}")),
    };
    let mut stored: PersistedTasks =
        serde_json::from_slice(&bytes).map_err(|error| format!("媒体任务无法解析：{error}"))?;
    if stored.schema_version != 1 {
        return Err("媒体任务文件版本不受支持。".to_string());
    }
    if stored.tasks.len() > 50 {
        stored.tasks.drain(..stored.tasks.len() - 50);
    }
    Ok(stored.tasks)
}

fn write_tasks(path: &Path, value: &PersistedTasks) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "媒体任务文件缺少父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建媒体任务目录：{error}"))?;
    let metadata = fs::symlink_metadata(parent).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("媒体任务目录不是安全的普通目录。".to_string());
    }
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("媒体任务文件不能是符号链接。".to_string());
    }
    let temporary = path.with_extension(format!("json.{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    if let Err(error) = replace_file(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}
