use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::agent::data_root;
use crate::components::install_component;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ComponentDownloadStatus {
    Queued,
    Downloading,
    Installing,
    Completed,
    Failed,
    Cancelled,
}

impl ComponentDownloadStatus {
    fn active(self) -> bool {
        matches!(self, Self::Queued | Self::Downloading | Self::Installing)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentDownload {
    pub id: String,
    pub component_id: String,
    pub display_name: String,
    pub status: ComponentDownloadStatus,
    pub progress: u8,
    pub detail: String,
    pub updated_at: String,
}

#[derive(Default)]
struct QueueState {
    items: Vec<ComponentDownload>,
    worker_running: bool,
    removal_reservations: HashSet<String>,
}

pub struct ComponentDownloadManager {
    inner: Mutex<QueueState>,
    store_path: Option<PathBuf>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedQueue {
    schema_version: u32,
    items: Vec<ComponentDownload>,
}

impl Default for ComponentDownloadManager {
    fn default() -> Self {
        Self {
            inner: Mutex::new(QueueState::default()),
            store_path: None,
        }
    }
}

pub struct ComponentRemovalReservation {
    manager: Arc<ComponentDownloadManager>,
    component_id: String,
}

impl Drop for ComponentRemovalReservation {
    fn drop(&mut self) {
        if let Ok(mut queue) = self.manager.inner.lock() {
            queue.removal_reservations.remove(&self.component_id);
        }
    }
}

impl ComponentDownloadManager {
    pub fn persistent() -> Self {
        Self::from_store_path(data_root().join("tasks/component-downloads.json"))
    }

    fn from_store_path(store_path: PathBuf) -> Self {
        let mut items = match load_queue(&store_path) {
            Ok(items) => items,
            Err(error) => {
                eprintln!("无法恢复组件任务：{error}");
                Vec::new()
            }
        };
        let mut changed = false;
        for item in &mut items {
            if item.status.active() {
                item.status = ComponentDownloadStatus::Failed;
                item.detail = "应用在任务完成前退出；可安全重试此组件。".to_string();
                item.updated_at = Utc::now().to_rfc3339();
                changed = true;
            }
        }
        let manager = Self {
            inner: Mutex::new(QueueState {
                items,
                ..QueueState::default()
            }),
            store_path: Some(store_path),
        };
        if changed {
            if let Ok(queue) = manager.inner.lock() {
                if let Err(error) = manager.persist(&queue) {
                    eprintln!("无法保存恢复后的组件任务：{error}");
                }
            }
        }
        manager
    }

    pub fn snapshot(&self) -> Vec<ComponentDownload> {
        self.inner
            .lock()
            .map(|queue| queue.items.clone())
            .unwrap_or_default()
    }

    #[cfg(test)]
    pub fn has_active(&self, component_id: &str) -> bool {
        self.inner
            .lock()
            .map(|queue| {
                queue
                    .items
                    .iter()
                    .any(|item| item.component_id == component_id && item.status.active())
            })
            .unwrap_or(true)
    }

    pub fn reserve_removal(
        self: &Arc<Self>,
        component_id: &str,
    ) -> Result<ComponentRemovalReservation, String> {
        let mut queue = self
            .inner
            .lock()
            .map_err(|_| "组件下载队列锁已损坏。".to_string())?;
        if queue
            .items
            .iter()
            .any(|item| item.component_id == component_id && item.status.active())
        {
            return Err("组件仍在下载或安装中，请等待任务结束后重试。".to_string());
        }
        if !queue.removal_reservations.insert(component_id.to_string()) {
            return Err("组件删除操作已经在进行中。".to_string());
        }
        Ok(ComponentRemovalReservation {
            manager: Arc::clone(self),
            component_id: component_id.to_string(),
        })
    }

    pub fn enqueue(&self, component_id: &str) -> Result<(Vec<ComponentDownload>, bool), String> {
        let display_name = component_display_name(component_id)
            .ok_or_else(|| "未知组件，无法加入下载队列。".to_string())?;
        let mut queue = self
            .inner
            .lock()
            .map_err(|_| "组件下载队列锁已损坏。".to_string())?;
        if queue.removal_reservations.contains(component_id) {
            return Err("组件正在删除，暂时不能加入安装队列。".to_string());
        }
        if queue
            .items
            .iter()
            .any(|item| item.component_id == component_id && item.status.active())
        {
            return Ok((queue.items.clone(), false));
        }
        queue
            .items
            .retain(|item| item.component_id != component_id || item.status.active());
        queue.items.push(ComponentDownload {
            id: Uuid::new_v4().to_string(),
            component_id: component_id.to_string(),
            display_name: display_name.to_string(),
            status: ComponentDownloadStatus::Queued,
            progress: 0,
            detail: "等待前面的下载任务完成。".to_string(),
            updated_at: Utc::now().to_rfc3339(),
        });
        if queue.items.len() > 24 {
            let removable = queue.items.iter().position(|item| !item.status.active());
            if let Some(index) = removable {
                queue.items.remove(index);
            }
        }
        let start_worker = !queue.worker_running;
        if start_worker {
            queue.worker_running = true;
        }
        if let Err(error) = self.persist(&queue) {
            queue.items.pop();
            if start_worker {
                queue.worker_running = false;
            }
            return Err(error);
        }
        Ok((queue.items.clone(), start_worker))
    }

    pub fn cancel_queued(&self, task_id: &str) -> Result<Vec<ComponentDownload>, String> {
        let mut queue = self
            .inner
            .lock()
            .map_err(|_| "组件下载队列锁已损坏。".to_string())?;
        let item = queue
            .items
            .iter_mut()
            .find(|item| item.id == task_id)
            .ok_or_else(|| "没有找到该组件任务。".to_string())?;
        if item.status != ComponentDownloadStatus::Queued {
            return Err("只有尚未开始的排队任务可以在此取消。".to_string());
        }
        let previous = item.clone();
        item.status = ComponentDownloadStatus::Cancelled;
        item.progress = 0;
        item.detail = "已在开始下载前取消。".to_string();
        item.updated_at = Utc::now().to_rfc3339();
        if let Err(error) = self.persist(&queue) {
            if let Some(item) = queue.items.iter_mut().find(|item| item.id == task_id) {
                *item = previous;
            }
            return Err(error);
        }
        Ok(queue.items.clone())
    }

    pub fn retry(&self, task_id: &str) -> Result<(Vec<ComponentDownload>, bool), String> {
        let mut queue = self
            .inner
            .lock()
            .map_err(|_| "组件下载队列锁已损坏。".to_string())?;
        let index = queue
            .items
            .iter()
            .position(|item| item.id == task_id)
            .ok_or_else(|| "没有找到该组件任务。".to_string())?;
        if !matches!(
            queue.items[index].status,
            ComponentDownloadStatus::Failed | ComponentDownloadStatus::Cancelled
        ) {
            return Err("只有失败或已取消的组件任务可以重试。".to_string());
        }
        let component_id = queue.items[index].component_id.clone();
        let previous = queue.items[index].clone();
        if queue.removal_reservations.contains(&component_id) {
            return Err("组件正在删除，暂时不能重试。".to_string());
        }
        if queue.items.iter().enumerate().any(|(other_index, item)| {
            other_index != index && item.component_id == component_id && item.status.active()
        }) {
            return Err("该组件已有活动任务。".to_string());
        }
        let item = &mut queue.items[index];
        item.status = ComponentDownloadStatus::Queued;
        item.progress = 0;
        item.detail = "等待前面的下载任务完成。".to_string();
        item.updated_at = Utc::now().to_rfc3339();
        let start_worker = !queue.worker_running;
        if start_worker {
            queue.worker_running = true;
        }
        if let Err(error) = self.persist(&queue) {
            queue.items[index] = previous;
            if start_worker {
                queue.worker_running = false;
            }
            return Err(error);
        }
        Ok((queue.items.clone(), start_worker))
    }

    pub async fn run_worker(self: Arc<Self>, components_dir: PathBuf, resource_dir: PathBuf) {
        loop {
            let Some((task_id, component_id)) = self.take_next_or_stop() else {
                return;
            };
            let manager = self.clone();
            let progress_task_id = task_id.clone();
            let task_components_dir = components_dir.clone();
            let task_resource_dir = resource_dir.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                install_component(
                    &component_id,
                    &task_components_dir,
                    &task_resource_dir,
                    |status, progress, detail| {
                        manager.update(&progress_task_id, status, progress, detail);
                    },
                )
            })
            .await;
            match result {
                Ok(operation) if operation.succeeded => self.finish(
                    &task_id,
                    ComponentDownloadStatus::Completed,
                    100,
                    if operation.detail.is_empty() {
                        operation.summary
                    } else {
                        format!("{} {}", operation.summary, operation.detail)
                    },
                ),
                Ok(operation) => self.finish(
                    &task_id,
                    ComponentDownloadStatus::Failed,
                    100,
                    if operation.detail.is_empty() {
                        operation.summary
                    } else {
                        format!("{} {}", operation.summary, operation.detail)
                    },
                ),
                Err(error) => self.finish(
                    &task_id,
                    ComponentDownloadStatus::Failed,
                    100,
                    format!("组件安装任务异常结束：{error}"),
                ),
            }
        }
    }

    fn take_next_or_stop(&self) -> Option<(String, String)> {
        let mut queue = self.inner.lock().ok()?;
        let Some(item) = queue
            .items
            .iter_mut()
            .find(|item| item.status == ComponentDownloadStatus::Queued)
        else {
            queue.worker_running = false;
            return None;
        };
        item.status = ComponentDownloadStatus::Downloading;
        item.progress = 2;
        item.detail = "正在准备内置组件下载。".to_string();
        item.updated_at = Utc::now().to_rfc3339();
        let next = (item.id.clone(), item.component_id.clone());
        if let Err(error) = self.persist(&queue) {
            eprintln!("无法持久化组件任务状态：{error}");
        }
        Some(next)
    }

    fn update(&self, task_id: &str, status: &str, progress: u8, detail: &str) {
        let status = match status {
            "installing" => ComponentDownloadStatus::Installing,
            _ => ComponentDownloadStatus::Downloading,
        };
        if let Ok(mut queue) = self.inner.lock() {
            if let Some(item) = queue.items.iter_mut().find(|item| item.id == task_id) {
                item.status = status;
                item.progress = progress.min(99);
                item.detail = detail.to_string();
                item.updated_at = Utc::now().to_rfc3339();
            }
            if let Err(error) = self.persist(&queue) {
                eprintln!("无法持久化组件任务进度：{error}");
            }
        }
    }

    fn finish(&self, task_id: &str, status: ComponentDownloadStatus, progress: u8, detail: String) {
        if let Ok(mut queue) = self.inner.lock() {
            if let Some(item) = queue.items.iter_mut().find(|item| item.id == task_id) {
                item.status = status;
                item.progress = progress;
                item.detail = detail;
                item.updated_at = Utc::now().to_rfc3339();
            }
            if let Err(error) = self.persist(&queue) {
                eprintln!("无法持久化组件任务结果：{error}");
            }
        }
    }

    fn persist(&self, queue: &QueueState) -> Result<(), String> {
        let Some(path) = &self.store_path else {
            return Ok(());
        };
        write_queue(path, &queue.items)
    }
}

fn load_queue(path: &Path) -> Result<Vec<ComponentDownload>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("无法读取 {}：{error}", path.display())),
    };
    let mut stored: PersistedQueue =
        serde_json::from_slice(&bytes).map_err(|error| format!("组件任务文件无法解析：{error}"))?;
    if stored.schema_version != 1 {
        return Err("组件任务文件版本不受支持。".to_string());
    }
    stored
        .items
        .retain(|item| component_display_name(&item.component_id).is_some());
    if stored.items.len() > 24 {
        stored.items.drain(..stored.items.len() - 24);
    }
    Ok(stored.items)
}

fn write_queue(path: &Path, items: &[ComponentDownload]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "组件任务文件缺少父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建组件任务目录：{error}"))?;
    let metadata = fs::symlink_metadata(parent).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("组件任务目录不是安全的普通目录。".to_string());
    }
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("组件任务文件不能是符号链接。".to_string());
    }
    let temporary = path.with_extension(format!("json.{}.tmp", Uuid::new_v4()));
    let payload = PersistedQueue {
        schema_version: 1,
        items: items.to_vec(),
    };
    let bytes = serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    if let Err(error) = replace_queue_file(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn replace_queue_file(source: &Path, target: &Path) -> std::io::Result<()> {
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
fn replace_queue_file(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

fn component_display_name(id: &str) -> Option<&'static str> {
    match id {
        "ffmpeg" => Some("FFmpeg"),
        "pi-audio" => Some("pi-audio"),
        "cvrs" => Some("CVRS"),
        "sandboxie" => Some("Sandboxie Plus"),
        "media-fetcher" => Some("媒体导入器"),
        "vocal-separation" => Some("人声伴奏分离"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_active_component_is_not_queued_twice() {
        let queue = ComponentDownloadManager::default();
        let (first, start) = queue.enqueue("pi-audio").unwrap();
        let (second, duplicate_start) = queue.enqueue("pi-audio").unwrap();
        assert!(start);
        assert!(!duplicate_start);
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
    }

    #[test]
    fn active_query_tracks_only_active_tasks_for_requested_component() {
        let queue = ComponentDownloadManager::default();
        assert!(!queue.has_active("pi-audio"));
        let (items, _) = queue.enqueue("pi-audio").unwrap();
        assert!(queue.has_active("pi-audio"));
        assert!(!queue.has_active("cvrs"));

        queue.finish(
            &items[0].id,
            ComponentDownloadStatus::Completed,
            100,
            "done".to_string(),
        );

        assert!(!queue.has_active("pi-audio"));
    }

    #[test]
    fn active_install_prevents_removal_reservation() {
        let queue = Arc::new(ComponentDownloadManager::default());
        queue.enqueue("pi-audio").unwrap();

        assert!(queue.reserve_removal("pi-audio").is_err());
        assert!(queue.reserve_removal("cvrs").is_ok());
    }

    #[test]
    fn removal_reservation_blocks_same_component_enqueue_until_drop() {
        let queue = Arc::new(ComponentDownloadManager::default());
        let reservation = queue.reserve_removal("pi-audio").unwrap();

        assert!(queue.enqueue("pi-audio").is_err());
        assert!(queue.enqueue("cvrs").is_ok());

        drop(reservation);
        assert!(queue.enqueue("pi-audio").is_ok());
    }

    #[test]
    fn unknown_component_is_rejected() {
        let queue = ComponentDownloadManager::default();
        assert!(queue.enqueue("../../unknown").is_err());
    }

    #[test]
    fn sandboxie_installer_uses_the_same_serial_queue() {
        let queue = ComponentDownloadManager::default();
        let (items, start) = queue.enqueue("sandboxie").unwrap();
        assert!(start);
        assert_eq!(items[0].component_id, "sandboxie");
        assert_eq!(items[0].display_name, "Sandboxie Plus");
    }

    #[test]
    fn an_enqueue_after_worker_stop_starts_a_new_worker() {
        let queue = ComponentDownloadManager::default();
        let (items, first_start) = queue.enqueue("pi-audio").unwrap();
        assert!(first_start);
        let task_id = items[0].id.clone();
        assert!(queue.take_next_or_stop().is_some());
        queue.finish(
            &task_id,
            ComponentDownloadStatus::Completed,
            100,
            "done".to_string(),
        );
        assert!(queue.take_next_or_stop().is_none());

        let (_, next_start) = queue.enqueue("cvrs").unwrap();
        assert!(next_start);
    }
}
