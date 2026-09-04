use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::agent::data_root;
use crate::bridge_workflows;
use crate::creative_history;
use crate::mcp::McpManager;
use crate::media_import;
use crate::synthv_control;
use crate::synthv_unified;
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
#[serde(rename_all = "camelCase")]
pub struct CoverTaskRequest {
    pub source: String,
    pub lyrics: Option<String>,
    pub voice_name: String,
    pub process_id: Option<u32>,
    pub track_index: u32,
    pub group_name: String,
    pub rights_confirmed: bool,
    pub tolerance: f64,
    pub advanced: bool,
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
    Cover(CoverTaskRequest),
}

struct TaskRecord {
    snapshot: MediaTaskSnapshot,
    request: MediaTaskRequest,
    cancelled: Arc<AtomicBool>,
}

struct CoverHost {
    id: String,
    process_id: u32,
    bulk_score_import: bool,
    singer_list: bool,
    singer_assignment: bool,
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
    bridge_dir: PathBuf,
    mcp: Arc<McpManager>,
    store_path: PathBuf,
    inner: Mutex<TaskState>,
}

impl MediaTaskManager {
    pub fn persistent(
        resource_dir: PathBuf,
        bridge_dir: PathBuf,
        mcp: Arc<McpManager>,
    ) -> Arc<Self> {
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
            bridge_dir,
            mcp,
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

    pub fn enqueue_cover(
        &self,
        mut request: CoverTaskRequest,
    ) -> Result<(MediaTaskSnapshot, bool), String> {
        if !request.rights_confirmed {
            return Err("Cover 前必须确认你拥有来源内容或已取得足够授权。".to_string());
        }
        request.source = request.source.trim().to_string();
        request.voice_name = request.voice_name.trim().to_string();
        request.group_name = request.group_name.trim().to_string();
        if request.source.is_empty() || request.source.chars().count() > 2_048 {
            return Err("Cover 来源为空或过长。".to_string());
        }
        if request.voice_name.is_empty() || request.voice_name.chars().count() > 200 {
            return Err("目标声库名称不能为空且不能超过 200 个字符。".to_string());
        }
        if request.group_name.is_empty() || request.group_name.chars().count() > 200 {
            return Err("Cover 音符组名称不能为空且不能超过 200 个字符。".to_string());
        }
        if request.track_index == 0 || request.track_index > 10_000 {
            return Err("SynthV 目标轨道编号必须是 1–10000。".to_string());
        }
        if !request.tolerance.is_finite() || !(0.02..=0.25).contains(&request.tolerance) {
            return Err("匹配容差必须在 0.02–0.25 秒之间。".to_string());
        }
        if request
            .lyrics
            .as_ref()
            .is_some_and(|lyrics| lyrics.len() > 256 * 1024)
        {
            return Err("Cover 歌词超过 256 KiB 限制。".to_string());
        }
        self.enqueue(MediaTaskRequest::Cover(request))
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
        if task.snapshot.kind == "cover" && task.snapshot.progress >= 90 {
            return Err(
                "Cover 已进入 SynthV 写入/保存阶段，不能安全取消；请等待本次写入结果。".to_string(),
            );
        }
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
                MediaTaskRequest::Cover(request) => {
                    self.run_cover(&id, request, cancelled.clone()).await
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
                        task.snapshot.detail =
                            if value.get("saveVerified") == Some(&Value::Bool(false)) {
                                "Cover 已导入，但未能验证 .svp 文件已落盘；请检查 SynthV 保存状态。"
                                    .to_string()
                            } else {
                                "媒体任务已完成。".to_string()
                            };
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

    async fn run_cover(
        &self,
        id: &str,
        request: CoverTaskRequest,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Value, String> {
        self.update(id, 5, "正在导入 Cover 来源音频。", None);
        let imported = media_import::import_audio_cancellable(
            request.source.clone(),
            request.rights_confirmed,
            self.resource_dir.clone(),
            cancelled.clone(),
        )
        .await?;
        self.ensure_not_cancelled(&cancelled)?;

        self.update(id, 30, "正在分离人声与伴奏。", None);
        let separation_id = Uuid::new_v4().to_string();
        let separated = workflows::separate_audio_cancellable(
            imported.audio_path.clone(),
            self.resource_dir.clone(),
            cancelled.clone(),
            separation_id,
        )
        .await?;
        let vocal_path = required_result_path(&separated.data, "vocalPath", "人声轨")?;
        let instrumental_path =
            required_result_path(&separated.data, "instrumentalPath", "伴奏轨")?;
        self.ensure_not_cancelled(&cancelled)?;

        self.update(id, 60, "正在提取旋律并写入歌词 MIDI。", None);
        let midi = workflows::game_to_midi_cancellable(workflows::GameToMidiRequest {
            vocal_path,
            instrumental_path: instrumental_path.clone(),
            lyrics: request.lyrics.clone(),
            tolerance: request.tolerance,
            advanced: request.advanced,
            resource_dir: self.resource_dir.clone(),
            cancelled: cancelled.clone(),
            task_id: id.to_string(),
        })
        .await?;
        let midi_path = midi
            .output_path
            .clone()
            .ok_or_else(|| "旋律提取没有返回 MIDI 路径。".to_string())?;
        self.ensure_not_cancelled(&cancelled)?;

        self.update(id, 82, "正在检查并连接 SynthV 宿主。", None);
        let host = self.resolve_cover_host(request.process_id).await?;
        let project = self.standard_read(&host.id, "project", json!({})).await?;
        let status = self.standard_read(&host.id, "status", json!({})).await?;
        let project_file =
            bridge_workflows::current_project_file_from_standard_reads(&project, &status)?;
        let project_path = PathBuf::from(&project_file);
        if !project_path.is_file()
            || !project_path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("svp"))
        {
            return Err("当前 SynthV 工程路径不是可验证的已保存 .svp 文件。".to_string());
        }
        let project_hash_before = sha256_file(&project_path)?;
        let checkpoint = creative_history::create_checkpoint(
            &project_file,
            &format!("Cover 前检查点 {}", &id[..8]),
        )?;
        self.ensure_not_cancelled(&cancelled)?;

        self.update(id, 90, "正在把 Cover 音符和歌词导入 SynthV。", None);
        let (imported_score, voice_assignment) = if host.bulk_score_import {
            (
                bridge_workflows::import_monophonic_midi(
                    &self.mcp,
                    &midi_path,
                    request.track_index,
                    &request.group_name,
                )
                .await?,
                unsupported_voice_assignment(),
            )
        } else {
            let parsed = self.parse_cover_notes(&midi_path).await?;
            let notes = validate_cover_notes(&parsed)?;
            self.import_cover_notes(&host, parsed, notes, &request)
                .await
                .map_err(|error| {
                    format!(
                        "Cover 标准多音符写入未完成。已创建检查点：{}；新建 Part 或部分音符可能已经写入，请先恢复该检查点再重试。原因：{error}",
                        checkpoint.snapshot_path
                    )
                })?
        };
        self.update(id, 97, "正在保存并验证 .svp 工程。", None);
        tauri::async_runtime::spawn_blocking(move || {
            synthv_control::send_shortcut(
                host.process_id,
                synthv_control::BridgeShortcutAction::Save,
            )
        })
        .await
        .map_err(|error| error.to_string())??;
        let save_verified = wait_for_file_change(&project_path, &project_hash_before).await;
        Ok(json!({
            "source": imported,
            "separation": separated,
            "midi": midi,
            "synthvImport": imported_score,
            "checkpoint": checkpoint,
            "instrumentalPath": instrumental_path,
            "svpPath": project_file,
            "saveVerified": save_verified,
            "requestedVoice": request.voice_name,
            "voiceAssignment": voice_assignment
        }))
    }

    fn ensure_not_cancelled(&self, cancelled: &AtomicBool) -> Result<(), String> {
        if cancelled.load(Ordering::SeqCst) {
            Err("Cover 任务已取消。".to_string())
        } else {
            Ok(())
        }
    }

    async fn resolve_cover_host(
        &self,
        requested_process_id: Option<u32>,
    ) -> Result<CoverHost, String> {
        let hosts = self.standard_call("synthv_hosts", json!({})).await?;
        let hosts = hosts
            .as_array()
            .ok_or_else(|| "标准 SynthV 宿主列表无效。".to_string())?;
        let running = hosts
            .iter()
            .filter(|host| host.get("running").and_then(Value::as_bool) == Some(true))
            .collect::<Vec<_>>();
        let selected = match requested_process_id {
            Some(process_id) => running
                .iter()
                .find(|host| {
                    host.get("processId").and_then(Value::as_u64) == Some(process_id as u64)
                })
                .copied()
                .ok_or_else(|| format!("没有找到 PID {process_id} 对应的 SynthV 宿主。"))?,
            None => match running.as_slice() {
                [host] => *host,
                [] => return Err("没有发现正在运行的 SynthV 宿主。".to_string()),
                _ => {
                    let process_ids = running
                        .iter()
                        .filter_map(|host| host.get("processId").and_then(Value::as_u64))
                        .map(|process_id| process_id.to_string())
                        .collect::<Vec<_>>();
                    return Err(format!(
                        "发现多个 SynthV 宿主，请由 Agent 从列表中选择 processId：{}",
                        process_ids.join("、")
                    ));
                }
            },
        };
        let id = selected
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "所选 SynthV 宿主缺少标准标识。".to_string())?
            .to_string();
        let process_id = selected
            .get("processId")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| "所选 SynthV 宿主缺少可保存的进程 PID。".to_string())?;
        let capabilities = selected.get("capabilities").unwrap_or(&Value::Null);
        let write_operations = capabilities
            .get("writeOperations")
            .and_then(Value::as_array)
            .ok_or_else(|| "所选 SynthV 宿主没有标准写入能力描述。".to_string())?;
        self.standard_call("synthv_connect", json!({ "hostId": id }))
            .await?;
        Ok(CoverHost {
            id,
            process_id,
            bulk_score_import: !write_operations
                .iter()
                .any(|operation| operation.as_str() == Some("part.create")),
            singer_list: capabilities
                .get("singerList")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            singer_assignment: capabilities
                .get("singerAssignment")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    async fn import_cover_notes(
        &self,
        host: &CoverHost,
        parsed: Value,
        notes: Vec<Value>,
        request: &CoverTaskRequest,
    ) -> Result<(Value, Value), String> {
        let track_index = request
            .track_index
            .checked_sub(1)
            .ok_or_else(|| "Cover 目标轨道编号必须从 1 开始。".to_string())?;
        let created_part = self
            .standard_write(
                &host.id,
                "part.create",
                json!({
                    "trackIndex": track_index,
                    "name": request.group_name,
                    "timeOffset": 0,
                    "pitchOffset": 0,
                }),
            )
            .await?;
        let part_index = find_index(&created_part, "partIndex")
            .ok_or_else(|| "标准 SynthV 宿主没有返回新建 Cover Part 的索引。".to_string())?;
        let voice_assignment = self
            .assign_flat_voice_if_available(host, request, track_index, part_index)
            .await?;
        for note in &notes {
            let mut arguments = note
                .as_object()
                .cloned()
                .ok_or_else(|| "Cover 曲谱包含无效音符。".to_string())?;
            arguments.insert("trackIndex".to_string(), json!(track_index));
            arguments.insert("partIndex".to_string(), json!(part_index));
            self.standard_write(&host.id, "note.create", Value::Object(arguments))
                .await?;
        }
        Ok((
            json!({
                "mode": "standard-notes",
                "part": created_part,
                "noteCount": notes.len(),
                "score": parsed,
            }),
            voice_assignment,
        ))
    }

    async fn parse_cover_notes(&self, midi_path: &str) -> Result<Value, String> {
        let parsed = {
            let bridge_dir = self.bridge_dir.clone();
            let midi_path = midi_path.to_string();
            tauri::async_runtime::spawn_blocking(move || {
                bridge_workflows::parse_cover_midi(&bridge_dir, &midi_path)
            })
            .await
            .map_err(|error| error.to_string())??
        };
        Ok(parsed)
    }

    async fn assign_flat_voice_if_available(
        &self,
        host: &CoverHost,
        request: &CoverTaskRequest,
        track_index: u32,
        part_index: u64,
    ) -> Result<Value, String> {
        if !(host.singer_list && host.singer_assignment) {
            return Ok(unsupported_voice_assignment());
        }
        let singers = self.standard_read(&host.id, "singers", json!({})).await?;
        let singer = singers.as_array().and_then(|items| {
            items.iter().find(|singer| {
                singer.get("databaseName").and_then(Value::as_str)
                    == Some(request.voice_name.as_str())
            })
        });
        let Some(singer) = singer else {
            return Ok(json!({
                "assigned": false,
                "requiresHostSelection": true,
                "reason": "Flat 未找到与 voiceName 精确匹配的已安装 singer。"
            }));
        };
        let database_name = singer
            .get("databaseName")
            .and_then(Value::as_str)
            .ok_or_else(|| "Flat singer.list 返回的 singer 缺少 databaseName。".to_string())?;
        let mut arguments = json!({
            "trackIndex": track_index,
            "partIndex": part_index,
            "databaseName": database_name,
        });
        if let Some(version) = singer
            .get("version")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            arguments["version"] = Value::String(version.to_string());
        }
        self.standard_write(&host.id, "voice.assign", arguments)
            .await?;
        Ok(json!({
            "assigned": true,
            "singer": {
                "databaseName": database_name,
                "version": singer.get("version").cloned(),
            }
        }))
    }

    async fn standard_read(
        &self,
        host_id: &str,
        operation: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        let result = self
            .standard_call(
                "synthv_read",
                json!({ "hostId": host_id, "operation": operation, "arguments": arguments }),
            )
            .await?;
        result
            .get("data")
            .cloned()
            .ok_or_else(|| "标准 SynthV 读取缺少 data。".to_string())
    }

    async fn standard_write(
        &self,
        host_id: &str,
        operation: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        self.standard_call(
            "synthv_write",
            json!({ "hostId": host_id, "operation": operation, "arguments": arguments }),
        )
        .await
    }

    async fn standard_call(&self, tool: &str, arguments: Value) -> Result<Value, String> {
        let arguments = serde_json::to_string(&arguments).map_err(|error| error.to_string())?;
        synthv_unified::execute(tool, &arguments, &self.mcp, &self.bridge_dir).await
    }
}

fn unsupported_voice_assignment() -> Value {
    json!({
        "assigned": false,
        "requiresHostSelection": true,
        "reason": "所选官方 SynthV 宿主不提供 singer identity 写入；已完成可验证的 Cover 导入。"
    })
}

fn find_index(value: &Value, key: &str) -> Option<u64> {
    match value {
        Value::Object(object) => object
            .get(key)
            .and_then(Value::as_u64)
            .or_else(|| object.values().find_map(|value| find_index(value, key))),
        Value::Array(items) => items.iter().find_map(|value| find_index(value, key)),
        _ => None,
    }
}

fn validate_cover_notes(parsed: &Value) -> Result<Vec<Value>, String> {
    let notes = parsed
        .get("notes")
        .and_then(Value::as_array)
        .filter(|notes| (1..=512).contains(&notes.len()))
        .ok_or_else(|| "Cover 曲谱转换器没有返回 1–512 个音符。".to_string())?;
    let mut validated = Vec::with_capacity(notes.len());
    for (index, note) in notes.iter().enumerate() {
        let object = note
            .as_object()
            .ok_or_else(|| format!("Cover 曲谱第 {} 个音符不是对象。", index + 1))?;
        for (field, minimum, maximum) in [
            ("onset", 0_u64, 9_007_199_254_740_991_u64),
            ("duration", 1, 9_007_199_254_740_991_u64),
            ("pitch", 0, 127),
        ] {
            let value = object.get(field).and_then(Value::as_u64);
            if !value.is_some_and(|value| value >= minimum && value <= maximum) {
                return Err(format!(
                    "Cover 曲谱第 {} 个音符的 {field} 无效。",
                    index + 1
                ));
            }
        }
        for field in ["lyrics", "phonemes"] {
            if object.get(field).is_some_and(|value| {
                !value.is_string()
                    || value
                        .as_str()
                        .is_some_and(|value| value.chars().count() > 4096)
            }) {
                return Err(format!(
                    "Cover 曲谱第 {} 个音符的 {field} 无效。",
                    index + 1
                ));
            }
        }
        validated.push(note.clone());
    }
    Ok(validated)
}

fn request_kind(request: &MediaTaskRequest) -> &'static str {
    match request {
        MediaTaskRequest::MediaImport { .. } => "media-import",
        MediaTaskRequest::SourceSeparation { .. } => "source-separation",
        MediaTaskRequest::Cover(_) => "cover",
    }
}

fn required_result_path(data: &Value, key: &str, label: &str) -> Result<String, String> {
    data.get(key)
        .and_then(Value::as_str)
        .filter(|path| Path::new(path).is_file())
        .map(str::to_string)
        .ok_or_else(|| format!("{label}输出不存在。"))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| format!("无法读取 .svp：{error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(format!("{:x}", digest.finalize()));
        }
        digest.update(&buffer[..read]);
    }
}

async fn wait_for_file_change(path: &Path, previous_hash: &str) -> bool {
    for _ in 0..20 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if sha256_file(path).is_ok_and(|hash| hash != previous_hash) {
            return true;
        }
    }
    false
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_cover_notes_accepts_complete_standard_notes() {
        let notes = validate_cover_notes(&json!({
            "notes": [{ "onset": 0, "duration": 120, "pitch": 60, "lyrics": "la" }]
        }))
        .expect("valid standard note");
        assert_eq!(notes.len(), 1);
    }

    #[test]
    fn validate_cover_notes_rejects_every_note_before_part_creation() {
        let error = validate_cover_notes(&json!({
            "notes": [
                { "onset": 0, "duration": 120, "pitch": 60 },
                { "onset": 120, "duration": 0, "pitch": 61 }
            ]
        }))
        .expect_err("invalid duration must fail the full preflight");
        assert!(error.contains("第 2 个音符"));
    }
}
