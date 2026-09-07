use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::agent::paths::data_root;
use crate::components::reject_symlink_or_reparse;
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
    let manager = manager();
    manager.cancel.store(true, Ordering::SeqCst);
    if let Ok(mut state) = manager.state.lock() {
        if let Ok(mut file) = manager.file.lock() {
            *file = None;
        }
        if state.status == "ready" {
            state.status = "cancelled".into();
        }
    }
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
        *manager
            .file
            .lock()
            .map_err(|_| "更新下载状态不可用。".to_string())? = None;
        manager.cancel.store(false, Ordering::SeqCst);
        *state = ToolboxUpdateDownload {
            status: "downloading".into(),
            downloaded_bytes: 0,
            total_bytes: None,
            error: None,
            file_name: None,
        };
    }
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
    validate_asset(&asset)?;
    if manager.cancel.load(Ordering::SeqCst) {
        return Err("下载已取消。".into());
    }
    let response = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .get(&asset.url)
        .call()
        .map_err(|error| format!("更新下载失败：{error}"))?;
    if let Some(length) = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok())
    {
        if length != asset.size {
            return Err("更新文件长度与发布记录不一致。".into());
        }
    }
    let data = data_root();
    reject_symlink_or_reparse(&data, "应用数据目录")?;
    receive_update(
        manager,
        asset,
        &data.join("updates"),
        response.into_reader(),
    )
}

fn validate_asset(asset: &ToolboxUpdateAsset) -> Result<(), String> {
    if asset.name.is_empty()
        || !asset
            .name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        || asset.name.contains("..")
        || !asset
            .url
            .starts_with("https://github.com/SynthVCopilot/synthv-toolbox/releases/download/")
        || !asset.url.ends_with(&format!("/{}", asset.name))
        || asset.sha256.len() != 64
        || !asset.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        || asset.size == 0
        || asset.size > MAX_UPDATE_BYTES
    {
        return Err("更新安装包元数据无效。".into());
    }
    Ok(())
}

fn receive_update(
    manager: &Manager,
    asset: ToolboxUpdateAsset,
    root: &Path,
    mut reader: impl Read,
) -> Result<(), String> {
    validate_asset(&asset)?;
    reject_symlink_or_reparse(root, "更新目录")?;
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let target = root.join(&asset.name);
    reject_symlink_or_reparse(&target, "安装包")?;
    let partial = root.join(format!(".download-{}.part", uuid::Uuid::new_v4()));
    {
        let mut state = manager.state.lock().map_err(|error| error.to_string())?;
        state.total_bytes = Some(asset.size);
        state.file_name = Some(asset.name.clone());
    }
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)
            .map_err(|error| error.to_string())?;
        let mut hash = Sha256::new();
        let mut total = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            if manager.cancel.load(Ordering::SeqCst) {
                return Err("下载已取消。".into());
            }
            let read = reader
                .read(&mut buffer)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            total += read as u64;
            if total > asset.size {
                return Err("更新文件超过发布记录大小。".into());
            }
            file.write_all(&buffer[..read])
                .map_err(|error| error.to_string())?;
            hash.update(&buffer[..read]);
            manager
                .state
                .lock()
                .map_err(|error| error.to_string())?
                .downloaded_bytes = total;
        }
        if total != asset.size
            || format!("{:x}", hash.finalize()) != asset.sha256.to_ascii_lowercase()
        {
            return Err("更新文件校验失败。".into());
        }
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        let mut state = manager.state.lock().map_err(|error| error.to_string())?;
        if manager.cancel.load(Ordering::SeqCst) {
            return Err("下载已取消。".into());
        }
        reject_symlink_or_reparse(&target, "安装包")?;
        if target.exists() {
            fs::remove_file(&target).map_err(|error| error.to_string())?;
        }
        fs::rename(&partial, &target).map_err(|error| error.to_string())?;
        *manager.file.lock().map_err(|error| error.to_string())? = Some((target, asset));
        state.status = "ready".into();
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

fn verify_installer(path: &Path, asset: &ToolboxUpdateAsset) -> Result<(), String> {
    reject_symlink_or_reparse(path, "安装包")?;
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    if file.metadata().map_err(|error| error.to_string())?.len() != asset.size {
        return Err("安装包大小已改变。".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    if format!("{:x}", hash.finalize()) != asset.sha256.to_ascii_lowercase() {
        return Err("更新文件再次校验失败。".into());
    }
    Ok(())
}

pub fn install() -> Result<(), String> {
    let manager = manager();
    let state = manager.state.lock().map_err(|error| error.to_string())?;
    if state.status != "ready" || manager.cancel.load(Ordering::SeqCst) {
        return Err("更新安装包尚未准备完成。".into());
    }
    let (path, asset) = manager
        .file
        .lock()
        .map_err(|_| "更新下载状态不可用。".to_string())?
        .clone()
        .ok_or_else(|| "没有已校验的更新安装包。".to_string())?;
    verify_installer(&path, &asset)?;
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
