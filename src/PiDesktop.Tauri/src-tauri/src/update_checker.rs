use std::process::Command;
use std::time::Duration;

use chrono::Utc;
use semver::Version;
use serde::{Deserialize, Serialize};

const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/SynthVCopilot/synthv-toolbox/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/SynthVCopilot/synthv-toolbox/releases/latest";
const OFFICIAL_RELEASE_PREFIX: &str =
    "https://github.com/SynthVCopilot/synthv-toolbox/releases/tag/";
const MAX_RELEASE_NOTES_CHARS: usize = 12_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxUpdateCheck {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_name: String,
    pub release_url: String,
    pub published_at_utc: Option<String>,
    pub release_notes: String,
    pub checked_at_utc: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    published_at: Option<String>,
    body: Option<String>,
}

pub fn check_for_update(current_version: &str) -> Result<ToolboxUpdateCheck, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(12))
        .build();
    let response = agent
        .get(LATEST_RELEASE_API)
        .set("Accept", "application/vnd.github+json")
        .set(
            "User-Agent",
            concat!("SynthV-Toolbox/", env!("CARGO_PKG_VERSION")),
        )
        .call()
        .map_err(describe_request_error)?;
    let release = response
        .into_json::<GitHubRelease>()
        .map_err(|error| format!("无法解析 GitHub 发布信息：{error}"))?;
    build_update_check(current_version, release)
}

pub fn open_releases_page() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command
        .arg(RELEASES_PAGE)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开官方发布页：{error}"))
}

fn build_update_check(
    current_version: &str,
    release: GitHubRelease,
) -> Result<ToolboxUpdateCheck, String> {
    let current = parse_version(current_version, "当前应用版本")?;
    let latest = parse_version(&release.tag_name, "最新发布版本")?;
    if !is_official_release_url(&release.html_url) {
        return Err("GitHub 返回了非官方发布地址，已拒绝显示。".to_string());
    }
    let release_name = release
        .name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("SynthV Toolbox v{latest}"));
    let release_notes = truncate_notes(release.body.as_deref().unwrap_or(""));

    Ok(ToolboxUpdateCheck {
        current_version: current.to_string(),
        latest_version: latest.to_string(),
        update_available: latest > current,
        release_name,
        release_url: release.html_url,
        published_at_utc: release.published_at,
        release_notes,
        checked_at_utc: Utc::now().to_rfc3339(),
    })
}

fn parse_version(value: &str, label: &str) -> Result<Version, String> {
    Version::parse(value.trim().trim_start_matches(['v', 'V']))
        .map_err(|error| format!("{label}“{value}”不是有效的语义化版本：{error}"))
}

fn is_official_release_url(value: &str) -> bool {
    value.starts_with(OFFICIAL_RELEASE_PREFIX) && !value[OFFICIAL_RELEASE_PREFIX.len()..].is_empty()
}

fn truncate_notes(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= MAX_RELEASE_NOTES_CHARS {
        return trimmed.to_string();
    }
    trimmed
        .chars()
        .take(MAX_RELEASE_NOTES_CHARS)
        .collect::<String>()
        + "…"
}

fn describe_request_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(403, _) => {
            "GitHub 暂时拒绝了更新检查（可能达到匿名请求频率限制），请稍后重试。".to_string()
        }
        ureq::Error::Status(404, _) => "尚未找到公开的稳定版发布。".to_string(),
        ureq::Error::Status(code, _) => format!("GitHub 更新服务返回 HTTP {code}。"),
        ureq::Error::Transport(error) => format!("无法连接 GitHub 更新服务：{error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag_name: &str, html_url: &str) -> GitHubRelease {
        GitHubRelease {
            tag_name: tag_name.to_string(),
            name: None,
            html_url: html_url.to_string(),
            published_at: Some("2026-08-29T12:00:00Z".to_string()),
            body: Some("修复与改进".to_string()),
        }
    }

    #[test]
    fn detects_newer_stable_release() {
        let result = build_update_check(
            "0.1.1",
            release(
                "v0.2.0",
                "https://github.com/SynthVCopilot/synthv-toolbox/releases/tag/v0.2.0",
            ),
        )
        .expect("valid release");
        assert!(result.update_available);
        assert_eq!(result.current_version, "0.1.1");
        assert_eq!(result.latest_version, "0.2.0");
    }

    #[test]
    fn does_not_downgrade_a_newer_local_build() {
        let result = build_update_check(
            "1.0.0",
            release(
                "v0.9.9",
                "https://github.com/SynthVCopilot/synthv-toolbox/releases/tag/v0.9.9",
            ),
        )
        .expect("valid release");
        assert!(!result.update_available);
    }

    #[test]
    fn semantic_version_comparison_handles_prereleases() {
        let result = build_update_check(
            "1.0.0-beta.1",
            release(
                "v1.0.0",
                "https://github.com/SynthVCopilot/synthv-toolbox/releases/tag/v1.0.0",
            ),
        )
        .expect("valid release");
        assert!(result.update_available);
    }

    #[test]
    fn rejects_untrusted_release_url() {
        let result = build_update_check(
            "0.1.1",
            release("v0.2.0", "https://example.com/releases/tag/v0.2.0"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn truncates_oversized_release_notes() {
        let notes = "更".repeat(MAX_RELEASE_NOTES_CHARS + 10);
        let truncated = truncate_notes(&notes);
        assert_eq!(truncated.chars().count(), MAX_RELEASE_NOTES_CHARS + 1);
        assert!(truncated.ends_with('…'));
    }
}
