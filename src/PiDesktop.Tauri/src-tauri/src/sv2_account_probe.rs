use std::fs;
use std::path::Path;

use chrono::Utc;
use serde::Serialize;

const MAX_SESSION_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Sv2IdentityStatus {
    SignedOut,
    CredentialDetected,
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

/// Reports only whether a bounded, ordinary SV2 session credential file exists.
///
/// The session format is deliberately treated as opaque: this probe never reads,
/// parses, logs, or returns credential bytes. Identity fields remain unavailable
/// until Dreamtonics exposes a documented, non-secret representation for them.
pub fn probe_sv2_identity(data_root: &Path) -> Sv2ProfileIdentityView {
    match safe_metadata(data_root, "槽位数据目录") {
        Ok(Some(metadata)) if metadata.is_dir() => {}
        Ok(Some(_)) => {
            return Sv2ProfileIdentityView::new(
                Sv2IdentityStatus::Unknown,
                "槽位数据根路径不是普通目录，无法安全探测登录状态。",
            );
        }
        Ok(None) => {
            return Sv2ProfileIdentityView::new(
                Sv2IdentityStatus::Unknown,
                "槽位数据目录不存在，无法探测登录状态。",
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
                "license 路径不是普通目录，无法安全探测登录状态。",
            );
        }
        Ok(None) => {
            return Sv2ProfileIdentityView::new(
                Sv2IdentityStatus::SignedOut,
                "未检测到 license/session 登录凭证。",
            );
        }
        Err(detail) => {
            return Sv2ProfileIdentityView::new(Sv2IdentityStatus::Unknown, detail);
        }
    }

    let session_path = license_root.join("session");
    let session_metadata = match safe_metadata(&session_path, "license/session") {
        Ok(Some(metadata)) if metadata.is_file() => metadata,
        Ok(Some(_)) => {
            return Sv2ProfileIdentityView::new(
                Sv2IdentityStatus::Unknown,
                "license/session 不是普通文件，已拒绝探测。",
            );
        }
        Ok(None) => {
            return Sv2ProfileIdentityView::new(
                Sv2IdentityStatus::SignedOut,
                "未检测到 license/session 登录凭证。",
            );
        }
        Err(detail) => {
            return Sv2ProfileIdentityView::new(Sv2IdentityStatus::Unknown, detail);
        }
    };

    if session_metadata.len() == 0 {
        return Sv2ProfileIdentityView::new(
            Sv2IdentityStatus::Unknown,
            "检测到空的 license/session 文件，无法确认登录状态。",
        );
    }
    if session_metadata.len() > MAX_SESSION_FILE_BYTES {
        return Sv2ProfileIdentityView::new(
            Sv2IdentityStatus::Unknown,
            "license/session 超出安全探测大小限制，已拒绝读取。",
        );
    }

    Sv2ProfileIdentityView::new(
        Sv2IdentityStatus::CredentialDetected,
        "检测到登录凭证但身份字段不可安全读取；当前 session 格式不透明，工具箱不会解析或输出原始凭证。",
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
    fn missing_session_is_reported_as_signed_out() {
        let root = fixture();
        fs::create_dir_all(root.join("license")).unwrap();

        let identity = probe_sv2_identity(&root);

        assert_eq!(identity.status, Sv2IdentityStatus::SignedOut);
        assert_eq!(identity.username, None);
        assert_eq!(identity.email, None);
        assert!(!identity.checked_at_utc.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opaque_session_only_reports_credential_presence() {
        let root = fixture();
        fs::create_dir_all(root.join("license")).unwrap();
        let secret = "producer@example.com:do-not-expose";
        fs::write(root.join("license/session"), secret).unwrap();

        let identity = probe_sv2_identity(&root);

        assert_eq!(identity.status, Sv2IdentityStatus::CredentialDetected);
        assert_eq!(identity.username, None);
        assert_eq!(identity.email, None);
        assert!(identity.detail.contains("身份字段不可安全读取"));
        assert!(!identity.detail.contains(secret));
        assert!(!identity.detail.contains("producer@example.com"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn oversized_session_is_not_treated_as_a_credential() {
        let root = fixture();
        fs::create_dir_all(root.join("license")).unwrap();
        let session = fs::File::create(root.join("license/session")).unwrap();
        session.set_len(MAX_SESSION_FILE_BYTES + 1).unwrap();

        let identity = probe_sv2_identity(&root);

        assert_eq!(identity.status, Sv2IdentityStatus::Unknown);
        assert!(identity.detail.contains("大小限制"));
        fs::remove_dir_all(root).unwrap();
    }
}
