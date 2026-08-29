use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use serde::Serialize;
use uuid::Uuid;

use crate::components::install_component;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ComponentDownloadStatus {
    Queued,
    Downloading,
    Installing,
    Completed,
    Failed,
}

impl ComponentDownloadStatus {
    fn active(self) -> bool {
        matches!(self, Self::Queued | Self::Downloading | Self::Installing)
    }
}

#[derive(Debug, Clone, Serialize)]
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
}

#[derive(Default)]
pub struct ComponentDownloadManager {
    inner: Mutex<QueueState>,
}

impl ComponentDownloadManager {
    pub fn snapshot(&self) -> Vec<ComponentDownload> {
        self.inner
            .lock()
            .map(|queue| queue.items.clone())
            .unwrap_or_default()
    }

    pub fn enqueue(&self, component_id: &str) -> Result<(Vec<ComponentDownload>, bool), String> {
        let display_name = component_display_name(component_id)
            .ok_or_else(|| "未知组件，无法加入下载队列。".to_string())?;
        let mut queue = self
            .inner
            .lock()
            .map_err(|_| "组件下载队列锁已损坏。".to_string())?;
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
        item.detail = "正在准备 aria2 下载。".to_string();
        item.updated_at = Utc::now().to_rfc3339();
        Some((item.id.clone(), item.component_id.clone()))
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
        }
    }
}

fn component_display_name(id: &str) -> Option<&'static str> {
    match id {
        "pi-audio" => Some("pi-audio"),
        "cvrs" => Some("CVRS"),
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
    fn unknown_component_is_rejected() {
        let queue = ComponentDownloadManager::default();
        assert!(queue.enqueue("../../unknown").is_err());
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
