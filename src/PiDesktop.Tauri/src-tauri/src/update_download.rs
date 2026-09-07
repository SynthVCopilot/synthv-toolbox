use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::agent::paths::data_root;
use crate::config::UpdateChannel;
use crate::update_checker::{check_for_update, ToolboxUpdateAsset};

const MAX_UPDATE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxUpdateDownload {
    pub status: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
    pub file_name: Option<String>,
}

struct Manager {
    state: Mutex<ToolboxUpdateDownload>,
    cancel: AtomicBool,
    file: Mutex<Option<(PathBuf, ToolboxUpdateAsset)>>,
}
static MANAGER: OnceLock<Arc<Manager>> = OnceLock::new();

fn manager() -> &'static Arc<Manager> {
    MANAGER.get_or_init(|| {
        Arc::new(Manager {
            state: Mutex::new(ToolboxUpdateDownload {
                status: "idle".into(),
                downloaded_bytes: 0,
                total_bytes: None,
                error: None,
                file_name: None,
            }),
            cancel: AtomicBool::new(false),
            file: Mutex::new(None),
        })
    })
}
pub fn snapshot() -> ToolboxUpdateDownload {
    manager()
        .state
        .lock()
        .map(|state| state.clone())
        .unwrap_or(ToolboxUpdateDownload {
            status: "failed".into(),
            downloaded_bytes: 0,
            total_bytes: None,
            error: Some("更新下载状态不可用。".into()),
            file_name: None,
        })
}
pub fn cancel() -> ToolboxUpdateDownload {
    manager().cancel.store(true, Ordering::SeqCst);
    snapshot()
}

pub fn start(
    current_version: &str,
    channel: UpdateChannel,
) -> Result<ToolboxUpdateDownload, String> {
    let manager = manager().clone();
    let current_version = current_version.to_string();
    {
        let mut state = manager
            .state
            .lock()
            .map_err(|_| "更新下载状态不可用。".to_string())?;
        if state.status == "downloading" {
            return Ok(state.clone());
        }
        *state = ToolboxUpdateDownload {
            status: "downloading".into(),
            downloaded_bytes: 0,
            total_bytes: None,
            error: None,
            file_name: None,
        };
    }
    *manager
        .file
        .lock()
        .map_err(|_| "更新下载状态不可用。".to_string())? = None;
    manager.cancel.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        let result = check_for_update(&current_version, channel)
            .and_then(|check| {
                if check.update_available {
                    Ok(check)
                } else {
                    Err("当前渠道没有可安装的更新。".to_string())
                }
            })
            .and_then(|check| {
                check
                    .installer
                    .ok_or_else(|| "当前发布没有适用于此平台的已校验安装包。".to_string())
            })
            .and_then(|asset| download(&manager, asset));
        if let Err(error) = result {
            let mut state = manager.state.lock().unwrap();
            if manager.cancel.load(Ordering::SeqCst) {
                state.status = "cancelled".into();
                state.error = None;
            } else {
                state.status = "failed".into();
                state.error = Some(error);
            }
        }
    });
    Ok(snapshot())
}

fn download(manager: &Manager, asset: ToolboxUpdateAsset) -> Result<(), String> {
    if !asset
        .url
        .starts_with("https://github.com/SynthVCopilot/synthv-toolbox/releases/download/")
        || asset.size == 0
        || asset.size > MAX_UPDATE_BYTES
    {
        return Err("更新安装包元数据不安全。".into());
    }
    if asset.name.contains(['/', '\\']) || asset.name.contains("..") {
        return Err("更新安装包文件名不安全。".into());
    }
    let root = data_root().join("updates");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let target = root.join(&asset.name);
    let partial = root.join(format!(".{}.part", asset.name));
    let _ = fs::remove_file(&partial);
    if manager.cancel.load(Ordering::SeqCst) {
        return Err("下载已取消。".into());
    }
    let response = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .get(&asset.url)
        .call()
        .map_err(|e| format!("更新下载失败：{e}"))?;
    let length = response
        .header("Content-Length")
        .and_then(|v| v.parse().ok());
    if length.map(|v| v > MAX_UPDATE_BYTES).unwrap_or(false) {
        return Err("更新文件超过大小上限。".into());
    }
    {
        let mut state = manager.state.lock().unwrap();
        state.total_bytes = length.or(Some(asset.size));
        state.file_name = Some(asset.name.clone());
    }
    let result = (|| -> Result<(), String> {
        let mut reader = response.into_reader();
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)
            .map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut total = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            if manager.cancel.load(Ordering::SeqCst) {
                let _ = fs::remove_file(&partial);
                return Err("下载已取消。".into());
            }
            let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > MAX_UPDATE_BYTES {
                let _ = fs::remove_file(&partial);
                return Err("更新文件超过大小上限。".into());
            }
            file.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
            hash.update(&buffer[..n]);
            manager.state.lock().unwrap().downloaded_bytes = total;
        }
        file.sync_all().map_err(|e| e.to_string())?;
        if total != asset.size
            || format!("{:x}", hash.finalize()) != asset.sha256.to_ascii_lowercase()
        {
            let _ = fs::remove_file(&partial);
            return Err("更新文件校验失败。".into());
        }
        if target.exists() {
            let _ = fs::remove_file(&target);
        }
        fs::rename(&partial, &target).map_err(|e| e.to_string())?;
        if manager.cancel.load(Ordering::SeqCst) {
            return Err("下载已取消。".into());
        }
        *manager.file.lock().unwrap() = Some((target, asset));
        manager.state.lock().unwrap().status = "ready".into();
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

pub fn install() -> Result<(), String> {
    let manager = manager();
    if snapshot().status != "ready" {
        return Err("更新安装包尚未准备完成。".into());
    }
    let (path, asset) = manager
        .file
        .lock()
        .map_err(|_| "更新下载状态不可用。".to_string())?
        .clone()
        .ok_or_else(|| "没有已校验的更新安装包。".to_string())?;
    let mut file = File::open(&path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    if format!("{:x}", hash.finalize()) != asset.sha256.to_ascii_lowercase() {
        return Err("更新文件再次校验失败。".into());
    }
    #[cfg(windows)]
    {
        Command::new(&path)
            .spawn()
            .map_err(|e| format!("无法启动安装程序：{e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("无法打开安装镜像：{e}"))?;
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    return Err("当前平台不支持内部安装。".into());
    Ok(())
}

#[cfg(test)]
#[path = "../../../../test/update_download.rs"]
mod tests;
