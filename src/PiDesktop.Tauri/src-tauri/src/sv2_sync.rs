//! Selective, session-safe synchronization between SV2 slot data roots.
//!
//! This module deliberately knows nothing about account/session storage. Callers
//! resolve slot IDs to trusted slot roots, then pass those roots to `dry_run` and
//! `execute`. Only the allow-listed category roots below can ever be visited.

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const MANIFEST_VERSION: u32 = 1;
const BUFFER_SIZE: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Sv2SyncCategoryId {
    UserDictionaries,
    Scripts,
    Presets,
    SafeSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2SyncCategory {
    pub id: Sv2SyncCategoryId,
    pub label: &'static str,
    pub description: &'static str,
    pub relative_roots: &'static [&'static str],
}

pub fn categories() -> Vec<Sv2SyncCategory> {
    vec![
        Sv2SyncCategory {
            id: Sv2SyncCategoryId::UserDictionaries,
            label: "用户词典",
            description: "仅同步用户词典文件；不包含账号或登录数据。",
            relative_roots: &["dicts"],
        },
        Sv2SyncCategory {
            id: Sv2SyncCategoryId::Scripts,
            label: "脚本",
            description: "同步用户安装或编写的脚本。",
            relative_roots: &["scripts"],
        },
        Sv2SyncCategory {
            id: Sv2SyncCategoryId::Presets,
            label: "预设",
            description: "同步用户预设子目录。",
            relative_roots: &["presets"],
        },
        Sv2SyncCategory {
            id: Sv2SyncCategoryId::SafeSettings,
            label: "安全设置",
            description: "同步 SV2 设置文件和明确允许的界面设置；不包含登录态或声库。",
            relative_roots: &[
                "settings/settings.xml",
                "settings/shortcuts",
                "settings/theme",
                "settings/ui",
            ],
        },
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Sv2SyncAction {
    Copy,
    Update,
    Conflict,
    Skip,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2SyncEntry {
    pub category: Sv2SyncCategoryId,
    pub relative_path: String,
    pub action: Sv2SyncAction,
    pub source_size: u64,
    pub source_sha256: String,
    pub target_size: Option<u64>,
    pub target_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2SyncManifest {
    pub version: u32,
    pub overwrite: bool,
    /// Non-reversible binding to the exact source and target roots used for preview.
    pub root_scope: String,
    pub entries: Vec<Sv2SyncEntry>,
    /// Digest of the complete preview. Required by `execute`.
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2SyncResult {
    pub copied: u32,
    pub updated: u32,
    pub skipped: u32,
    pub conflicts: u32,
}

pub fn dry_run(
    source_root: &Path,
    target_root: &Path,
    selected: &[Sv2SyncCategoryId],
    overwrite: bool,
) -> Result<Sv2SyncManifest, String> {
    validate_root(source_root, true)?;
    validate_root(target_root, false)?;
    ensure_distinct_roots(source_root, target_root)?;
    let selected = selected.iter().copied().collect::<BTreeSet<_>>();
    if selected.is_empty() {
        return Err("至少选择一个允许同步的资源类别。".to_string());
    }
    let known = categories();
    let mut entries = Vec::new();
    for category in known
        .iter()
        .filter(|category| selected.contains(&category.id))
    {
        for relative_root in category.relative_roots {
            let relative_root = safe_relative(Path::new(relative_root))?;
            let source = source_root.join(&relative_root);
            if !source.exists() {
                continue;
            }
            walk_files(&source, &relative_root, &mut |path, relative| {
                let source_info = file_info(path)?;
                let target = checked_join(target_root, relative)?;
                let target_info = if target.exists() {
                    Some(file_info(&target)?)
                } else {
                    None
                };
                let action = match &target_info {
                    None => Sv2SyncAction::Copy,
                    Some(info) if *info == source_info => Sv2SyncAction::Skip,
                    Some(_) if overwrite => Sv2SyncAction::Update,
                    Some(_) => Sv2SyncAction::Conflict,
                };
                entries.push(Sv2SyncEntry {
                    category: category.id,
                    relative_path: portable_relative(relative)?,
                    action,
                    source_size: source_info.0,
                    source_sha256: source_info.1,
                    target_size: target_info.as_ref().map(|info| info.0),
                    target_sha256: target_info.map(|info| info.1),
                });
                Ok(())
            })?;
        }
    }
    entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    let mut manifest = Sv2SyncManifest {
        version: MANIFEST_VERSION,
        overwrite,
        root_scope: root_scope(source_root, target_root)?,
        entries,
        token: String::new(),
    };
    manifest.token = manifest_token(&manifest)?;
    Ok(manifest)
}

pub fn execute(
    source_root: &Path,
    target_root: &Path,
    selected: &[Sv2SyncCategoryId],
    approved: &Sv2SyncManifest,
    token: &str,
) -> Result<Sv2SyncResult, String> {
    if token.is_empty() || token != approved.token || manifest_token(approved)? != token {
        return Err("同步清单令牌无效；请重新预览。".into());
    }
    let current = dry_run(source_root, target_root, selected, approved.overwrite)?;
    if current.token != token || current.entries != approved.entries {
        return Err("同步内容在预览后发生变化；请重新预览。".into());
    }
    let mut result = Sv2SyncResult {
        copied: 0,
        updated: 0,
        skipped: 0,
        conflicts: 0,
    };
    for entry in &current.entries {
        let relative = safe_relative(Path::new(&entry.relative_path))?;
        let source = checked_join(source_root, &relative)?;
        let target = checked_join(target_root, &relative)?;
        match entry.action {
            Sv2SyncAction::Copy => {
                copy_verified(&source, &target, false, &entry.source_sha256)?;
                result.copied += 1;
            }
            Sv2SyncAction::Update => {
                copy_verified(&source, &target, true, &entry.source_sha256)?;
                result.updated += 1;
            }
            Sv2SyncAction::Skip => result.skipped += 1,
            Sv2SyncAction::Conflict => result.conflicts += 1,
        }
    }
    Ok(result)
}

fn manifest_token(manifest: &Sv2SyncManifest) -> Result<String, String> {
    #[derive(Serialize)]
    struct Signed<'a> {
        version: u32,
        overwrite: bool,
        root_scope: &'a str,
        entries: &'a [Sv2SyncEntry],
    }
    let bytes = serde_json::to_vec(&Signed {
        version: manifest.version,
        overwrite: manifest.overwrite,
        root_scope: &manifest.root_scope,
        entries: &manifest.entries,
    })
    .map_err(|error| format!("无法签署同步清单：{error}"))?;
    Ok(hex_digest(Sha256::digest(bytes)))
}

fn root_scope(source_root: &Path, target_root: &Path) -> Result<String, String> {
    let source = canonical_scope_path(source_root)?;
    let target = canonical_scope_path(target_root)?;
    let mut digest = Sha256::new();
    digest.update(source.to_string_lossy().as_bytes());
    digest.update([0]);
    digest.update(target.to_string_lossy().as_bytes());
    Ok(hex_digest(digest.finalize()))
}

fn canonical_scope_path(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return fs::canonicalize(path)
            .map_err(|error| format!("无法解析同步槽位路径 {}：{error}", path.display()));
    }
    let parent = path
        .parent()
        .ok_or_else(|| "同步槽位路径缺少父目录。".to_string())?;
    let name = path
        .file_name()
        .ok_or_else(|| "同步槽位路径缺少目录名。".to_string())?;
    Ok(fs::canonicalize(parent)
        .map_err(|error| format!("无法解析同步槽位父目录 {}：{error}", parent.display()))?
        .join(name))
}

fn walk_files<F>(directory: &Path, relative: &Path, visit: &mut F) -> Result<(), String>
where
    F: FnMut(&Path, &Path) -> Result<(), String>,
{
    reject_link(directory)?;
    if !directory.is_dir() {
        return Err(format!("同步类别路径不是目录：{}", directory.display()));
    }
    let mut children = fs::read_dir(directory)
        .map_err(|e| format!("无法枚举 {}：{e}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("无法读取目录项：{e}"))?;
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        let path = child.path();
        let child_relative = relative.join(child.file_name());
        let metadata =
            fs::symlink_metadata(&path).map_err(|e| format!("无法检查 {}：{e}", path.display()))?;
        reject_link_metadata(&path, &metadata)?;
        if is_forbidden(&child_relative) {
            continue;
        }
        if metadata.is_dir() {
            walk_files(&path, &child_relative, visit)?;
        } else if metadata.is_file() {
            visit(&path, &child_relative)?;
        } else {
            return Err(format!("不支持的同步目录项：{}", path.display()));
        }
    }
    Ok(())
}

fn is_forbidden(path: &Path) -> bool {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(v) => v.to_str(),
            _ => None,
        })
        .any(|v| {
            matches!(
                v.to_ascii_lowercase().as_str(),
                "license"
                    | "webview2"
                    | "session"
                    | "sessions"
                    | "database"
                    | "databases"
                    | "cookies"
            )
        })
}

fn validate_root(root: &Path, must_exist: bool) -> Result<(), String> {
    if !root.is_absolute() {
        return Err("槽位根目录必须是绝对路径。".into());
    }
    if must_exist && !root.is_dir() {
        return Err(format!("源槽位不存在：{}", root.display()));
    }
    if root.exists() {
        reject_link(root)?;
        if !root.is_dir() {
            return Err("槽位根路径不是目录。".into());
        }
    }
    Ok(())
}

fn ensure_distinct_roots(source: &Path, target: &Path) -> Result<(), String> {
    let source = fs::canonicalize(source).map_err(|e| format!("无法解析源槽位：{e}"))?;
    let target = if target.exists() {
        fs::canonicalize(target).map_err(|e| format!("无法解析目标槽位：{e}"))?
    } else {
        target.to_path_buf()
    };
    if source == target || source.starts_with(&target) || target.starts_with(&source) {
        return Err("源槽位和目标槽位必须是互不包含的独立目录。".into());
    }
    Ok(())
}

fn safe_relative(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err("同步相对路径无效。".into());
    }
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => result.push(value),
            _ => return Err("同步路径包含目录穿越。".into()),
        }
    }
    if is_forbidden(&result) {
        return Err("同步路径涉及受保护的登录态或数据库目录。".into());
    }
    Ok(result)
}

fn checked_join(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let relative = safe_relative(relative)?;
    let joined = root.join(&relative);
    let mut cursor = root.to_path_buf();
    for part in relative.components() {
        if let Component::Normal(value) = part {
            cursor.push(value);
            if cursor.exists() {
                reject_link(&cursor)?;
            }
        }
    }
    Ok(joined)
}

fn portable_relative(path: &Path) -> Result<String, String> {
    Ok(safe_relative(path)?
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn file_info(path: &Path) -> Result<(u64, String), String> {
    reject_link(path)?;
    let mut file = File::open(path).map_err(|e| format!("无法读取 {}：{e}", path.display()))?;
    let size = file
        .metadata()
        .map_err(|e| format!("无法检查文件：{e}"))?
        .len();
    let mut digest = Sha256::new();
    let mut buffer = vec![0; BUFFER_SIZE];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|e| format!("无法哈希 {}：{e}", path.display()))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok((size, hex_digest(digest.finalize())))
}

fn copy_verified(
    source: &Path,
    target: &Path,
    overwrite: bool,
    expected_hash: &str,
) -> Result<(), String> {
    reject_link(source)?;
    if target.exists() {
        reject_link(target)?;
        if !overwrite {
            return Err(format!("目标文件已存在：{}", target.display()));
        }
    }
    let parent = target
        .parent()
        .ok_or_else(|| "目标文件缺少父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("无法创建同步目录：{e}"))?;
    checked_join(
        parent,
        Path::new(
            target
                .file_name()
                .ok_or_else(|| "目标文件名无效。".to_string())?,
        ),
    )?;
    let temporary = parent.join(format!(".sv2-sync-{}.tmp", Uuid::new_v4()));
    let outcome = (|| {
        let mut input = File::open(source).map_err(|e| format!("无法打开同步源：{e}"))?;
        let mut output =
            File::create_new(&temporary).map_err(|e| format!("无法创建同步临时文件：{e}"))?;
        std::io::copy(&mut input, &mut output).map_err(|e| format!("无法复制同步文件：{e}"))?;
        output
            .flush()
            .map_err(|e| format!("无法刷新同步文件：{e}"))?;
        output
            .sync_all()
            .map_err(|e| format!("无法落盘同步文件：{e}"))?;
        if file_info(&temporary)?.1 != expected_hash {
            return Err("同步临时文件哈希校验失败。".into());
        }
        if target.exists() {
            let backup = parent.join(format!(".sv2-sync-{}.backup", Uuid::new_v4()));
            fs::rename(target, &backup).map_err(|e| format!("无法暂存原目标文件：{e}"))?;
            if let Err(error) = fs::rename(&temporary, target) {
                let _ = fs::rename(&backup, target);
                return Err(format!("无法提交同步文件：{error}"));
            }
            fs::remove_file(&backup).map_err(|e| format!("同步完成但无法清理备份文件：{e}"))?;
            Ok(())
        } else {
            fs::rename(&temporary, target).map_err(|e| format!("无法提交同步文件：{e}"))
        }
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    outcome
}

fn reject_link(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|e| format!("无法检查 {}：{e}", path.display()))?;
    reject_link_metadata(path, &metadata)
}

fn reject_link_metadata(path: &Path, metadata: &fs::Metadata) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(format!("拒绝访问 reparse point：{}", path.display()));
        }
    }
    #[cfg(not(windows))]
    if metadata.file_type().is_symlink() {
        return Err(format!("拒绝访问符号链接：{}", path.display()));
    }
    Ok(())
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots() -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("sv2-sync-test-{}", Uuid::new_v4()));
        let source = base.join("source");
        let target = base.join("target");
        fs::create_dir_all(source.join("dicts")).unwrap();
        fs::create_dir_all(&target).unwrap();
        (base, source, target)
    }

    #[test]
    fn preview_and_execute_copy_only_allowlisted_content() {
        let (base, source, target) = roots();
        fs::write(source.join("dicts/user.json"), b"hello").unwrap();
        fs::create_dir_all(source.join("license")).unwrap();
        fs::write(source.join("license/token"), b"secret").unwrap();
        let selected = [Sv2SyncCategoryId::UserDictionaries];
        let preview = dry_run(&source, &target, &selected, false).unwrap();
        assert_eq!(preview.entries.len(), 1);
        assert_eq!(preview.entries[0].action, Sv2SyncAction::Copy);
        let result = execute(&source, &target, &selected, &preview, &preview.token).unwrap();
        assert_eq!(result.copied, 1);
        assert!(!target.join("license/token").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn differing_target_is_conflict_unless_overwrite_was_previewed() {
        let (base, source, target) = roots();
        fs::write(source.join("dicts/a"), b"new").unwrap();
        fs::create_dir_all(target.join("dicts")).unwrap();
        fs::write(target.join("dicts/a"), b"old").unwrap();
        let selected = [Sv2SyncCategoryId::UserDictionaries];
        assert_eq!(
            dry_run(&source, &target, &selected, false).unwrap().entries[0].action,
            Sv2SyncAction::Conflict
        );
        assert_eq!(
            dry_run(&source, &target, &selected, true).unwrap().entries[0].action,
            Sv2SyncAction::Update
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn stale_or_tampered_manifest_is_rejected() {
        let (base, source, target) = roots();
        fs::write(source.join("dicts/a"), b"one").unwrap();
        let selected = [Sv2SyncCategoryId::UserDictionaries];
        let preview = dry_run(&source, &target, &selected, false).unwrap();
        fs::write(source.join("dicts/a"), b"two").unwrap();
        assert!(execute(&source, &target, &selected, &preview, &preview.token).is_err());
        assert!(execute(&source, &target, &selected, &preview, "bad").is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn manifest_is_bound_to_the_previewed_slot_pair() {
        let (base, source, target) = roots();
        let alternate_target = base.join("alternate-target");
        fs::create_dir_all(&alternate_target).unwrap();
        fs::write(source.join("dicts/a"), b"one").unwrap();
        let selected = [Sv2SyncCategoryId::UserDictionaries];
        let preview = dry_run(&source, &target, &selected, false).unwrap();
        assert!(execute(
            &source,
            &alternate_target,
            &selected,
            &preview,
            &preview.token
        )
        .is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn traversal_and_protected_names_are_rejected() {
        assert!(safe_relative(Path::new("../license")).is_err());
        assert!(safe_relative(Path::new("settings/session/cache")).is_err());
        assert!(safe_relative(Path::new("dicts/good.json")).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_in_category_is_rejected() {
        use std::os::unix::fs::symlink;
        let (base, source, target) = roots();
        symlink(&target, source.join("dicts/link")).unwrap();
        assert!(dry_run(
            &source,
            &target,
            &[Sv2SyncCategoryId::UserDictionaries],
            false
        )
        .is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn directory_junction_in_category_is_rejected() {
        use std::os::windows::fs::symlink_dir;
        let (base, source, target) = roots();
        if symlink_dir(&target, source.join("dicts/link")).is_ok() {
            assert!(dry_run(
                &source,
                &target,
                &[Sv2SyncCategoryId::UserDictionaries],
                false
            )
            .is_err());
        }
        fs::remove_dir_all(base).unwrap();
    }
}
