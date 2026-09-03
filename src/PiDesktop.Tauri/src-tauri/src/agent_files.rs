use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

use chrono::Utc;
use serde::Serialize;
use uuid::Uuid;

pub use crate::config::AgentWorkMode;

const AUDIO_AND_SCORE: &[&str] = &[
    "svp", "svprj", "mid", "midi", "wav", "flac", "mp3", "m4a", "aac", "ogg", "opus", "aiff",
    "aif", "caf", "alac", "mp4", "webm", "mkv", "mov", "avi", "mpeg", "mpg", "musicxml", "mxl",
    "lrc", "klrc", "srt", "vtt", "lab", "ust", "ustx", "vsq", "vsqx",
];
const MAX_PENDING: usize = 64;
const MAX_DECISIONS: usize = 128;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFileEntry {
    pub path: String,
    pub file_type: String,
    pub size: u64,
    pub decision: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAccessDecision {
    pub decision: String,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileApprovalRequest {
    pub id: String,
    pub path: String,
    pub purpose: String,
    pub created_at_utc: String,
    #[serde(skip_serializing)]
    session_id: String,
    #[serde(skip_serializing)]
    fingerprint: FileFingerprint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileFingerprint {
    size: u64,
    modified_nanos: u128,
}

#[derive(Debug, Clone)]
struct Grant {
    fingerprint: FileFingerprint,
}

#[derive(Default)]
pub struct FileApprovalManager {
    pending: Mutex<HashMap<String, FileApprovalRequest>>,
    grants: Mutex<HashMap<String, Grant>>,
    denied: Mutex<HashMap<String, Grant>>,
}

impl FileApprovalManager {
    pub fn list(&self, path: &str) -> Result<Vec<AgentFileEntry>, String> {
        let path = safe_existing_path(path)?;
        if !is_allowed_root(&path) {
            return Err("目录不在当前用户 HOME 的允许区域；不会读取文件内容。".to_string());
        }
        if !path.is_dir() {
            return Err("枚举目标必须是目录。".to_string());
        }
        let mut entries = fs::read_dir(path)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .map(|e| {
                let p = e.path();
                let meta = fs::symlink_metadata(&p).ok();
                let is_dir = meta.as_ref().is_some_and(|m| m.is_dir());
                AgentFileEntry {
                    path: p.to_string_lossy().into_owned(),
                    file_type: if is_dir {
                        "directory".into()
                    } else {
                        extension(&p)
                    },
                    size: meta.map(|m| m.len()).unwrap_or(0),
                    decision: if is_dir {
                        "pass".into()
                    } else {
                        approval_kind(&p).into()
                    },
                }
            })
            .collect::<Vec<_>>();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }

    pub fn admit_or_request(
        &self,
        path: &str,
        purpose: &str,
        mode: AgentWorkMode,
        session_id: &str,
    ) -> Result<FileAccessDecision, String> {
        let purpose = purpose.trim();
        if purpose.is_empty() || purpose.chars().count() > 240 {
            return Err("文件访问 purpose 必须为 1–240 个非空白字符。".into());
        }
        let path = safe_existing_path(path)?;
        if !is_allowed_root(&path) {
            return Err("路径不在允许根或由用户在界面明确提供的路径中。".to_string());
        }
        if auto_allowed(&path) || mode == AgentWorkMode::Solo {
            return Ok(FileAccessDecision {
                decision: "pass".into(),
                request_id: None,
            });
        }
        let key = grant_key(&path, session_id);
        let fingerprint = fingerprint(&path)?;
        if self
            .denied
            .lock()
            .map_err(|_| "审批状态不可用".to_string())?
            .get(&key)
            .is_some_and(|grant| grant.fingerprint == fingerprint)
        {
            return Err("此文件的人工访问已被拒绝。".into());
        }
        if self
            .grants
            .lock()
            .map_err(|_| "审批状态不可用".to_string())?
            .get(&key)
            .is_some_and(|grant| grant.fingerprint == fingerprint)
        {
            return Ok(FileAccessDecision {
                decision: "pass".into(),
                request_id: None,
            });
        }
        if let Some(request) = self
            .pending
            .lock()
            .map_err(|_| "审批队列不可用".to_string())?
            .values()
            .find(|request| {
                request.session_id == session_id
                    && request.path == path.to_string_lossy()
                    && request.fingerprint == fingerprint
            })
            .cloned()
        {
            return Ok(FileAccessDecision {
                decision: "human-approval-required".into(),
                request_id: Some(request.id),
            });
        }
        let request = FileApprovalRequest {
            id: Uuid::new_v4().to_string(),
            path: path.to_string_lossy().into_owned(),
            purpose: purpose.to_string(),
            created_at_utc: Utc::now().to_rfc3339(),
            session_id: session_id.to_string(),
            fingerprint,
        };
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "审批队列不可用".to_string())?;
        if pending.len() >= MAX_PENDING {
            pending.clear();
        }
        pending.insert(request.id.clone(), request.clone());
        Ok(FileAccessDecision {
            decision: "human-approval-required".into(),
            request_id: Some(request.id),
        })
    }

    pub fn pending(&self, session_id: &str) -> Vec<FileApprovalRequest> {
        let mut requests: Vec<FileApprovalRequest> = self
            .pending
            .lock()
            .map(|p| {
                p.values()
                    .filter(|r| r.session_id == session_id)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        requests.sort_by(|a, b| {
            a.created_at_utc
                .cmp(&b.created_at_utc)
                .then_with(|| a.id.cmp(&b.id))
        });
        requests
    }
    pub fn decide(&self, id: &str, approve: bool, session_id: &str) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "审批队列不可用".to_string())?;
        let req = pending
            .get(id)
            .cloned()
            .ok_or_else(|| "审批请求不存在或已处理。".to_string())?;
        if req.session_id != session_id {
            return Err("不能处理其他会话的文件审批请求。".into());
        }
        pending.remove(id);
        drop(pending);
        let key = format!("{}:{}", req.session_id, req.path);
        let grant = Grant {
            fingerprint: req.fingerprint,
        };
        if approve {
            let mut grants = self
                .grants
                .lock()
                .map_err(|_| "审批状态不可用".to_string())?;
            if grants.len() >= MAX_DECISIONS {
                grants.clear();
            }
            grants.insert(key, grant);
        } else {
            let mut denied = self
                .denied
                .lock()
                .map_err(|_| "审批状态不可用".to_string())?;
            if denied.len() >= MAX_DECISIONS {
                denied.clear();
            }
            denied.insert(key, grant);
        }
        Ok(())
    }
}

pub fn auto_allowed(path: &Path) -> bool {
    AUDIO_AND_SCORE.contains(&extension(path).as_str())
        || (is_managed_creative(path) && matches!(extension(path).as_str(), "txt" | "json" | "xml"))
}
pub fn approval_kind(path: &Path) -> &'static str {
    if auto_allowed(path) {
        "pass"
    } else {
        "human-approval-required"
    }
}
pub fn is_path_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace('_', "");
    key == "path"
        || key == "file"
        || key == "directory"
        || key.ends_with("path")
        || key.ends_with("directory")
}

pub fn safe_existing_path(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() || raw.contains('\0') || raw.contains("://") {
        return Err("拒绝设备路径、网络 URL 或 NUL 路径。".into());
    }
    #[cfg(windows)]
    if raw.starts_with("\\\\")
        || raw.starts_with("\\\\?\\")
        || raw.starts_with("\\\\.\\")
        || raw
            .split(['\\', '/'])
            .any(|part| part.contains(':') && part.len() != 2)
    {
        return Err("拒绝 UNC、设备或 ADS 路径。".into());
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("仅允许绝对且无父级穿透的路径。".into());
    }
    reject_linked_components(&path)?;
    let canonical = fs::canonicalize(&path).map_err(|_| "无法规范化文件路径。".to_string())?;
    Ok(canonical)
}
fn reject_linked_components(path: &Path) -> Result<(), String> {
    let mut walked = PathBuf::new();
    for component in path.components() {
        walked.push(component.as_os_str());
        if let Ok(meta) = fs::symlink_metadata(&walked) {
            if meta.file_type().is_symlink() {
                return Err("拒绝符号链接或 reparse 穿透。".into());
            }
            #[cfg(windows)]
            if meta.file_attributes() & 0x400 != 0 {
                return Err("拒绝 Windows reparse 路径。".into());
            }
        }
    }
    Ok(())
}
fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}
fn is_allowed_root(path: &Path) -> bool {
    let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .and_then(|p| fs::canonicalize(p).ok())
    else {
        return false;
    };
    if !path.starts_with(&home) {
        return false;
    }
    let sensitive = [
        home.join(".ssh"),
        home.join(".gnupg"),
        home.join("Library/Keychains"),
        home.join("Library/Safari"),
        home.join("Library/Application Support/Google"),
        home.join("Library/Application Support/Firefox"),
        home.join("AppData/Roaming/Microsoft/Credentials"),
        home.join("AppData/Roaming/Microsoft/Protect"),
        home.join("AppData/Local/Google/Chrome/User Data"),
        home.join("AppData/Roaming/Mozilla/Firefox/Profiles"),
    ];
    !sensitive.iter().any(|root| path.starts_with(root))
}
fn is_managed_creative(path: &Path) -> bool {
    let root = crate::agent::data_root();
    [
        root.join("media-imports"),
        root.join("lyrics"),
        root.join("output").join("covers"),
        root.join("output").join("synthv-snapshots"),
    ]
    .iter()
    .any(|p| path.starts_with(p))
}
fn fingerprint(path: &Path) -> Result<FileFingerprint, String> {
    let meta = fs::metadata(path).map_err(|_| "文件已不可访问。".to_string())?;
    let modified_nanos = meta
        .modified()
        .ok()
        .and_then(|v| v.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|v| v.as_nanos())
        .unwrap_or(0);
    Ok(FileFingerprint {
        size: meta.len(),
        modified_nanos,
    })
}
fn grant_key(path: &Path, session_id: &str) -> String {
    format!("{}:{}", session_id, path.to_string_lossy())
}
