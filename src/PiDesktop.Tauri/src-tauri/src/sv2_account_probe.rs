use std::fs;
use std::path::Path;

use chrono::Utc;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Sv2IdentityStatus {
    SessionPresent,
    SessionAbsent,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2ProfileIdentityView {
    pub status: Sv2IdentityStatus,
    pub username: Option<String>,
    pub email: Option<String>,
    pub detail: String,
    pub checked_at_utc: String,
}

impl Sv2ProfileIdentityView {
    fn new(status: Sv2IdentityStatus, detail: impl Into<String>) -> Self {
        Self {
            status,
            username: None,
            email: None,
            detail: detail.into(),
            checked_at_utc: Utc::now().to_rfc3339(),
        }
    }
}

/// Reports only whether an ordinary `license/session` file exists.
///
/// The file is deliberately treated as opaque: this probe never reads, parses,
/// logs, returns, or sends its bytes. Presence is not treated as proof that a
/// session is valid or that an account is signed in. Identity fields remain
/// unavailable because this independent process has no verified token broker.
pub fn probe_sv2_identity(data_root: &Path) -> Sv2ProfileIdentityView {
    match safe_metadata(data_root, "槽位数据目录") {
        Ok(Some(metadata)) if metadata.is_dir() => {}
        Ok(Some(_)) => {
            return Sv2ProfileIdentityView::new(
                Sv2IdentityStatus::Unknown,
                "槽位数据根路径不是普通目录，无法检查本地 session 文件。",
            );
        }
        Ok(None) => {
            return Sv2ProfileIdentityView::new(
                Sv2IdentityStatus::Unknown,
                "槽位数据目录不存在，无法检查本地 session 文件。",
            );
        }
        Err(detail) => {
            return Sv2ProfileIdentityView::new(Sv2IdentityStatus::Unknown, detail);
        }
    }

    let license_root = data_root.join("license");
    match safe_metadata(&license_root, "license 目录") {
        Ok(Some(metadata)) if metadata.is_dir() => {}
        Ok(Some(_)) => {
            return Sv2ProfileIdentityView::new(
                Sv2IdentityStatus::Unknown,
                "license 路径不是普通目录，无法检查本地 session 文件。",
            );
        }
        Ok(None) => {
            return Sv2ProfileIdentityView::new(
                Sv2IdentityStatus::SessionAbsent,
                "未检测到 license/session 文件；这不用于推断账号登录状态。",
            );
        }
        Err(detail) => {
            return Sv2ProfileIdentityView::new(Sv2IdentityStatus::Unknown, detail);
        }
    }

    let session_path = license_root.join("session");
    match safe_metadata(&session_path, "license/session") {
        Ok(Some(metadata)) if metadata.is_file() => {}
        Ok(Some(_)) => {
            return Sv2ProfileIdentityView::new(
                Sv2IdentityStatus::Unknown,
                "license/session 不是普通文件，无法确认其存在状态。",
            );
        }
        Ok(None) => {
            return Sv2ProfileIdentityView::new(
                Sv2IdentityStatus::SessionAbsent,
                "未检测到 license/session 文件；这不用于推断账号登录状态。",
            );
        }
        Err(detail) => {
            return Sv2ProfileIdentityView::new(Sv2IdentityStatus::Unknown, detail);
        }
    }

    Sv2ProfileIdentityView::new(
        Sv2IdentityStatus::SessionPresent,
        "检测到 license/session 文件；仅报告文件存在，不验证 session、账号或授权。独立进程没有已验证的 token broker，因此不会读取或复用该文件查询身份。",
    )
}

fn safe_metadata(path: &Path, label: &str) -> Result<Option<fs::Metadata>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法安全检查{label}：{error}")),
    };
    if is_link_or_reparse(&metadata) {
        return Err(format!("{label}是符号链接或 reparse point，已拒绝探测。"));
    }
    Ok(Some(metadata))
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn fixture() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("sv2-account-probe-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn missing_session_only_reports_file_absence() {
        let root = fixture();
        fs::create_dir_all(root.join("license")).unwrap();

        let identity = probe_sv2_identity(&root);

        assert_eq!(identity.status, Sv2IdentityStatus::SessionAbsent);
        assert_eq!(identity.username, None);
        assert_eq!(identity.email, None);
        assert!(!identity.checked_at_utc.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opaque_session_only_reports_file_presence() {
        let root = fixture();
        fs::create_dir_all(root.join("license")).unwrap();
        let secret = "producer@example.com:do-not-expose";
        fs::write(root.join("license/session"), secret).unwrap();

        let identity = probe_sv2_identity(&root);

        assert_eq!(identity.status, Sv2IdentityStatus::SessionPresent);
        assert_eq!(identity.username, None);
        assert_eq!(identity.email, None);
        assert!(identity.detail.contains("仅报告文件存在"));
        assert!(!identity.detail.contains(secret));
        assert!(!identity.detail.contains("producer@example.com"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn empty_or_large_session_files_are_not_interpreted() {
        let root = fixture();
        fs::create_dir_all(root.join("license")).unwrap();
        let session = fs::File::create(root.join("license/session")).unwrap();
        session.set_len(8 * 1024 * 1024).unwrap();

        let identity = probe_sv2_identity(&root);

        assert_eq!(identity.status, Sv2IdentityStatus::SessionPresent);
        assert!(identity.detail.contains("不会读取"));
        fs::remove_dir_all(root).unwrap();
    }
}
