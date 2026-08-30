use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const GUARD_SCHEMA_VERSION: u32 = 1;
const MAX_SESSION_BYTES: u64 = 1024 * 1024;
const MISSING_SESSION_GRACE_SECONDS: i64 = 10;
const SESSION_RECOVERY_WINDOW_SECONDS: i64 = 10 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Sv2SessionEnvironment {
    Normal,
    Concurrent,
}

impl Sv2SessionEnvironment {
    fn file_stem(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Concurrent => "concurrent",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum GuardPhase {
    #[default]
    Clean,
    Monitoring,
    RecoveryPending,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuardRecord {
    schema_version: u32,
    slot_id: String,
    environment: Sv2SessionEnvironment,
    #[serde(default)]
    phase: GuardPhase,
    #[serde(default)]
    armed_at_utc: Option<String>,
    #[serde(default)]
    baseline_sha256: Option<String>,
    #[serde(default)]
    last_detected_at_utc: Option<String>,
    #[serde(default)]
    last_restored_at_utc: Option<String>,
}

impl GuardRecord {
    fn new(slot_id: &str, environment: Sv2SessionEnvironment) -> Self {
        Self {
            schema_version: GUARD_SCHEMA_VERSION,
            slot_id: slot_id.to_string(),
            environment,
            phase: GuardPhase::Clean,
            armed_at_utc: None,
            baseline_sha256: None,
            last_detected_at_utc: None,
            last_restored_at_utc: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Sv2SessionProtectionStatus {
    SessionAbsent,
    Ready,
    Monitoring,
    RecoveryPending,
    Restored,
    Attention,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2SessionProtectionView {
    pub status: Sv2SessionProtectionStatus,
    pub snapshot_available: bool,
    pub last_detected_at_utc: Option<String>,
    pub last_restored_at_utc: Option<String>,
    pub detail: String,
}

impl Sv2SessionProtectionView {
    pub fn attention(detail: String) -> Self {
        Self {
            status: Sv2SessionProtectionStatus::Attention,
            snapshot_available: false,
            last_detected_at_utc: None,
            last_restored_at_utc: None,
            detail,
        }
    }

    pub fn recovery_pending(&self) -> bool {
        self.status == Sv2SessionProtectionStatus::RecoveryPending
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SessionLaunchPreparation {
    pub snapshot_armed: bool,
    pub restored_before_launch: bool,
}

#[derive(Debug, Clone)]
pub struct Sv2SessionGuardStore {
    root: PathBuf,
}

impl Sv2SessionGuardStore {
    pub fn new(metadata_root: &Path) -> Self {
        Self {
            root: metadata_root.join("session-recovery"),
        }
    }

    pub fn prepare_launch(
        &self,
        slot_id: &str,
        environment: Sv2SessionEnvironment,
        data_root: &Path,
    ) -> Result<SessionLaunchPreparation, String> {
        validate_slot_id(slot_id)?;
        self.validate_paths(slot_id, data_root)?;
        let mut record = self.reconcile_record(slot_id, environment, data_root, false)?;
        let restored_before_launch = if record.phase == GuardPhase::RecoveryPending {
            self.restore_pending(&mut record, data_root)?
        } else {
            false
        };
        let snapshot_armed = self.arm(&mut record, data_root)?;
        Ok(SessionLaunchPreparation {
            snapshot_armed,
            restored_before_launch,
        })
    }

    pub fn view(
        &self,
        slot_id: &str,
        environment: Sv2SessionEnvironment,
        data_root: &Path,
        running: bool,
    ) -> Result<Sv2SessionProtectionView, String> {
        validate_slot_id(slot_id)?;
        self.validate_paths(slot_id, data_root)?;
        let record = self.reconcile_record(slot_id, environment, data_root, running)?;
        let session_file_present = session_path(data_root).is_file();
        let snapshot_available = self.snapshot_path(slot_id, environment).is_file();
        let (status, detail) = match record.phase {
            GuardPhase::Monitoring => (
                Sv2SessionProtectionStatus::Monitoring,
                "本次启动的本地 session 已建立保护快照；SV2 退出后会检查本地文件是否发生变化。".to_string(),
            ),
            GuardPhase::RecoveryPending => (
                Sv2SessionProtectionStatus::RecoveryPending,
                "检测到受保护启动后的本地 session 文件消失。不会覆盖后来生成的新文件；下次由工具箱启动此槽位前将尝试原样恢复。".to_string(),
            ),
            GuardPhase::Clean if !session_file_present => (
                Sv2SessionProtectionStatus::SessionAbsent,
                "当前没有本地 session 文件；这不用于判断账号是否需要登录。文件出现后，工具箱启动 SV2 时会建立保护快照。".to_string(),
            ),
            GuardPhase::Clean if record.last_restored_at_utc.is_some() => (
                Sv2SessionProtectionStatus::Restored,
                "最近一次丢失的本地 session 文件已在启动前恢复；其内容与有效性仍由 SV2 和 Dreamtonics 服务判断。".to_string(),
            ),
            GuardPhase::Clean => (
                Sv2SessionProtectionStatus::Ready,
                "本地 session 文件存在；工具箱启动 SV2 时会先建立不透明保护快照。".to_string(),
            ),
        };
        Ok(Sv2SessionProtectionView {
            status,
            snapshot_available,
            last_detected_at_utc: record.last_detected_at_utc,
            last_restored_at_utc: record.last_restored_at_utc,
            detail,
        })
    }

    fn reconcile_record(
        &self,
        slot_id: &str,
        environment: Sv2SessionEnvironment,
        data_root: &Path,
        running: bool,
    ) -> Result<GuardRecord, String> {
        let mut record = self.load_record(slot_id, environment)?;
        if record.phase == GuardPhase::Clean {
            return Ok(record);
        }

        let session = read_session(data_root)?;
        if record.phase == GuardPhase::RecoveryPending {
            if session.is_some() {
                record.phase = GuardPhase::Clean;
                record.armed_at_utc = None;
                record.baseline_sha256 = None;
                self.remove_snapshot(slot_id, environment)?;
                self.save_record(&record)?;
            }
            return Ok(record);
        }

        if session.is_none() {
            let elapsed = record
                .armed_at_utc
                .as_deref()
                .and_then(parse_utc)
                .map(|armed| (Utc::now() - armed).num_seconds());
            if elapsed.is_some_and(|seconds| seconds > SESSION_RECOVERY_WINDOW_SECONDS) {
                record.phase = GuardPhase::Clean;
                record.armed_at_utc = None;
                record.baseline_sha256 = None;
                self.remove_snapshot(slot_id, environment)?;
                self.save_record(&record)?;
                return Ok(record);
            }
            let grace_elapsed =
                elapsed.is_none_or(|seconds| seconds >= MISSING_SESSION_GRACE_SECONDS);
            if !running || grace_elapsed {
                record.phase = GuardPhase::RecoveryPending;
                record.last_detected_at_utc = Some(Utc::now().to_rfc3339());
                self.save_record(&record)?;
            }
            return Ok(record);
        }

        if !running {
            record.phase = GuardPhase::Clean;
            record.armed_at_utc = None;
            record.baseline_sha256 = None;
            self.remove_snapshot(slot_id, environment)?;
            self.save_record(&record)?;
        }
        Ok(record)
    }

    fn restore_pending(&self, record: &mut GuardRecord, data_root: &Path) -> Result<bool, String> {
        if read_session(data_root)?.is_some() {
            record.phase = GuardPhase::Clean;
            record.armed_at_utc = None;
            record.baseline_sha256 = None;
            self.remove_snapshot(&record.slot_id, record.environment)?;
            self.save_record(record)?;
            return Ok(false);
        }

        let snapshot_path = self.snapshot_path(&record.slot_id, record.environment);
        reject_reparse_point(&snapshot_path)?;
        let snapshot = fs::read(&snapshot_path)
            .map_err(|error| format!("无法读取本地 session 恢复快照：{error}"))?;
        if snapshot.is_empty() || snapshot.len() as u64 > MAX_SESSION_BYTES {
            return Err("本地 session 恢复快照大小异常，已停止自动恢复。".to_string());
        }
        let expected = record
            .baseline_sha256
            .as_deref()
            .ok_or_else(|| "本地 session 恢复记录缺少 SHA-256。".to_string())?;
        if sha256(&snapshot) != expected {
            return Err("本地 session 恢复快照 SHA-256 不匹配，已停止自动恢复。".to_string());
        }
        let license = data_root.join("license");
        fs::create_dir_all(&license)
            .map_err(|error| format!("无法创建 SV2 license 目录：{error}"))?;
        reject_reparse_point(&license)?;
        write_bytes_atomic(&session_path(data_root), &snapshot, "本地 session 恢复文件")?;
        record.phase = GuardPhase::Clean;
        record.last_restored_at_utc = Some(Utc::now().to_rfc3339());
        record.armed_at_utc = None;
        self.save_record(record)?;
        Ok(true)
    }

    fn arm(&self, record: &mut GuardRecord, data_root: &Path) -> Result<bool, String> {
        let Some(session) = read_session(data_root)? else {
            return Ok(false);
        };
        let digest = sha256(&session);
        let snapshot_path = self.snapshot_path(&record.slot_id, record.environment);
        write_bytes_atomic(&snapshot_path, &session, "本地 session 保护快照")?;
        record.phase = GuardPhase::Monitoring;
        record.armed_at_utc = Some(Utc::now().to_rfc3339());
        record.baseline_sha256 = Some(digest);
        self.save_record(record)?;
        Ok(true)
    }

    fn load_record(
        &self,
        slot_id: &str,
        environment: Sv2SessionEnvironment,
    ) -> Result<GuardRecord, String> {
        let path = self.record_path(slot_id, environment);
        if !path.is_file() {
            return Ok(GuardRecord::new(slot_id, environment));
        }
        reject_reparse_point(&path)?;
        let text = fs::read_to_string(&path)
            .map_err(|error| format!("无法读取本地 session 保护记录：{error}"))?;
        let record: GuardRecord = serde_json::from_str(&text)
            .map_err(|error| format!("本地 session 保护记录不是有效 JSON：{error}"))?;
        if record.schema_version != GUARD_SCHEMA_VERSION
            || record.slot_id != slot_id
            || record.environment != environment
        {
            return Err("本地 session 保护记录与账号槽位不匹配。".to_string());
        }
        Ok(record)
    }

    fn save_record(&self, record: &GuardRecord) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(record).map_err(|error| error.to_string())?;
        write_bytes_atomic(
            &self.record_path(&record.slot_id, record.environment),
            &bytes,
            "本地 session 保护记录",
        )
    }

    fn remove_snapshot(
        &self,
        slot_id: &str,
        environment: Sv2SessionEnvironment,
    ) -> Result<(), String> {
        let path = self.snapshot_path(slot_id, environment);
        if path.is_file() {
            reject_reparse_point(&path)?;
            fs::remove_file(path)
                .map_err(|error| format!("无法清理本地 session 保护快照：{error}"))?;
        }
        Ok(())
    }

    fn record_path(&self, slot_id: &str, environment: Sv2SessionEnvironment) -> PathBuf {
        self.root
            .join(slot_id)
            .join(format!("{}.json", environment.file_stem()))
    }

    fn snapshot_path(&self, slot_id: &str, environment: Sv2SessionEnvironment) -> PathBuf {
        self.root
            .join(slot_id)
            .join(format!("{}.session", environment.file_stem()))
    }

    fn validate_paths(&self, slot_id: &str, data_root: &Path) -> Result<(), String> {
        reject_reparse_point(&self.root)?;
        reject_reparse_point(&self.root.join(slot_id))?;
        reject_reparse_point(data_root)?;
        reject_reparse_point(&data_root.join("license"))?;
        reject_reparse_point(&session_path(data_root))
    }
}

fn read_session(data_root: &Path) -> Result<Option<Vec<u8>>, String> {
    let path = session_path(data_root);
    if !path.is_file() {
        return Ok(None);
    }
    reject_reparse_point(&path)?;
    let metadata =
        fs::metadata(&path).map_err(|error| format!("无法检查 SV2 session 文件：{error}"))?;
    if metadata.len() == 0 || metadata.len() > MAX_SESSION_BYTES {
        return Ok(None);
    }
    fs::read(path)
        .map(Some)
        .map_err(|error| format!("无法读取 SV2 session 文件：{error}"))
}

fn session_path(data_root: &Path) -> PathBuf {
    data_root.join("license").join("session")
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn parse_utc(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn validate_slot_id(value: &str) -> Result<(), String> {
    match Uuid::parse_str(value) {
        Ok(id) if id.get_version_num() == 4 => Ok(()),
        _ => Err("本地 session 保护记录的槽位 ID 非法。".to_string()),
    }
}

fn write_bytes_atomic(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label}路径没有父目录。"))?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建{label}目录：{error}"))?;
    reject_reparse_point(parent)?;
    reject_reparse_point(path)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("session"),
        Uuid::new_v4()
    ));
    let mut file = File::create(&temporary).map_err(|error| format!("无法创建{label}：{error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("无法写入{label}：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("无法刷新{label}：{error}"))?;
    drop(file);
    replace_file(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("无法提交{label}：{error}")
    })
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
    if target.exists() {
        fs::remove_file(target)?;
    }
    fs::rename(source, target)
}

fn reject_reparse_point(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("无法检查路径 {}：{error}", path.display()))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!(
                "路径 {} 是 reparse point；本地 session 保护已停止。",
                path.display()
            ));
        }
    }
    #[cfg(not(windows))]
    if metadata.file_type().is_symlink() {
        return Err(format!("路径 {} 是符号链接。", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, PathBuf, String, Sv2SessionGuardStore) {
        let root = std::env::temp_dir().join(format!("sv2-session-guard-{}", Uuid::new_v4()));
        let metadata = root.join("metadata");
        let data = root.join("data");
        fs::create_dir_all(data.join("license")).unwrap();
        let slot_id = Uuid::new_v4().to_string();
        let store = Sv2SessionGuardStore::new(&metadata);
        (root, data, slot_id, store)
    }

    #[test]
    fn missing_session_becomes_recoverable_and_is_restored_before_next_launch() {
        let (root, data, slot_id, store) = fixture();
        fs::write(session_path(&data), b"opaque-session").unwrap();
        let first = store
            .prepare_launch(&slot_id, Sv2SessionEnvironment::Normal, &data)
            .unwrap();
        assert!(first.snapshot_armed);
        fs::remove_file(session_path(&data)).unwrap();

        let pending = store
            .view(&slot_id, Sv2SessionEnvironment::Normal, &data, false)
            .unwrap();
        assert_eq!(pending.status, Sv2SessionProtectionStatus::RecoveryPending);

        let second = store
            .prepare_launch(&slot_id, Sv2SessionEnvironment::Normal, &data)
            .unwrap();
        assert!(second.restored_before_launch);
        assert!(second.snapshot_armed);
        assert_eq!(fs::read(session_path(&data)).unwrap(), b"opaque-session");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_new_session_is_never_overwritten_by_the_snapshot() {
        let (root, data, slot_id, store) = fixture();
        fs::write(session_path(&data), b"old-session").unwrap();
        store
            .prepare_launch(&slot_id, Sv2SessionEnvironment::Concurrent, &data)
            .unwrap();
        fs::remove_file(session_path(&data)).unwrap();
        store
            .view(&slot_id, Sv2SessionEnvironment::Concurrent, &data, false)
            .unwrap();
        fs::write(session_path(&data), b"new-session").unwrap();

        let next = store
            .prepare_launch(&slot_id, Sv2SessionEnvironment::Concurrent, &data)
            .unwrap();
        assert!(!next.restored_before_launch);
        assert_eq!(fs::read(session_path(&data)).unwrap(), b"new-session");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clean_exit_removes_the_short_lived_snapshot() {
        let (root, data, slot_id, store) = fixture();
        fs::write(session_path(&data), b"session").unwrap();
        store
            .prepare_launch(&slot_id, Sv2SessionEnvironment::Normal, &data)
            .unwrap();
        let clean = store
            .view(&slot_id, Sv2SessionEnvironment::Normal, &data, false)
            .unwrap();
        assert_eq!(clean.status, Sv2SessionProtectionStatus::Ready);
        assert!(!clean.snapshot_available);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_session_removed_outside_the_window_is_not_attributed_or_restored() {
        let (root, data, slot_id, store) = fixture();
        fs::write(session_path(&data), b"session").unwrap();
        store
            .prepare_launch(&slot_id, Sv2SessionEnvironment::Normal, &data)
            .unwrap();
        let mut record = store
            .load_record(&slot_id, Sv2SessionEnvironment::Normal)
            .unwrap();
        record.armed_at_utc = Some(
            (Utc::now() - chrono::Duration::seconds(SESSION_RECOVERY_WINDOW_SECONDS + 1))
                .to_rfc3339(),
        );
        store.save_record(&record).unwrap();
        fs::remove_file(session_path(&data)).unwrap();

        let view = store
            .view(&slot_id, Sv2SessionEnvironment::Normal, &data, false)
            .unwrap();
        assert_eq!(view.status, Sv2SessionProtectionStatus::SessionAbsent);
        assert!(!view.snapshot_available);
        fs::remove_dir_all(root).unwrap();
    }
}
