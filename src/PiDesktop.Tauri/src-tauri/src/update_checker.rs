use std::process::Command;
use std::time::Duration;

use chrono::{DateTime, Utc};
use semver::Version;
use serde::{Deserialize, Serialize};

use crate::config::UpdateChannel;

const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/SynthVCopilot/synthv-toolbox/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/SynthVCopilot/synthv-toolbox/releases/latest";
const PROJECT_PAGE: &str = "https://github.com/SynthVCopilot/synthv-toolbox";
const RELEASES_TAG_PREFIX: &str = "https://github.com/SynthVCopilot/synthv-toolbox/releases/tag/";
const NIGHTLY_DOWNLOAD_PREFIX: &str =
    "https://github.com/SynthVCopilot/synthv-toolbox/releases/download/";
const MAX_RELEASE_NOTES_CHARS: usize = 12_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxUpdateCheck {
    pub channel: UpdateChannel,
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_name: String,
    pub release_url: String,
    pub published_at_utc: Option<String>,
    pub release_notes: String,
    pub checked_at_utc: String,
    pub installer: Option<ToolboxUpdateAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxUpdateAsset {
    pub name: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    published_at: Option<String>,
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}
#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NightlyManifest {
    schema_version: u32,
    channel: String,
    version: String,
    commit: String,
    source_committed_at_utc: String,
    published_at_utc: String,
    release_url: String,
    changes: Vec<NightlyChange>,
    #[serde(default)]
    assets: Vec<ToolboxUpdateAsset>,
}

#[derive(Debug, Deserialize)]
struct NightlyIndex {
    schema_version: u32,
    channel: String,
    latest: String,
    builds: Vec<NightlyManifest>,
}

#[derive(Debug, Deserialize)]
struct GitHubReleaseSummary {
    tag_name: String,
    prerelease: bool,
    draft: bool,
}

#[derive(Debug, Deserialize)]
struct NightlyChange {
    title: String,
    commit: String,
}

pub fn check_for_update(
    current_version: &str,
    channel: UpdateChannel,
) -> Result<ToolboxUpdateCheck, String> {
    match channel {
        UpdateChannel::Stable => check_stable_update(current_version),
        UpdateChannel::Nightly => check_nightly_update(current_version),
    }
}

pub fn open_releases_page(url: Option<&str>) -> Result<(), String> {
    let url = url.unwrap_or(RELEASES_PAGE);
    if !is_official_release_url(url) && !url.starts_with(PROJECT_PAGE) && url != RELEASES_PAGE {
        return Err("发布地址不是官方 GitHub Releases 地址。".to_string());
    }
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = Command::new("xdg-open");
    command
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开官方发布页：{error}"))
}

pub fn open_project_page(target: &str) -> Result<(), String> {
    let url = match target { "project" => PROJECT_PAGE, "issues" => "https://github.com/SynthVCopilot/synthv-toolbox/issues", "guide" => "https://github.com/SynthVCopilot/synthv-toolbox/blob/main/docs/lyric-and-audio-workflow-guide.zh-CN.md", _ => return Err("未知的官方页面。".to_string()) };
    open_releases_page(Some(url))
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(12))
        .build()
}

fn check_stable_update(current_version: &str) -> Result<ToolboxUpdateCheck, String> {
    let response = agent()
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
    build_stable_update_check(current_version, release)
}

fn check_nightly_update(current_version: &str) -> Result<ToolboxUpdateCheck, String> {
    let releases = agent()
        .get("https://api.github.com/repos/SynthVCopilot/synthv-toolbox/releases?per_page=100")
        .set("Accept", "application/vnd.github+json")
        .set(
            "User-Agent",
            concat!("SynthV-Toolbox/", env!("CARGO_PKG_VERSION")),
        )
        .call()
        .map_err(describe_nightly_request_error)?
        .into_json::<Vec<GitHubReleaseSummary>>()
        .map_err(|error| format!("无法解析 nightly 发布列表：{error}"))?;
    let tag = latest_nightly_tag(releases)?;
    let response = agent()
        .get(&format!("{NIGHTLY_DOWNLOAD_PREFIX}{tag}/versions.json"))
        .set("Accept", "application/json")
        .set(
            "User-Agent",
            concat!("SynthV-Toolbox/", env!("CARGO_PKG_VERSION")),
        )
        .call()
        .map_err(describe_nightly_request_error)?;
    let index = response
        .into_json::<NightlyIndex>()
        .map_err(|error| format!("无法解析 nightly 更新索引：{error}"))?;
    let manifest = select_latest_nightly_build(index)?;
    if manifest.release_url != format!("{RELEASES_TAG_PREFIX}{tag}") {
        return Err("nightly 清单与发布标签不一致。".to_string());
    }
    build_nightly_update_check(current_version, manifest)
}

fn select_latest_nightly_build(index: NightlyIndex) -> Result<NightlyManifest, String> {
    if index.schema_version != 1 || index.channel != "nightly" {
        return Err("nightly 更新索引版本或渠道无效。".to_string());
    }
    if index.latest.len() != 7 || !index.latest.chars().all(|value| value.is_ascii_hexdigit()) {
        return Err("nightly 更新索引的 latest 提交标识无效。".to_string());
    }
    let mut matches = index
        .builds
        .into_iter()
        .filter(|build| build.commit == index.latest);
    let build = matches
        .next()
        .ok_or_else(|| "nightly 更新索引的 latest 未指向构建记录。".to_string())?;
    if matches.next().is_some() {
        return Err("nightly 更新索引的 latest 指向了重复构建记录。".to_string());
    }
    Ok(build)
}

fn latest_nightly_tag(releases: Vec<GitHubReleaseSummary>) -> Result<String, String> {
    releases
        .into_iter()
        .filter(|release| release.prerelease && !release.draft)
        .filter_map(|release| {
            let base = release
                .tag_name
                .strip_prefix('v')?
                .strip_suffix("-nightly")?;
            Some((
                parse_version(base, "nightly 发布版本").ok()?,
                release.tag_name,
            ))
        })
        .max_by(|left, right| left.0.cmp(&right.0))
        .map(|(_, tag)| tag)
        .ok_or_else(|| "尚未找到公开的 nightly 发布。".to_string())
}

fn build_stable_update_check(
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
        .unwrap_or_else(|| format!("Synthesizer V Toolbox v{latest}"));
    let installer = select_installer(
        release
            .assets
            .into_iter()
            .filter_map(|asset| {
                let sha256 = asset.digest?.strip_prefix("sha256:")?.to_string();
                Some(ToolboxUpdateAsset {
                    name: asset.name,
                    url: asset.browser_download_url,
                    sha256,
                    size: asset.size,
                })
            })
            .collect(),
    );
    Ok(ToolboxUpdateCheck {
        channel: UpdateChannel::Stable,
        current_version: current.to_string(),
        latest_version: latest.to_string(),
        update_available: latest > current,
        release_name,
        release_url: release.html_url,
        published_at_utc: release.published_at,
        release_notes: truncate_notes(release.body.as_deref().unwrap_or("")),
        checked_at_utc: Utc::now().to_rfc3339(),
        installer,
    })
}

fn build_nightly_update_check(
    current_version: &str,
    manifest: NightlyManifest,
) -> Result<ToolboxUpdateCheck, String> {
    if manifest.schema_version != 1 || manifest.channel != "nightly" {
        return Err("nightly 更新清单版本或渠道无效。".to_string());
    }
    if manifest.commit.len() != 7
        || !manifest
            .commit
            .chars()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err("nightly 更新清单的提交标识无效。".to_string());
    }
    if !is_official_release_url(&manifest.release_url) {
        return Err("nightly 更新清单包含非官方发布地址，已拒绝显示。".to_string());
    }
    let latest = nightly_version(&manifest.version, "nightly 最新版本")?;
    if manifest.release_url != format!("{RELEASES_TAG_PREFIX}v{}-nightly", latest.base) {
        return Err("nightly 清单的版本与发布地址不一致。".to_string());
    }
    if !manifest
        .version
        .trim()
        .ends_with(&format!("-dev.{}", manifest.commit))
    {
        return Err("nightly 更新清单的版本与提交标识不一致。".to_string());
    }
    let current = nightly_version(current_version, "当前应用版本").ok();
    let source_committed_at = DateTime::parse_from_rfc3339(&manifest.source_committed_at_utc)
        .map_err(|error| format!("nightly 更新清单的提交时间无效：{error}"))?
        .with_timezone(&Utc);
    let update_available = if manifest.version == current_version.trim() {
        false
    } else if let Some(current) = current {
        if latest.base != current.base {
            latest.base > current.base
        } else {
            source_committed_at > current.published_at
        }
    } else {
        latest.base >= parse_version(current_version, "当前应用版本")?
    };
    let notes = manifest
        .changes
        .into_iter()
        .map(|change| format!("- {} (#{})", change.title.trim(), change.commit.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    let installer = select_installer(manifest.assets.clone());
    Ok(ToolboxUpdateCheck {
        channel: UpdateChannel::Nightly,
        current_version: current_version.trim().to_string(),
        latest_version: manifest.version,
        update_available,
        release_name: format!("Synthesizer V Toolbox nightly {}", manifest.commit),
        release_url: manifest.release_url,
        published_at_utc: Some(manifest.published_at_utc),
        release_notes: truncate_notes(&notes),
        checked_at_utc: Utc::now().to_rfc3339(),
        installer,
    })
}

fn select_installer(assets: Vec<ToolboxUpdateAsset>) -> Option<ToolboxUpdateAsset> {
    let extension = if cfg!(windows) {
        ".exe"
    } else if cfg!(target_os = "macos") {
        ".dmg"
    } else {
        return None;
    };
    assets.into_iter().find(|asset| {
        asset.name.ends_with(extension)
            && asset.size > 0
            && asset.size <= 4 * 1024 * 1024 * 1024
            && asset.sha256.len() == 64
            && asset.sha256.chars().all(|value| value.is_ascii_hexdigit())
            && asset.url.starts_with(NIGHTLY_DOWNLOAD_PREFIX)
    })
}

struct ParsedNightlyVersion {
    base: Version,
    published_at: DateTime<Utc>,
}

fn nightly_version(value: &str, label: &str) -> Result<ParsedNightlyVersion, String> {
    let value = value.trim().trim_start_matches(['v', 'V']);
    let (base, commit) = value
        .rsplit_once("-dev.")
        .ok_or_else(|| format!("{label}“{value}”不是有效的 nightly 版本。"))?;
    if commit.len() != 7 || !commit.chars().all(|value| value.is_ascii_hexdigit()) {
        return Err(format!("{label}“{value}”没有有效的短提交标识。"));
    }
    let published_at = option_env!("SYNTHV_TOOLBOX_SOURCE_COMMITTED_AT_UTC")
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
        .ok_or_else(|| format!("{label}缺少可比较的提交时间。"))?;
    Ok(ParsedNightlyVersion {
        base: parse_version(base, label)?,
        published_at,
    })
}

fn parse_version(value: &str, label: &str) -> Result<Version, String> {
    Version::parse(value.trim().trim_start_matches(['v', 'V']))
        .map_err(|error| format!("{label}“{value}”不是有效的语义化版本：{error}"))
}
fn is_official_release_url(value: &str) -> bool {
    value.starts_with(RELEASES_TAG_PREFIX) && !value[RELEASES_TAG_PREFIX.len()..].is_empty()
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
fn describe_nightly_request_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(404, _) => "尚未找到公开的 nightly 发布。".to_string(),
        other => describe_request_error(other),
    }
}

#[cfg(test)]
#[path = "../../../../test/update_checker.rs"]
mod tests;
