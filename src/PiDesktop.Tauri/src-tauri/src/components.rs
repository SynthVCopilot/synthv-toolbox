use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::agent::{data_root, default_catalog, ComponentSpec};
use crate::config::{model_config_mutation_guard, model_config_path};
use crate::sv2_concurrent::detect_provider as detect_sandboxie;
use crate::synthv::{failed, quiet_command, succeeded, OperationResult};

const SANDBOXIE_VERSION: &str = "1.18.2";
const SANDBOXIE_INSTALLER_NAME: &str = "Sandboxie-Plus-x64-v1.18.2.exe";
const SANDBOXIE_INSTALLER_URL: &str =
    "https://github.com/sandboxie-plus/Sandboxie/releases/download/v1.18.2/Sandboxie-Plus-x64-v1.18.2.exe";
const SANDBOXIE_INSTALLER_SHA256: &str =
    "1c19832c8bb84f5dcde1bf59b7f38b7cfe94989c09dd0acd0b7ce7485dde8987";
const FFMPEG_VERSION: &str = "n8.1.2-50-g1a748fe2cd";
const FFMPEG_RELEASE_TAG: &str = "autobuild-2026-08-29-13-12";
const FFMPEG_ARCHIVE_NAME: &str = "ffmpeg-n8.1.2-50-g1a748fe2cd-win64-lgpl-8.1.zip";
const FFMPEG_ARCHIVE_URL: &str = "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-29-13-12/ffmpeg-n8.1.2-50-g1a748fe2cd-win64-lgpl-8.1.zip";
const FFMPEG_ARCHIVE_SHA256: &str =
    "e1cafe80e9fb3e4e4024923a2ed2544bc3a0545af09b6a7861a7193210988c63";
const FFMPEG_MANIFEST_NAME: &str = "manifest.json";
const FFMPEG_MANIFEST_SCHEMA: u32 = 1;
const FFMPEG_MANAGED_BY: &str = "SynthV Toolbox";
const FFMPEG_ARTIFACT_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_FFMPEG_ARTIFACTS_TO_SCAN: usize = 64;
const MAX_FFMPEG_DOWNLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_COMPONENT_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;
const MEDIA_FETCHER_VERSION: &str = "2026.08.19";
const MEDIA_FETCHER_MACOS_SHA256: &str =
    "0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202";
const MEDIA_FETCHER_WINDOWS_SHA256: &str =
    "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a";
struct ComponentActivity {
    mutating: AtomicBool,
    usage_count: AtomicUsize,
}

impl ComponentActivity {
    const fn new() -> Self {
        Self {
            mutating: AtomicBool::new(false),
            usage_count: AtomicUsize::new(0),
        }
    }
}

static COMPONENT_ACTIVITY: ComponentActivity = ComponentActivity::new();

pub(crate) struct ComponentUsageGuard {
    activity: &'static ComponentActivity,
}

impl Drop for ComponentUsageGuard {
    fn drop(&mut self) {
        let previous = self.activity.usage_count.fetch_sub(1, Ordering::SeqCst);
        debug_assert!(previous > 0, "component usage counter underflowed");
    }
}

struct ComponentMutationGuard {
    activity: &'static ComponentActivity,
}

impl Drop for ComponentMutationGuard {
    fn drop(&mut self) {
        self.activity.mutating.store(false, Ordering::SeqCst);
    }
}

pub(crate) fn component_usage_guard() -> Result<ComponentUsageGuard, String> {
    component_usage_guard_for(&COMPONENT_ACTIVITY)
}

fn component_usage_guard_for(
    activity: &'static ComponentActivity,
) -> Result<ComponentUsageGuard, String> {
    if activity.mutating.load(Ordering::SeqCst) {
        return Err("组件正在安装或删除；请等待当前组件操作完成后重试。".to_string());
    }
    activity.usage_count.fetch_add(1, Ordering::SeqCst);
    if activity.mutating.load(Ordering::SeqCst) {
        activity.usage_count.fetch_sub(1, Ordering::SeqCst);
        Err("组件正在安装或删除；请等待当前组件操作完成后重试。".to_string())
    } else {
        Ok(ComponentUsageGuard { activity })
    }
}

fn component_mutation_guard() -> ComponentMutationGuard {
    component_mutation_guard_for(&COMPONENT_ACTIVITY)
}

fn component_mutation_guard_for(activity: &'static ComponentActivity) -> ComponentMutationGuard {
    while activity
        .mutating
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        std::thread::yield_now();
    }
    while activity.usage_count.load(Ordering::SeqCst) != 0 {
        std::thread::sleep(Duration::from_millis(1));
    }
    ComponentMutationGuard { activity }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentInfo {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub audience: String,
    pub installed: bool,
    pub removable: bool,
    pub downloaded: bool,
    pub installable: bool,
    pub status: String,
}

pub fn component_list(resource_root: &Path) -> Vec<ComponentInfo> {
    let managed_data_root = data_root();
    let config_path = model_config_path();
    let mut components = default_catalog()
        .into_iter()
        .filter(|component| {
            matches!(
                component.id.as_str(),
                "ffmpeg" | "pi-audio" | "cvrs" | "media-fetcher" | "vocal-separation"
            )
        })
        .map(|component| {
            component_info_at(component, resource_root, &managed_data_root, &config_path)
        })
        .collect::<Vec<_>>();
    components.push(sandboxie_component_info());
    components
}

fn component_info_at(
    component: ComponentSpec,
    resource_root: &Path,
    managed_data_root: &Path,
    config_path: &Path,
) -> ComponentInfo {
    let installed = match component.id.as_str() {
        "ffmpeg" => resolve_ffmpeg_binary(resource_root, managed_data_root).is_some(),
        "pi-audio" => configured_component_at("audio", config_path),
        "cvrs" => configured_component_at("cvrs", config_path),
        "media-fetcher" => managed_media_fetcher_binary(managed_data_root).is_some(),
        "vocal-separation" => configured_component_at("separation", config_path),
        _ => false,
    };
    let id = component.id;
    let removable = if id == "ffmpeg" {
        toolbox_managed_ffmpeg_directory_exists(managed_data_root)
    } else {
        managed_component_paths(&id, managed_data_root)
            .ok()
            .is_some_and(|managed| {
                managed_component_directory_exists(&managed.target)
                    || config_references_managed_component(config_path, &managed)
            })
    };
    let installable = installed
        || matches!(
            id.as_str(),
            "pi-audio" | "cvrs" | "media-fetcher" | "vocal-separation"
        )
        || (id == "ffmpeg" && cfg!(all(windows, target_arch = "x86_64")));
    let is_ffmpeg = id == "ffmpeg";
    let is_media_fetcher = id == "media-fetcher";
    ComponentInfo {
        id,
        display_name: component.display_name,
        description: component.description,
        audience: match format!("{:?}", component.audience).as_str() {
            "Ai" => "AI".to_string(),
            "Human" => "人工".to_string(),
            _ => "AI 与人工".to_string(),
        },
        installed,
        removable,
        downloaded: (is_ffmpeg && ffmpeg_archive_cached(managed_data_root))
            || (is_media_fetcher && media_fetcher_cached(managed_data_root)),
        status: if installed {
            if is_ffmpeg {
                ffmpeg_status_label(resource_root, managed_data_root, "已就绪")
            } else if is_media_fetcher {
                format!("yt-dlp {MEDIA_FETCHER_VERSION} 已就绪")
            } else {
                "已就绪".to_string()
            }
        } else if installable {
            "可由 Toolbox 内置下载器下载".to_string()
        } else {
            "需要系统安装".to_string()
        },
        installable,
    }
}

pub fn install_component<F>(
    id: &str,
    components_dir: &Path,
    resource_root: &Path,
    mut progress: F,
) -> OperationResult
where
    F: FnMut(&str, u8, &str),
{
    let _mutation_guard = component_mutation_guard();
    match id {
        "ffmpeg" => install_managed_ffmpeg(resource_root, &mut progress),
        "media-fetcher" => install_media_fetcher(resource_root, &mut progress),
        "vocal-separation" => install_python_component(
            id,
            "separate.py",
            "separation",
            true,
            &components_dir.join(id),
        ),
        "pi-audio" | "cvrs" => {
            let source = if std::env::var("SYNTHV_TOOLBOX_COMPONENT_SOURCE")
                .is_ok_and(|value| value.eq_ignore_ascii_case("bundled"))
            {
                progress("downloading", 50, "开发模式：使用应用包内的组件源码。");
                Ok(components_dir.join(id))
            } else {
                download_component_source(id, resource_root, &mut progress)
            };
            let source = match source {
                Ok(source) => source,
                Err(error) => return failed("组件下载失败。", error),
            };
            progress("installing", 68, "源码校验完成，正在创建本地运行环境。");
            match id {
                "pi-audio" => install_python_component(id, "pi_audio.py", "audio", true, &source),
                "cvrs" => install_python_component(id, "cvrs.py", "cvrs", false, &source),
                _ => unreachable!(),
            }
        }
        "sandboxie" => download_sandboxie_installer(resource_root, &mut progress),
        _ => failed(
            "此组件尚无可信的跨平台安装清单。",
            "已拒绝下载；请等待包含来源、版本和 SHA-256 的发布清单。",
        ),
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ComponentRemovalOutcome {
    removed_directory: bool,
    removed_config: bool,
}

impl ComponentRemovalOutcome {
    fn changed(&self) -> bool {
        self.removed_directory || self.removed_config
    }
}

struct ComponentConfigRemoval {
    original: Vec<u8>,
    updated: Vec<u8>,
}

struct ManagedComponentPaths {
    id: &'static str,
    config_key: &'static str,
    target: PathBuf,
    python: PathBuf,
    script: PathBuf,
}

pub fn remove_local_component(id: &str) -> OperationResult {
    let _mutation_guard = component_mutation_guard();
    let _config_guard = match model_config_mutation_guard() {
        Ok(guard) => guard,
        Err(error) => return failed("无法锁定组件配置。", error),
    };
    match remove_local_component_at(id, &data_root(), &model_config_path()) {
        Ok(outcome) if outcome.changed() => succeeded(
            format!("{} 已删除。", display_name(id)),
            "应用管理的运行环境和配置引用已移除；下载缓存仍保留，可供以后重新安装。",
        ),
        Ok(_) => succeeded(
            format!("{} 当前未安装。", display_name(id)),
            "没有发现需要删除的应用管理文件或配置引用。",
        ),
        Err(error) => failed("无法删除本地组件。", error),
    }
}

fn remove_local_component_at(
    id: &str,
    managed_data_root: &Path,
    config_path: &Path,
) -> Result<ComponentRemovalOutcome, String> {
    let managed = managed_component_paths(id, managed_data_root)?;
    if id == "ffmpeg"
        && managed.target.exists()
        && !toolbox_managed_ffmpeg_directory_exists(managed_data_root)
    {
        return Err(
            "FFmpeg 目录缺少匹配当前固定版本的 Toolbox manifest，已按外部文件保留。".to_string(),
        );
    }
    let config_removal = prepare_component_config_removal(config_path, &managed)?;
    let components_root = managed_data_root.join("components");
    let target = &managed.target;
    let staged = stage_managed_component(managed_data_root, &components_root, target, managed.id)?;

    if let Some(removal) = &config_removal {
        if let Err(error) = write_config_atomically(config_path, &removal.updated) {
            let rollback = rollback_staged_component(staged.as_deref(), target);
            return Err(match rollback {
                Ok(()) => format!("无法更新组件配置：{error}"),
                Err(rollback_error) => format!(
                    "无法更新组件配置：{error}；同时无法恢复已暂存的组件目录：{rollback_error}"
                ),
            });
        }
    }

    if let Some(staged) = &staged {
        if let Err(error) = fs::remove_dir_all(staged) {
            let directory_rollback = rollback_staged_component(Some(staged), target);
            let config_rollback = if directory_rollback.is_ok() {
                config_removal
                    .as_ref()
                    .map(|removal| write_config_atomically(config_path, &removal.original))
                    .transpose()
                    .map(|_| ())
            } else {
                Ok(())
            };
            let mut detail = format!("无法清理组件运行目录：{error}");
            if let Err(rollback_error) = directory_rollback {
                detail.push_str(&format!("；目录恢复失败：{rollback_error}"));
            }
            if let Err(rollback_error) = config_rollback {
                detail.push_str(&format!("；配置恢复失败：{rollback_error}"));
            }
            return Err(detail);
        }
    }

    Ok(ComponentRemovalOutcome {
        removed_directory: staged.is_some(),
        removed_config: config_removal.is_some(),
    })
}

fn managed_component_paths(
    id: &str,
    managed_data_root: &Path,
) -> Result<ManagedComponentPaths, String> {
    let (managed_id, config_key, script_name) = match id {
        "pi-audio" => ("pi-audio", "audio", "pi_audio.py"),
        "cvrs" => ("cvrs", "cvrs", "cvrs.py"),
        "ffmpeg" => ("ffmpeg", "", "bin/ffmpeg.exe"),
        "media-fetcher" => (
            "media-fetcher",
            "",
            if cfg!(windows) {
                "yt-dlp.exe"
            } else {
                "yt-dlp"
            },
        ),
        "vocal-separation" => ("vocal-separation", "separation", "separate.py"),
        "sandboxie" => {
            return Err(format!(
                "{} 不是由 SynthV Toolbox 管理安装的组件，不能在这里删除。",
                display_name(id)
            ))
        }
        _ => return Err("未知组件，已拒绝删除。".to_string()),
    };
    let target = managed_data_root.join("components").join(managed_id);
    let python = if cfg!(windows) {
        target.join("venv/Scripts/python.exe")
    } else {
        target.join("venv/bin/python3")
    };
    let script = target.join(script_name);
    Ok(ManagedComponentPaths {
        id: managed_id,
        config_key,
        target,
        python,
        script,
    })
}

fn prepare_component_config_removal(
    config_path: &Path,
    managed: &ManagedComponentPaths,
) -> Result<Option<ComponentConfigRemoval>, String> {
    if managed.config_key.is_empty() {
        return Ok(None);
    }
    reject_symlink_or_reparse(config_path, "组件配置")?;
    let original = match fs::read(config_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取组件配置：{error}")),
    };
    let mut value: Value = serde_json::from_slice(&original)
        .map_err(|error| format!("组件配置无法解析，未删除任何文件：{error}"))?;
    let root = value
        .as_object_mut()
        .ok_or_else(|| "组件配置不是 JSON 对象，未删除任何文件。".to_string())?;
    if !root
        .get(managed.config_key)
        .is_some_and(|section| section_references_managed_component(section, managed))
    {
        return Ok(None);
    }
    root.remove(managed.config_key);
    let updated = serde_json::to_vec_pretty(&value)
        .map_err(|error| format!("无法序列化组件配置：{error}"))?;
    Ok(Some(ComponentConfigRemoval { original, updated }))
}

fn config_references_managed_component(
    config_path: &Path,
    managed: &ManagedComponentPaths,
) -> bool {
    let value: Value = fs::read(config_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    value
        .get(managed.config_key)
        .is_some_and(|section| section_references_managed_component(section, managed))
}

fn section_references_managed_component(section: &Value, managed: &ManagedComponentPaths) -> bool {
    section
        .get("python")
        .and_then(Value::as_str)
        .is_some_and(|path| Path::new(path) == managed.python.as_path())
        && section
            .get("script")
            .and_then(Value::as_str)
            .is_some_and(|path| Path::new(path) == managed.script.as_path())
}

fn managed_component_directory_exists(target: &Path) -> bool {
    fs::symlink_metadata(target).is_ok_and(|metadata| {
        metadata.is_dir()
            && !metadata.file_type().is_symlink()
            && !metadata_is_reparse_point(&metadata)
    })
}

fn stage_managed_component(
    managed_data_root: &Path,
    components_root: &Path,
    target: &Path,
    managed_id: &str,
) -> Result<Option<PathBuf>, String> {
    reject_symlink_or_reparse(managed_data_root, "应用数据根目录")?;
    reject_symlink_or_reparse(components_root, "组件管理目录")?;
    reject_symlink_or_reparse(target, "组件运行目录")?;
    let metadata = match fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法检查组件运行目录：{error}")),
    };
    if !metadata.is_dir() {
        return Err(format!(
            "组件管理路径 {} 不是目录，已拒绝删除。",
            target.display()
        ));
    }
    let staged = components_root.join(format!(".{managed_id}.removing-{}", Uuid::new_v4()));
    fs::rename(target, &staged)
        .map_err(|error| format!("无法暂存组件运行目录 {}：{error}", target.display()))?;
    Ok(Some(staged))
}

fn rollback_staged_component(staged: Option<&Path>, target: &Path) -> Result<(), String> {
    let Some(staged) = staged else {
        return Ok(());
    };
    if !staged.exists() {
        return Err(format!("暂存目录 {} 已不存在", staged.display()));
    }
    if target.exists() {
        return Err(format!("原组件路径 {} 已被占用", target.display()));
    }
    fs::rename(staged, target).map_err(|error| error.to_string())
}

fn reject_symlink_or_reparse(path: &Path, label: &str) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("无法检查{label} {}：{error}", path.display())),
    };
    if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
        return Err(format!(
            "{label} {} 是符号链接或 reparse point；为避免越界删除，操作已停止。",
            path.display()
        ));
    }
    Ok(())
}

fn regular_file_without_links(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && !metadata_is_reparse_point(&metadata)
    })
}

fn path_chain_has_no_links(path: &Path) -> bool {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match fs::symlink_metadata(candidate) {
            Ok(metadata)
                if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) =>
            {
                return false;
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return false,
        }
        current = candidate.parent();
    }
    true
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn write_config_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "组件配置路径没有父目录。".to_string())?;
    reject_symlink_or_reparse(parent, "组件配置目录")?;
    reject_symlink_or_reparse(path, "组件配置")?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建组件配置目录：{error}"))?;
    let temporary = parent.join(format!(".component-config-{}.tmp", Uuid::new_v4()));
    write_private_config_temporary(&temporary, path, bytes)?;
    if let Err(error) = replace_config_file(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法提交组件配置：{error}"));
    }
    Ok(())
}

#[cfg(unix)]
fn write_private_config_temporary(
    temporary: &Path,
    target: &Path,
    bytes: &[u8],
) -> Result<(), String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let target_mode = match fs::metadata(target) {
        Ok(metadata) => metadata.permissions().mode() & 0o777,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0o600,
        Err(error) => return Err(format!("无法读取现有组件配置权限：{error}")),
    };
    let mut temporary_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(temporary)
        .map_err(|error| format!("无法创建私有组件配置临时文件：{error}"))?;
    if let Err(error) = temporary_file
        .write_all(bytes)
        .and_then(|_| temporary_file.sync_all())
        .and_then(|_| fs::set_permissions(temporary, fs::Permissions::from_mode(target_mode)))
    {
        drop(temporary_file);
        let _ = fs::remove_file(temporary);
        return Err(format!("无法安全写入组件配置临时文件：{error}"));
    }
    Ok(())
}

#[cfg(not(unix))]
fn write_private_config_temporary(
    temporary: &Path,
    _target: &Path,
    bytes: &[u8],
) -> Result<(), String> {
    let mut temporary_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary)
        .map_err(|error| format!("无法创建组件配置临时文件：{error}"))?;
    temporary_file
        .write_all(bytes)
        .and_then(|_| temporary_file.sync_all())
        .map_err(|error| format!("无法写入组件配置临时文件：{error}"))
}

#[cfg(not(windows))]
fn replace_config_file(temporary: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(temporary, target)
}

#[cfg(windows)]
fn replace_config_file(temporary: &Path, target: &Path) -> std::io::Result<()> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    if !target.exists() {
        return fs::rename(temporary, target);
    }
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let temporary = temporary
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        ReplaceFileW(
            target.as_ptr(),
            temporary.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn sandboxie_component_info() -> ComponentInfo {
    let installed = cfg!(windows) && detect_sandboxie().is_ok();
    let downloaded = cfg!(windows) && sandboxie_installer_path().is_file();
    let installable = cfg!(all(windows, target_arch = "x86_64"));
    ComponentInfo {
        id: "sandboxie".to_string(),
        display_name: format!("Sandboxie Plus {SANDBOXIE_VERSION}"),
        description: "SynthV Toolbox 并发隔离提供方；下载官方安装包后由用户交互安装。".to_string(),
        audience: "Windows 并发隔离".to_string(),
        installed,
        removable: false,
        downloaded,
        installable,
        status: if installed {
            "已检测到受支持的 Sandboxie".to_string()
        } else if downloaded {
            "官方安装包已下载；等待用户安装".to_string()
        } else if installable {
            "可由 Toolbox 内置下载器下载官方 x64 安装包".to_string()
        } else {
            "仅适用于 Windows x64".to_string()
        },
    }
}

fn managed_ffmpeg_directory(data_root: &Path) -> PathBuf {
    data_root.join("components").join("ffmpeg")
}

fn ffmpeg_archive_cached(data_root: &Path) -> bool {
    let archive = data_root
        .join("downloads")
        .join("ffmpeg")
        .join(FFMPEG_RELEASE_TAG)
        .join(FFMPEG_ARCHIVE_NAME);
    regular_file_without_links(&archive) && verify_sha256(&archive, FFMPEG_ARCHIVE_SHA256).is_ok()
}

fn managed_ffmpeg_directory_exists(data_root: &Path) -> bool {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return false;
    }
    managed_ffmpeg_directory_exists_at(&managed_ffmpeg_directory(data_root))
}

fn toolbox_managed_ffmpeg_directory_exists(data_root: &Path) -> bool {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return false;
    }
    toolbox_managed_ffmpeg_directory_exists_at(&managed_ffmpeg_directory(data_root))
}

pub(crate) fn managed_ffmpeg_runtime() -> Option<(PathBuf, PathBuf)> {
    let managed_data_root = data_root();
    managed_ffmpeg_directory_exists(&managed_data_root).then(|| {
        let bin = managed_ffmpeg_directory(&managed_data_root).join("bin");
        (bin.join("ffmpeg.exe"), bin.join("ffprobe.exe"))
    })
}

fn configured_ffmpeg_directory() -> Option<PathBuf> {
    std::env::var_os("SYNTHV_TOOLBOX_FFMPEG_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

fn resolve_ffmpeg_binary(resource_root: &Path, managed_data_root: &Path) -> Option<PathBuf> {
    let configured = configured_ffmpeg_directory();
    if let Some(path) = configured
        .as_ref()
        .and_then(|root| find_ffmpeg_pair(root))
        .map(|(ffmpeg, _)| ffmpeg)
    {
        return Some(path);
    }
    if managed_ffmpeg_directory_exists(managed_data_root) {
        return Some(managed_ffmpeg_directory(managed_data_root).join("bin/ffmpeg.exe"));
    }
    if let Some((ffmpeg, _)) = find_ffmpeg_pair(&resource_root.join("ffmpeg")) {
        return Some(ffmpeg);
    }
    system_ffmpeg_pair().map(|(ffmpeg, _)| ffmpeg)
}

pub(crate) fn resolved_ffmpeg_directory(resource_root: &Path) -> Option<PathBuf> {
    resolve_ffmpeg_binary(resource_root, &data_root())
        .and_then(|binary| binary.parent().map(Path::to_path_buf))
}

pub(crate) fn find_ffmpeg_pair(root: &Path) -> Option<(PathBuf, PathBuf)> {
    let ffmpeg_name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let ffprobe_name = if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    [root.to_path_buf(), root.join("bin")]
        .into_iter()
        .find_map(|directory| {
            let ffmpeg = directory.join(ffmpeg_name);
            let ffprobe = directory.join(ffprobe_name);
            (path_chain_has_no_links(&directory)
                && regular_file_without_links(&ffmpeg)
                && regular_file_without_links(&ffprobe))
            .then_some((ffmpeg, ffprobe))
        })
}

fn system_ffmpeg_pair() -> Option<(PathBuf, PathBuf)> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|directory| find_ffmpeg_pair(&directory))
}

fn ffmpeg_status_label(resource_root: &Path, managed_data_root: &Path, fallback: &str) -> String {
    if configured_ffmpeg_directory()
        .as_ref()
        .and_then(|root| find_ffmpeg_pair(root))
        .is_some()
    {
        "已就绪（显式目录）".to_string()
    } else if managed_ffmpeg_directory_exists(managed_data_root) {
        format!("已就绪（Toolbox 私有 {FFMPEG_VERSION}）")
    } else if find_ffmpeg_pair(&resource_root.join("ffmpeg")).is_some() {
        "已就绪（应用包内）".to_string()
    } else if system_ffmpeg_pair().is_some() {
        "已就绪（系统 PATH）".to_string()
    } else {
        fallback.to_string()
    }
}

#[derive(Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegInstallManifest {
    schema_version: u32,
    managed_by: String,
    version: String,
    release_tag: String,
    archive: String,
    sha256: String,
    source: String,
    binaries: [String; 2],
}

fn read_toolbox_ffmpeg_manifest(root: &Path) -> Option<FfmpegInstallManifest> {
    let manifest_path = root.join(FFMPEG_MANIFEST_NAME);
    if !regular_file_without_links(&manifest_path) || !path_chain_has_no_links(&manifest_path) {
        return None;
    }
    let bytes = fs::read(manifest_path).ok()?;
    let manifest: FfmpegInstallManifest = serde_json::from_slice(&bytes).ok()?;
    (manifest.schema_version == FFMPEG_MANIFEST_SCHEMA
        && manifest.managed_by == FFMPEG_MANAGED_BY
        && manifest.source == "BtbN LGPL"
        && manifest.binaries == ["bin/ffmpeg.exe", "bin/ffprobe.exe"]
        && !manifest.version.trim().is_empty()
        && !manifest.release_tag.trim().is_empty()
        && Path::new(&manifest.archive)
            .file_name()
            .and_then(|name| name.to_str())
            == Some(manifest.archive.as_str())
        && manifest.archive.ends_with(".zip")
        && manifest.sha256.len() == 64
        && manifest.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()))
    .then_some(manifest)
}

fn read_ffmpeg_manifest(root: &Path) -> Option<FfmpegInstallManifest> {
    let manifest = read_toolbox_ffmpeg_manifest(root)?;
    (manifest.version == FFMPEG_VERSION
        && manifest.release_tag == FFMPEG_RELEASE_TAG
        && manifest.archive == FFMPEG_ARCHIVE_NAME
        && manifest.sha256 == FFMPEG_ARCHIVE_SHA256)
        .then_some(manifest)
}

fn install_managed_ffmpeg<F>(_resource_root: &Path, progress: &mut F) -> OperationResult
where
    F: FnMut(&str, u8, &str),
{
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return failed(
            "Toolbox 私有 FFmpeg 安装仅适用于 Windows x64。",
            "macOS 及其他平台只使用显式目录、应用包内或系统 PATH 中的 FFmpeg，不会自动下载未知二进制。",
        );
    }
    let managed_data_root = data_root();
    let managed_root = managed_ffmpeg_directory(&managed_data_root);
    if managed_ffmpeg_directory_exists(&managed_data_root) {
        if let Some(components_root) = managed_root.parent() {
            if let Err(error) =
                cleanup_ffmpeg_artifacts(components_root, &managed_root, SystemTime::now())
            {
                eprintln!("FFmpeg 安装残留清理跳过：{error}");
            }
        }
        return succeeded(
            format!("FFmpeg {FFMPEG_VERSION} 已可用。"),
            format!("Toolbox 私有安装位置：{}。", managed_root.display()),
        );
    }
    let cache = managed_data_root
        .join("downloads")
        .join("ffmpeg")
        .join(FFMPEG_RELEASE_TAG);
    if let Err(error) = reject_symlink_or_reparse(&managed_data_root, "应用数据根目录") {
        return failed("FFmpeg 下载路径不安全。", error);
    }
    if let Err(error) = reject_symlink_or_reparse(&managed_data_root.join("downloads"), "下载目录")
    {
        return failed("FFmpeg 下载路径不安全。", error);
    }
    if let Err(error) = reject_symlink_or_reparse(
        &managed_data_root.join("downloads/ffmpeg"),
        "FFmpeg 下载目录",
    ) {
        return failed("FFmpeg 下载路径不安全。", error);
    }
    if let Err(error) = reject_symlink_or_reparse(&cache, "FFmpeg 下载缓存") {
        return failed("FFmpeg 下载缓存不安全。", error);
    }
    if let Err(error) = fs::create_dir_all(&cache) {
        return failed("无法创建 FFmpeg 下载缓存。", error.to_string());
    }
    if !path_chain_has_no_links(&cache) {
        return failed(
            "FFmpeg 下载缓存不安全。",
            "下载路径包含符号链接或 reparse point。",
        );
    }
    let payload = ComponentPayload {
        name: FFMPEG_ARCHIVE_NAME,
        relative_url: "",
        sha256: FFMPEG_ARCHIVE_SHA256,
    };
    let archive = cache.join(FFMPEG_ARCHIVE_NAME);
    if !ffmpeg_archive_cached(&managed_data_root) {
        progress("downloading", 12, "正在下载固定版本的 FFmpeg LGPL 包。");
        let download_stage = cache.join(format!(".download-{}", Uuid::new_v4()));
        if let Err(error) = fs::create_dir(&download_stage) {
            return failed("无法创建 FFmpeg 下载暂存目录。", error.to_string());
        }
        let staged_archive = download_stage.join(FFMPEG_ARCHIVE_NAME);
        let download_result = download_verified_file(
            FFMPEG_ARCHIVE_URL,
            &staged_archive,
            payload.sha256,
            MAX_FFMPEG_DOWNLOAD_BYTES,
        )
        .and_then(|()| {
            if !regular_file_without_links(&staged_archive) {
                return Err("FFmpeg 下载结果不是安全的普通文件。".to_string());
            }
            verify_sha256(&staged_archive, FFMPEG_ARCHIVE_SHA256)?;
            if archive.exists() {
                if !regular_file_without_links(&archive) {
                    return Err("FFmpeg 最终缓存路径是链接或非普通文件。".to_string());
                }
                fs::remove_file(&archive)
                    .map_err(|error| format!("无法替换旧 FFmpeg 缓存：{error}"))?;
            }
            fs::rename(&staged_archive, &archive)
                .map_err(|error| format!("无法提交 FFmpeg 下载缓存：{error}"))
        });
        let _ = fs::remove_dir_all(&download_stage);
        if let Err(error) = download_result {
            return failed("FFmpeg 下载失败。", error);
        }
    }
    progress(
        "installing",
        68,
        "FFmpeg 下载包校验通过，正在安全解压并原子安装。",
    );
    let target = managed_ffmpeg_directory(&managed_data_root);
    match install_ffmpeg_archive(&archive, &target) {
        Ok(()) => {
            progress("installing", 96, "FFmpeg 私有副本安装完成。");
            succeeded(
                format!("FFmpeg {FFMPEG_VERSION} 已安装。"),
                format!("Toolbox 私有安装位置：{}", target.display()),
            )
        }
        Err(error) => failed("FFmpeg 安装失败。", error),
    }
}

fn install_ffmpeg_archive(archive: &Path, target: &Path) -> Result<(), String> {
    let components_root = target
        .parent()
        .ok_or_else(|| "FFmpeg 目标目录没有组件父目录。".to_string())?;
    let managed_data_root = components_root
        .parent()
        .ok_or_else(|| "FFmpeg 组件目录没有应用数据根目录。".to_string())?;
    reject_symlink_or_reparse(managed_data_root, "应用数据根目录")?;
    reject_symlink_or_reparse(components_root, "组件管理目录")?;
    reject_symlink_or_reparse(target, "FFmpeg 私有目录")?;
    if !path_chain_has_no_links(managed_data_root)
        || !path_chain_has_no_links(components_root)
        || !path_chain_has_no_links(target)
    {
        return Err("FFmpeg 安装路径包含符号链接或 reparse point。".to_string());
    }
    fs::create_dir_all(components_root).map_err(|error| format!("无法创建组件目录：{error}"))?;
    if !path_chain_has_no_links(components_root) || !path_chain_has_no_links(target) {
        return Err("FFmpeg 安装目录创建后检测到符号链接或 reparse point。".to_string());
    }
    // An interrupted replacement can leave only a private staging artifact behind. Recover
    // verified managed backups before creating another transaction; unverified artifacts are
    // deliberately left untouched and can be inspected by the user.
    if let Err(error) = cleanup_ffmpeg_artifacts(components_root, target, SystemTime::now()) {
        eprintln!("FFmpeg 安装残留清理跳过：{error}");
    }
    let extract = components_root.join(format!(".ffmpeg.extract-{}", Uuid::new_v4()));
    let stage = components_root.join(format!(".ffmpeg.install-{}", Uuid::new_v4()));
    fs::create_dir_all(&extract).map_err(|error| format!("无法创建解压暂存目录：{error}"))?;
    let result = (|| {
        let listing = quiet_command("tar")
            .args(["-tf"])
            .arg(archive)
            .output()
            .map_err(|error| format!("无法启动 tar 解压工具：{error}"))?;
        if !listing.status.success() {
            return Err("无法读取 FFmpeg ZIP 文件目录。".to_string());
        }
        let entries = String::from_utf8_lossy(&listing.stdout)
            .lines()
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        let ffmpeg_entry = find_archive_binary(&entries, "ffmpeg.exe")?;
        let ffprobe_entry = find_archive_binary(&entries, "ffprobe.exe")?;
        for entry in &entries {
            validate_archive_entry(entry)?;
        }
        let verbose_listing = quiet_command("tar")
            .args(["-tvf"])
            .arg(archive)
            .output()
            .map_err(|error| format!("无法检查 FFmpeg ZIP 条目类型：{error}"))?;
        if !verbose_listing.status.success() {
            return Err("无法检查 FFmpeg ZIP 条目类型。".to_string());
        }
        validate_archive_entry_types(&verbose_listing.stdout)?;
        let extraction = quiet_command("tar")
            .args(["-xf"])
            .arg(archive)
            .args(["-C"])
            .arg(&extract)
            .output()
            .map_err(|error| format!("无法解压 FFmpeg ZIP 文件：{error}"))?;
        if !extraction.status.success() {
            return Err("FFmpeg ZIP 解压失败。".to_string());
        }
        let ffmpeg_source = extract.join(&ffmpeg_entry);
        let ffprobe_source = extract.join(&ffprobe_entry);
        reject_extracted_file(&extract, &ffmpeg_source, "ffmpeg.exe")?;
        reject_extracted_file(&extract, &ffprobe_source, "ffprobe.exe")?;
        fs::create_dir_all(stage.join("bin"))
            .map_err(|error| format!("无法创建 FFmpeg 目录：{error}"))?;
        copy_ffmpeg_bin(
            ffmpeg_source.parent().unwrap_or(&extract),
            &stage.join("bin"),
        )?;
        let manifest = FfmpegInstallManifest {
            schema_version: FFMPEG_MANIFEST_SCHEMA,
            managed_by: FFMPEG_MANAGED_BY.to_string(),
            version: FFMPEG_VERSION.to_string(),
            release_tag: FFMPEG_RELEASE_TAG.to_string(),
            archive: FFMPEG_ARCHIVE_NAME.to_string(),
            sha256: FFMPEG_ARCHIVE_SHA256.to_string(),
            source: "BtbN LGPL".to_string(),
            binaries: ["bin/ffmpeg.exe".to_string(), "bin/ffprobe.exe".to_string()],
        };
        let bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
        fs::write(stage.join(FFMPEG_MANIFEST_NAME), bytes)
            .map_err(|error| format!("无法写入 FFmpeg manifest：{error}"))?;
        atomic_replace_managed_directory(&stage, target, components_root)
    })();
    let _ = fs::remove_dir_all(&extract);
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FfmpegArtifactKind {
    Extract,
    Install,
    Backup,
}

fn ffmpeg_artifact_kind(path: &Path) -> Option<FfmpegArtifactKind> {
    let name = path.file_name()?.to_str()?;
    let (prefix, kind) = if let Some(suffix) = name.strip_prefix(".ffmpeg.extract-") {
        (suffix, FfmpegArtifactKind::Extract)
    } else if let Some(suffix) = name.strip_prefix(".ffmpeg.install-") {
        (suffix, FfmpegArtifactKind::Install)
    } else {
        (
            name.strip_prefix(".ffmpeg.backup-")?,
            FfmpegArtifactKind::Backup,
        )
    };
    Uuid::parse_str(prefix).ok().map(|_| kind)
}

fn managed_ffmpeg_directory_exists_at(root: &Path) -> bool {
    toolbox_managed_ffmpeg_directory_exists_at(root) && read_ffmpeg_manifest(root).is_some()
}

fn toolbox_managed_ffmpeg_directory_exists_at(root: &Path) -> bool {
    managed_component_directory_exists(root)
        && path_chain_has_no_links(&root.join("bin"))
        && regular_file_without_links(&root.join("bin/ffmpeg.exe"))
        && regular_file_without_links(&root.join("bin/ffprobe.exe"))
        && read_toolbox_ffmpeg_manifest(root).is_some()
}

fn directory_tree_has_no_links(path: &Path) -> bool {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return false,
    };
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
    {
        return false;
    }
    fs::read_dir(path).is_ok_and(|entries| {
        entries.flatten().all(|entry| {
            let child = entry.path();
            match fs::symlink_metadata(&child) {
                Ok(metadata)
                    if metadata.file_type().is_symlink()
                        || metadata_is_reparse_point(&metadata) =>
                {
                    false
                }
                Ok(metadata) if metadata.is_dir() => directory_tree_has_no_links(&child),
                Ok(_) => true,
                Err(_) => false,
            }
        })
    })
}

fn ffmpeg_artifact_is_stale(path: &Path, now: SystemTime) -> bool {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| now.duration_since(modified).ok())
        .is_some_and(|age| age > FFMPEG_ARTIFACT_MAX_AGE)
}

fn cleanup_ffmpeg_artifacts(
    components_root: &Path,
    target: &Path,
    now: SystemTime,
) -> Result<(), String> {
    reject_symlink_or_reparse(components_root, "组件管理目录")?;
    reject_symlink_or_reparse(target, "FFmpeg 私有目录")?;
    if !path_chain_has_no_links(components_root) || !path_chain_has_no_links(target) {
        return Err("FFmpeg 残留清理路径包含符号链接或 reparse point。".to_string());
    }
    let mut artifacts = fs::read_dir(components_root)
        .map_err(|error| format!("无法扫描 FFmpeg 安装残留：{error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| ffmpeg_artifact_kind(path).is_some())
        .collect::<Vec<_>>();
    if artifacts.len() > MAX_FFMPEG_ARTIFACTS_TO_SCAN {
        return Err(format!(
            "发现超过 {MAX_FFMPEG_ARTIFACTS_TO_SCAN} 个带 UUID 的 FFmpeg 残留，已停止自动清理。"
        ));
    }

    // If a process stopped after moving the old target aside but before publishing the new one,
    // recover the newest *validated* Toolbox installation. Never infer trust from the filename.
    if !target.exists() {
        let recovery = artifacts
            .iter()
            .filter(|path| ffmpeg_artifact_kind(path) == Some(FfmpegArtifactKind::Backup))
            .filter(|path| toolbox_managed_ffmpeg_directory_exists_at(path))
            .max_by_key(|path| {
                fs::metadata(path)
                    .and_then(|metadata| metadata.modified())
                    .ok()
            })
            .cloned();
        if let Some(backup) = recovery {
            if let Err(error) = fs::rename(&backup, target) {
                eprintln!("无法恢复已验证的 FFmpeg 备份 {}：{error}", backup.display());
            }
        }
    }

    for artifact in artifacts.drain(..) {
        let Some(kind) = ffmpeg_artifact_kind(&artifact) else {
            continue;
        };
        // Only remove private directories that are regular, link-free directories. In
        // particular, an unverified backup is retained even when it is old.
        if !ffmpeg_artifact_is_stale(&artifact, now) || !directory_tree_has_no_links(&artifact) {
            continue;
        }
        if kind == FfmpegArtifactKind::Backup
            && !toolbox_managed_ffmpeg_directory_exists_at(&artifact)
        {
            continue;
        }
        if let Err(error) = fs::remove_dir_all(&artifact) {
            eprintln!("无法清理 FFmpeg 安装残留 {}：{error}", artifact.display());
        }
    }
    Ok(())
}

fn find_archive_binary(entries: &[String], name: &str) -> Result<String, String> {
    entries
        .iter()
        .find(|entry| {
            let normalized = entry.replace('\\', "/");
            normalized.ends_with(&format!("/bin/{name}")) || normalized == format!("bin/{name}")
        })
        .cloned()
        .ok_or_else(|| format!("FFmpeg ZIP 缺少 bin/{name}。"))
}

fn validate_archive_entry(entry: &str) -> Result<(), String> {
    let normalized = entry.replace('\\', "/");
    if normalized.starts_with('/')
        || normalized.contains(':')
        || normalized.split('/').any(|part| part == "..")
    {
        return Err(format!("FFmpeg ZIP 包含不安全路径：{entry}"));
    }
    Ok(())
}

fn validate_archive_entry_types(listing: &[u8]) -> Result<(), String> {
    let listing = String::from_utf8_lossy(listing);
    for line in listing
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        match line.as_bytes().first().copied() {
            Some(b'-' | b'd') => {}
            _ => {
                return Err(format!("FFmpeg ZIP 包含链接或特殊条目，已拒绝解压：{line}"));
            }
        }
    }
    Ok(())
}

fn reject_extracted_file(root: &Path, path: &Path, name: &str) -> Result<(), String> {
    if !path.starts_with(root) {
        return Err(format!("解压后的 {name} 路径越出暂存目录。"));
    }
    let mut current = Some(path);
    while let Some(candidate) = current {
        reject_symlink_or_reparse(candidate, "FFmpeg 解压路径")?;
        current = candidate.parent().filter(|parent| parent.starts_with(root));
    }
    let metadata =
        fs::metadata(path).map_err(|error| format!("无法读取解压后的 {name}：{error}"))?;
    if !metadata.is_file() {
        return Err(format!("解压后的 {name} 不是普通文件。"));
    }
    Ok(())
}

fn copy_ffmpeg_bin(source: &Path, destination: &Path) -> Result<(), String> {
    reject_symlink_or_reparse(source, "FFmpeg 解压 bin 目录")?;
    for entry in
        fs::read_dir(source).map_err(|error| format!("无法读取 FFmpeg bin 目录：{error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取 FFmpeg bin 条目：{error}"))?;
        let path = entry.path();
        reject_symlink_or_reparse(&path, "FFmpeg 解压条目")?;
        let metadata =
            fs::metadata(&path).map_err(|error| format!("无法读取 FFmpeg 解压条目：{error}"))?;
        if !metadata.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .ok_or_else(|| "FFmpeg 解压条目缺少文件名。".to_string())?;
        fs::copy(&path, destination.join(name))
            .map_err(|error| format!("无法暂存 FFmpeg bin 条目：{error}"))?;
    }
    Ok(())
}

fn atomic_replace_managed_directory(
    stage: &Path,
    target: &Path,
    root: &Path,
) -> Result<(), String> {
    reject_symlink_or_reparse(stage, "FFmpeg 安装暂存目录")?;
    reject_symlink_or_reparse(root, "组件管理目录")?;
    if !managed_ffmpeg_directory_exists_at(stage) {
        return Err("FFmpeg 安装暂存目录缺少当前固定版本的有效 manifest。".to_string());
    }
    let backup = root.join(format!(".ffmpeg.backup-{}", Uuid::new_v4()));
    let had_target = target.exists();
    if had_target {
        reject_symlink_or_reparse(target, "FFmpeg 私有目录")?;
        if !toolbox_managed_ffmpeg_directory_exists_at(target) {
            return Err(
                "现有 FFmpeg 私有目录缺少匹配当前版本的 Toolbox manifest，已保留原目录。"
                    .to_string(),
            );
        }
        fs::rename(target, &backup).map_err(|error| format!("无法暂存旧 FFmpeg：{error}"))?;
    }
    if let Err(error) = fs::rename(stage, target) {
        if had_target {
            let _ = fs::rename(&backup, target);
        }
        return Err(format!("无法提交 FFmpeg 私有目录：{error}"));
    }
    if had_target {
        // The new target is already published. Failure to remove the old, validated backup is
        // recoverable and must not turn a successful install into a false failure. The next
        // install will retry bounded cleanup; retaining it is safer than deleting blindly.
        if let Err(error) = fs::remove_dir_all(&backup) {
            eprintln!(
                "FFmpeg 新版本已安装，但旧目录备份暂时无法清理 {}：{error}",
                backup.display()
            );
        }
    }
    Ok(())
}

fn download_sandboxie_installer<F>(_resource_root: &Path, progress: &mut F) -> OperationResult
where
    F: FnMut(&str, u8, &str),
{
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return failed(
            "Sandboxie 安装包仅适用于 Windows x64。",
            "macOS 不使用 Sandboxie；账号并发隔离在 Windows 上提供。",
        );
    }
    let directory = sandboxie_download_directory();
    if let Err(error) = fs::create_dir_all(&directory) {
        return failed("无法创建 Sandboxie 下载目录。", error.to_string());
    }
    let installer = sandboxie_installer_path();
    if installer.is_file() && verify_sha256(&installer, SANDBOXIE_INSTALLER_SHA256).is_ok() {
        return succeeded(
            "Sandboxie 官方安装包已经下载。",
            format!("安装包：{}；工具箱不会静默安装驱动。", installer.display()),
        );
    }
    progress(
        "downloading",
        12,
        &format!("正在下载 Sandboxie Plus {SANDBOXIE_VERSION} 官方安装包。"),
    );
    let payload = ComponentPayload {
        name: SANDBOXIE_INSTALLER_NAME,
        relative_url: "",
        sha256: SANDBOXIE_INSTALLER_SHA256,
    };
    if let Err(error) = download_verified_file(
        SANDBOXIE_INSTALLER_URL,
        &installer,
        payload.sha256,
        MAX_COMPONENT_DOWNLOAD_BYTES,
    ) {
        return failed("Sandboxie 安装包下载失败。", error);
    }
    progress(
        "downloading",
        96,
        "Sandboxie 官方安装包已通过 SHA-256 校验。",
    );
    succeeded(
        "Sandboxie 官方安装包已下载。",
        format!(
            "安装包：{}；请从组件中心打开其位置并手动安装。",
            installer.display()
        ),
    )
}

pub fn open_component_download(id: &str) -> OperationResult {
    if id != "sandboxie" {
        return failed("该组件没有可打开的安装包。", id);
    }
    if !cfg!(windows) {
        return failed("Sandboxie 安装包仅适用于 Windows。", "");
    }
    let installer = sandboxie_installer_path();
    if !installer.is_file() {
        return failed("尚未下载 Sandboxie 安装包。", installer.to_string_lossy());
    }
    if let Err(error) = verify_sha256(&installer, SANDBOXIE_INSTALLER_SHA256) {
        return failed("Sandboxie 安装包校验失败，已拒绝打开。", error);
    }
    #[cfg(windows)]
    {
        let argument = format!("/select,{}", installer.to_string_lossy());
        if let Err(error) = quiet_command("explorer.exe").arg(argument).spawn() {
            return failed("无法打开 Sandboxie 安装包位置。", error.to_string());
        }
    }
    succeeded(
        "已打开 Sandboxie 安装包位置。",
        "请由你确认并完成交互安装；工具箱不会静默安装内核驱动。",
    )
}

fn sandboxie_download_directory() -> PathBuf {
    data_root()
        .join("downloads")
        .join("sandboxie")
        .join(SANDBOXIE_VERSION)
}

fn sandboxie_installer_path() -> PathBuf {
    sandboxie_download_directory().join(SANDBOXIE_INSTALLER_NAME)
}

fn install_python_component(
    id: &str,
    script_name: &str,
    config_key: &str,
    install_requirements: bool,
    source: &Path,
) -> OperationResult {
    if !source.join(script_name).is_file() {
        return failed("组件源码不完整。", source.to_string_lossy());
    }
    let target = data_root().join("components").join(id);
    if let Err(error) = copy_directory(source, &target) {
        return failed("复制组件失败。", error.to_string());
    }
    let Some(python) = find_python() else {
        return failed(
            "未找到 Python 3.11。",
            "请安装 Python 3.11，并确保 python3 或 python 可以启动。也可设置 SYNTHV_TOOLBOX_PYTHON。",
        );
    };
    let venv = target.join("venv");
    let venv_python = if cfg!(windows) {
        venv.join("Scripts/python.exe")
    } else {
        venv.join("bin/python3")
    };
    let venv_uses_python_311 = venv_python.is_file()
        && PythonCommand::new(venv_python.to_string_lossy().into_owned()).is_python_311();
    if !venv_uses_python_311 {
        if venv.exists() {
            if let Err(error) = fs::remove_dir_all(&venv) {
                return failed("无法替换不兼容的 Python 虚拟环境。", error.to_string());
            }
        }
        let output = quiet_command(&python.program)
            .args(&python.args)
            .args(["-m", "venv"])
            .arg(&venv)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output();
        if !output.is_ok_and(|output| output.status.success()) {
            return failed("无法创建 Python 虚拟环境。", venv.to_string_lossy());
        }
    }
    if install_requirements {
        let requirements = target.join("requirements.txt");
        let mut command = quiet_command(&venv_python);
        command
            .args(["-m", "pip", "install", "-r"])
            .arg(&requirements)
            .args(["--disable-pip-version-check"])
            // pip otherwise reads requirements.txt using the Windows ANSI code page.
            // Component manifests are UTF-8 and contain localized comments.
            .env("PYTHONUTF8", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Ok(index) = std::env::var("SYNTHV_TOOLBOX_PYPI_INDEX") {
            if !index.trim().is_empty() {
                command.args(["--index-url", index.trim()]);
            }
        }
        match command.output() {
            Ok(output) if output.status.success() => {}
            Ok(output) => {
                return failed(
                    "组件依赖安装失败。",
                    String::from_utf8_lossy(&output.stderr)
                        .chars()
                        .take(1600)
                        .collect::<String>(),
                )
            }
            Err(error) => return failed("无法启动 pip。", error.to_string()),
        }
    }
    let script = target.join(script_name);
    if let Err(error) = save_component_config(config_key, &venv_python, &script) {
        return failed("组件已复制，但无法保存配置。", error);
    }
    succeeded(
        format!("{} 已安装。", display_name(id)),
        format!("安装位置：{}", target.to_string_lossy()),
    )
}

const PI_AGENT_COMPONENT_REVISION: &str = "f4d56296d17c30077248fe9f73a13af47a329f62";

struct ComponentPayload {
    name: &'static str,
    relative_url: &'static str,
    sha256: &'static str,
}

const PI_AUDIO_PAYLOADS: &[ComponentPayload] = &[
    ComponentPayload {
        name: "pi_audio.py",
        relative_url: "components/pi-audio/pi_audio.py",
        sha256: "0e00ccd56c928475a69f39981c1f66298fc15d5249e9e7b6efa673b4ca2a4097",
    },
    ComponentPayload {
        name: "requirements.txt",
        relative_url: "components/pi-audio/requirements.txt",
        sha256: "4014ba330a2db128da28ec3782339c474df5fb1f4f0ab70842960cf5c650883e",
    },
];

const CVRS_PAYLOADS: &[ComponentPayload] = &[ComponentPayload {
    name: "cvrs.py",
    relative_url: "components/cvrs/cvrs.py",
    sha256: "71383517bdfc4394315592cf97ab2243d6fff89f0caa24ceb2ca560671354f1e",
}];

fn media_fetcher_asset() -> Option<(&'static str, &'static str, &'static str)> {
    if cfg!(target_os = "macos") {
        Some((
            "yt-dlp_macos",
            "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_macos",
            MEDIA_FETCHER_MACOS_SHA256,
        ))
    } else if cfg!(all(windows, target_arch = "x86_64")) {
        Some((
            "yt-dlp.exe",
            "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe",
            MEDIA_FETCHER_WINDOWS_SHA256,
        ))
    } else {
        None
    }
}

fn media_fetcher_cached(managed_data_root: &Path) -> bool {
    let Some((name, _, sha256)) = media_fetcher_asset() else {
        return false;
    };
    verify_sha256(
        &managed_data_root
            .join("downloads/media-fetcher")
            .join(MEDIA_FETCHER_VERSION)
            .join(name),
        sha256,
    )
    .is_ok()
}

pub(crate) fn managed_media_fetcher_binary(managed_data_root: &Path) -> Option<PathBuf> {
    let (asset_name, source, sha256) = media_fetcher_asset()?;
    let root = managed_data_root.join("components/media-fetcher");
    let binary = root.join(if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    });
    let manifest: Value = fs::read(root.join("manifest.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())?;
    (managed_component_directory_exists(&root)
        && regular_file_without_links(&binary)
        && manifest.get("managedBy").and_then(Value::as_str) == Some(FFMPEG_MANAGED_BY)
        && manifest.get("version").and_then(Value::as_str) == Some(MEDIA_FETCHER_VERSION)
        && manifest.get("asset").and_then(Value::as_str) == Some(asset_name)
        && manifest.get("source").and_then(Value::as_str) == Some(source)
        && manifest.get("sha256").and_then(Value::as_str) == Some(sha256))
    .then_some(binary)
}

fn install_media_fetcher<F>(_resource_root: &Path, progress: &mut F) -> OperationResult
where
    F: FnMut(&str, u8, &str),
{
    let Some((asset_name, source, sha256)) = media_fetcher_asset() else {
        return failed(
            "媒体导入器不支持当前平台。",
            "当前支持 macOS 与 Windows x64。",
        );
    };
    let managed_data_root = data_root();
    if managed_media_fetcher_binary(&managed_data_root).is_some() {
        return succeeded(
            format!("媒体导入器 {MEDIA_FETCHER_VERSION} 已可用。"),
            "当前固定版本和安装清单均有效。",
        );
    }
    let cache = managed_data_root
        .join("downloads/media-fetcher")
        .join(MEDIA_FETCHER_VERSION);
    if let Err(error) = fs::create_dir_all(&cache) {
        return failed("无法创建媒体导入器缓存。", error.to_string());
    }
    let payload = ComponentPayload {
        name: asset_name,
        relative_url: "",
        sha256,
    };
    progress("downloading", 12, "正在下载固定版本的 yt-dlp。");
    if let Err(error) = download_verified_file(
        source,
        &cache.join(asset_name),
        payload.sha256,
        MAX_COMPONENT_DOWNLOAD_BYTES,
    ) {
        return failed("媒体导入器下载失败。", error);
    }
    progress("installing", 72, "校验完成，正在安装媒体导入器。");
    let components_root = managed_data_root.join("components");
    if let Err(error) = fs::create_dir_all(&components_root) {
        return failed("无法创建组件目录。", error.to_string());
    }
    let target = components_root.join("media-fetcher");
    if target.exists() && managed_media_fetcher_binary(&managed_data_root).is_none() {
        return failed(
            "现有媒体导入器目录不受 Toolbox 管理。",
            "为避免覆盖未知文件，已保留原目录。",
        );
    }
    let stage = components_root.join(format!(".media-fetcher.stage-{}", Uuid::new_v4()));
    if let Err(error) = fs::create_dir(&stage) {
        return failed("无法创建媒体导入器暂存目录。", error.to_string());
    }
    let binary = stage.join(if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    });
    let result = (|| -> Result<(), String> {
        fs::copy(cache.join(asset_name), &binary)
            .map_err(|error| format!("无法复制媒体导入器：{error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o755))
                .map_err(|error| format!("无法设置媒体导入器权限：{error}"))?;
        }
        fs::write(
            stage.join("manifest.json"),
            serde_json::to_vec_pretty(&json!({
                "schemaVersion": 1,
                "managedBy": FFMPEG_MANAGED_BY,
                "id": "media-fetcher",
                "version": MEDIA_FETCHER_VERSION,
                "asset": asset_name,
                "source": source,
                "sha256": sha256,
                "license": "Unlicense",
                "entrypoint": if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" }
            }))
            .map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("无法写入媒体导入器清单：{error}"))?;
        let backup = components_root.join(format!(".media-fetcher.backup-{}", Uuid::new_v4()));
        let had_target = target.exists();
        if had_target {
            fs::rename(&target, &backup)
                .map_err(|error| format!("无法暂存旧媒体导入器：{error}"))?;
        }
        if let Err(error) = fs::rename(&stage, &target) {
            if had_target {
                let _ = fs::rename(&backup, &target);
            }
            return Err(format!("无法提交媒体导入器：{error}"));
        }
        if had_target {
            fs::remove_dir_all(&backup)
                .map_err(|error| format!("新版本已安装，但无法清理旧媒体导入器：{error}"))?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&stage);
        return failed("媒体导入器安装失败。", error);
    }
    progress("installing", 98, "媒体导入器安装完成。");
    succeeded(
        format!("媒体导入器 {MEDIA_FETCHER_VERSION} 已安装。"),
        format!("安装位置：{}", target.display()),
    )
}

fn download_component_source<F>(
    id: &str,
    _resource_root: &Path,
    progress: &mut F,
) -> Result<PathBuf, String>
where
    F: FnMut(&str, u8, &str),
{
    let payloads = match id {
        "pi-audio" => PI_AUDIO_PAYLOADS,
        "cvrs" => CVRS_PAYLOADS,
        _ => return Err("该组件没有受信任的固定下载清单。".to_string()),
    };
    let cache = data_root()
        .join("downloads")
        .join(id)
        .join(PI_AGENT_COMPONENT_REVISION);
    fs::create_dir_all(&cache).map_err(|error| format!("无法创建组件下载缓存：{error}"))?;
    for (index, payload) in payloads.iter().enumerate() {
        let start = 8 + ((index * 48) / payloads.len()) as u8;
        progress(
            "downloading",
            start,
            &format!("正在下载 {}。", payload.name),
        );
        let url = format!(
            "https://raw.githubusercontent.com/SynthVCopilot/pi-agent/{PI_AGENT_COMPONENT_REVISION}/{}",
            payload.relative_url
        );
        download_verified_file(
            &url,
            &cache.join(payload.name),
            payload.sha256,
            MAX_COMPONENT_DOWNLOAD_BYTES,
        )?;
        let complete = 8 + (((index + 1) * 48) / payloads.len()) as u8;
        progress(
            "downloading",
            complete,
            &format!("{} 已通过 SHA-256 校验。", payload.name),
        );
    }
    Ok(cache)
}

fn download_verified_file(
    url: &str,
    target: &Path,
    expected_sha256: &str,
    max_bytes: u64,
) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "下载目标没有父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建下载目录：{error}"))?;
    if target.exists() {
        if regular_file_without_links(target) && verify_sha256(target, expected_sha256).is_ok() {
            return Ok(());
        }
        fs::remove_file(target).map_err(|error| format!("无法移除无效下载文件：{error}"))?;
    }
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let temporary = parent.join(format!(".{name}.{}.part", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(60))
            .timeout_connect(Duration::from_secs(10))
            .timeout_read(Duration::from_secs(30))
            .timeout_write(Duration::from_secs(30))
            .build();
        let response = agent
            .get(url)
            .set("Accept", "application/octet-stream")
            .call()
            .map_err(|_| "下载请求失败。".to_string())?;
        if let Some(length) = response
            .header("Content-Length")
            .and_then(|value| value.parse::<u64>().ok())
        {
            if length > max_bytes {
                return Err(format!("下载响应超过大小上限（{} bytes）。", max_bytes));
            }
        }
        let mut reader = response.into_reader();
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("无法创建下载暂存文件：{error}"))?;
        let mut hasher = Sha256::new();
        let mut total = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|error| format!("读取下载响应失败：{error}"))?;
            if read == 0 {
                break;
            }
            total = total
                .checked_add(read as u64)
                .ok_or_else(|| "下载文件大小溢出。".to_string())?;
            if total > max_bytes {
                return Err(format!("下载响应超过大小上限（{} bytes）。", max_bytes));
            }
            file.write_all(&buffer[..read])
                .map_err(|error| format!("写入下载暂存文件失败：{error}"))?;
            hasher.update(&buffer[..read]);
        }
        file.sync_all()
            .map_err(|error| format!("同步下载暂存文件失败：{error}"))?;
        let actual = format!("{:x}", hasher.finalize());
        if !actual.eq_ignore_ascii_case(expected_sha256) {
            return Err("下载文件的 SHA-256 不匹配；已拒绝安装。".to_string());
        }
        fs::rename(&temporary, target).map_err(|error| format!("无法原子提交下载文件：{error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("无法读取下载文件 {}：{error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("无法校验下载文件 {}：{error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!(
            "下载文件 {} 的 SHA-256 不匹配；已拒绝安装。",
            path.display()
        ))
    }
}

fn configured_component_at(key: &str, config_path: &Path) -> bool {
    let value: Value = fs::read_to_string(config_path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let Some(section) = value.get(key) else {
        return false;
    };
    let python = section
        .get("python")
        .and_then(Value::as_str)
        .map(PathBuf::from);
    let script = section
        .get("script")
        .and_then(Value::as_str)
        .map(PathBuf::from);
    python.is_some_and(|path| path.is_file()) && script.is_some_and(|path| path.is_file())
}

fn save_component_config(key: &str, python: &Path, script: &Path) -> Result<(), String> {
    let _config_guard = model_config_mutation_guard()?;
    let path = model_config_path();
    let mut value: Value = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({}));
    let root = value
        .as_object_mut()
        .ok_or_else(|| "config.json 不是对象".to_string())?;
    root.insert(
        key.to_string(),
        json!({
            "python": python.to_string_lossy(),
            "script": script.to_string_lossy(),
        }),
    );
    let bytes = serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?;
    write_config_atomically(&path, &bytes)
}

struct PythonCommand {
    program: String,
    args: Vec<String>,
}

impl PythonCommand {
    fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
        }
    }

    #[cfg(windows)]
    fn with_args(
        program: impl Into<String>,
        args: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
        }
    }

    fn is_python_311(&self) -> bool {
        let output = quiet_command(&self.program)
            .args(&self.args)
            .arg("--version")
            .output();
        output.is_ok_and(|output| {
            output.status.success()
                && parse_python_version(&output.stdout)
                    .or_else(|| parse_python_version(&output.stderr))
                    .is_some_and(|(major, minor)| major == 3 && minor == 11)
        })
    }
}

fn parse_python_version(bytes: &[u8]) -> Option<(u16, u16)> {
    let text = std::str::from_utf8(bytes).ok()?;
    let version = text.trim().strip_prefix("Python ")?;
    let mut components = version.split('.');
    Some((
        components.next()?.parse().ok()?,
        components.next()?.parse().ok()?,
    ))
}

fn find_python() -> Option<PythonCommand> {
    let mut candidates = Vec::new();
    if let Ok(configured) = std::env::var("SYNTHV_TOOLBOX_PYTHON") {
        candidates.push(PythonCommand::new(configured));
    }
    #[cfg(windows)]
    candidates.push(PythonCommand::with_args("py", ["-3.11"]));
    candidates.extend([PythonCommand::new("python"), PythonCommand::new("python3")]);
    candidates.into_iter().find(PythonCommand::is_python_311)
}

fn copy_directory(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        if path.file_name().is_some_and(|name| name == "__pycache__") {
            continue;
        }
        let target = destination.join(entry.file_name());
        if path.is_dir() {
            copy_directory(&path, &target)?;
        } else if path.extension().is_none_or(|extension| extension != "pyc") {
            fs::copy(path, target)?;
        }
    }
    Ok(())
}

fn display_name(id: &str) -> &str {
    match id {
        "pi-audio" => "pi-audio",
        "cvrs" => "CVRS",
        "ffmpeg" => "FFmpeg",
        "sandboxie" => "Sandboxie Plus",
        _ => id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    fn temporary_test_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir();
        #[cfg(target_os = "macos")]
        let root = fs::canonicalize(root).expect("macOS test temp root must be canonicalizable");
        root.join(format!(
            "synthv-toolbox-components-{label}-{}",
            Uuid::new_v4()
        ))
    }

    fn write_json(path: &Path, value: &Value) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
    }

    fn local_response(
        body: Vec<u8>,
        content_length: Option<usize>,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            let length_header = content_length
                .map(|length| format!("Content-Length: {length}\r\n"))
                .unwrap_or_default();
            let header = format!(
                "HTTP/1.1 200 OK\r\n{length_header}Content-Type: application/octet-stream\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(header.as_bytes()).unwrap();
            stream.write_all(&body).unwrap();
        });
        (format!("http://{address}/component"), handle)
    }

    #[test]
    fn native_download_atomically_commits_verified_file() {
        let root = temporary_test_root("native-download-success");
        let target = root.join("payload.bin");
        let body = b"trusted component".to_vec();
        let expected = format!("{:x}", Sha256::digest(&body));
        let (url, server) = local_response(body, None);
        assert!(download_verified_file(&url, &target, &expected, 1024).is_ok());
        server.join().unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"trusted component");
        assert!(!fs::read_dir(&root).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".part")
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_download_removes_partial_file_on_hash_error() {
        let root = temporary_test_root("native-download-hash");
        let target = root.join("payload.bin");
        let (url, server) = local_response(b"tampered".to_vec(), None);
        let error = download_verified_file(&url, &target, &"0".repeat(64), 1024).unwrap_err();
        server.join().unwrap();
        assert!(error.contains("SHA-256"));
        assert!(!target.exists());
        assert!(!fs::read_dir(&root).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".part")
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_download_rejects_declared_oversize_before_writing() {
        let root = temporary_test_root("native-download-limit");
        let target = root.join("payload.bin");
        let (url, server) = local_response(b"small".to_vec(), Some(2048));
        let error = download_verified_file(&url, &target, &"0".repeat(64), 1024).unwrap_err();
        server.join().unwrap();
        assert!(error.contains("大小上限"));
        assert!(!target.exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_download_caps_stream_without_content_length_and_cleans_partial() {
        let root = temporary_test_root("native-download-stream-limit");
        let target = root.join("payload.bin");
        let (url, server) = local_response(vec![b'x'; 2048], None);
        let error = download_verified_file(&url, &target, &"0".repeat(64), 1024).unwrap_err();
        server.join().unwrap();
        assert!(error.contains("大小上限"));
        assert!(!target.exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deleting_managed_component_preserves_unrelated_config() {
        let root = temporary_test_root("preserve-config");
        let config = root.join("config.json");
        let component = root.join("components/pi-audio");
        fs::create_dir_all(component.join("venv")).unwrap();
        fs::write(component.join("pi_audio.py"), b"print('ok')").unwrap();
        let managed = managed_component_paths("pi-audio", &root).unwrap();
        write_json(
            &config,
            &json!({
                "provider": "anthropic",
                "anthropic": { "model": "test-model", "auth_token": "secret" },
                "audio": {
                    "python": managed.python.to_string_lossy(),
                    "script": managed.script.to_string_lossy()
                },
                "cvrs": { "python": "other-python", "script": "other-script" }
            }),
        );

        let outcome = remove_local_component_at("pi-audio", &root, &config).unwrap();

        assert_eq!(
            outcome,
            ComponentRemovalOutcome {
                removed_directory: true,
                removed_config: true,
            }
        );
        assert!(!component.exists());
        let value: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        assert!(value.get("audio").is_none());
        assert_eq!(value["provider"], "anthropic");
        assert_eq!(value["anthropic"]["model"], "test-model");
        assert_eq!(value["anthropic"]["auth_token"], "secret");
        assert_eq!(value["cvrs"]["python"], "other-python");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deleting_component_never_deletes_config_referenced_external_paths() {
        let base = temporary_test_root("external-path");
        let root = base.join("managed-data");
        let config = root.join("config.json");
        let component = root.join("components/pi-audio");
        let external = base.join("external-runtime");
        fs::create_dir_all(&component).unwrap();
        fs::write(component.join("pi_audio.py"), b"managed").unwrap();
        fs::create_dir_all(&external).unwrap();
        let external_python = external.join("python");
        let external_script = external.join("pi_audio.py");
        fs::write(&external_python, b"external-python").unwrap();
        fs::write(&external_script, b"external-script").unwrap();
        write_json(
            &config,
            &json!({
                "audio": {
                    "python": external_python.to_string_lossy(),
                    "script": external_script.to_string_lossy()
                }
            }),
        );

        remove_local_component_at("pi-audio", &root, &config).unwrap();

        assert!(!component.exists());
        assert_eq!(fs::read(&external_python).unwrap(), b"external-python");
        assert_eq!(fs::read(&external_script).unwrap(), b"external-script");
        let value: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        assert_eq!(
            value["audio"]["script"].as_str(),
            Some(external_script.to_string_lossy().as_ref())
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn externally_configured_component_is_installed_but_not_removable() {
        let base = temporary_test_root("external-info");
        let root = base.join("managed-data");
        let config = root.join("config.json");
        let external = base.join("external-runtime");
        let resources = base.join("resources");
        fs::create_dir_all(&external).unwrap();
        fs::create_dir_all(&resources).unwrap();
        let external_python = external.join("python");
        let external_script = external.join("pi_audio.py");
        fs::write(&external_python, b"external-python").unwrap();
        fs::write(&external_script, b"external-script").unwrap();
        write_json(
            &config,
            &json!({
                "audio": {
                    "python": external_python.to_string_lossy(),
                    "script": external_script.to_string_lossy()
                }
            }),
        );
        let spec = default_catalog()
            .into_iter()
            .find(|component| component.id == "pi-audio")
            .unwrap();

        let info = component_info_at(spec, &resources, &root, &config);

        assert!(info.installed);
        assert!(!info.removable);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn partial_managed_component_directory_remains_removable() {
        let base = temporary_test_root("partial-managed-info");
        let root = base.join("managed-data");
        let config = root.join("config.json");
        let resources = base.join("resources");
        fs::create_dir_all(root.join("components/cvrs")).unwrap();
        fs::create_dir_all(&resources).unwrap();
        write_json(&config, &json!({}));
        let spec = default_catalog()
            .into_iter()
            .find(|component| component.id == "cvrs")
            .unwrap();

        let info = component_info_at(spec, &resources, &root, &config);

        assert!(!info.installed);
        assert!(info.removable);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn external_unknown_and_traversal_component_ids_are_rejected() {
        let root = temporary_test_root("rejected-ids");
        let config = root.join("config.json");
        let sentinel = root.join("outside.txt");
        fs::create_dir_all(&root).unwrap();
        fs::write(&sentinel, b"keep").unwrap();
        write_json(
            &config,
            &json!({ "audio": { "python": "x", "script": "y" } }),
        );
        let original_config = fs::read(&config).unwrap();

        for id in ["sandboxie", "unknown", "../../outside"] {
            assert!(remove_local_component_at(id, &root, &config).is_err());
        }

        assert_eq!(fs::read(&sentinel).unwrap(), b"keep");
        assert_eq!(fs::read(&config).unwrap(), original_config);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_or_non_object_config_fails_before_directory_is_touched() {
        let root = temporary_test_root("malformed-config");
        let config = root.join("config.json");
        let component = root.join("components/cvrs");
        let sentinel = component.join("cvrs.py");
        fs::create_dir_all(&component).unwrap();
        fs::write(&sentinel, b"keep").unwrap();
        fs::write(&config, b"{not-json").unwrap();

        assert!(remove_local_component_at("cvrs", &root, &config).is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"keep");

        fs::write(&config, b"[]").unwrap();
        assert!(remove_local_component_at("cvrs", &root, &config).is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"keep");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deleting_allowlisted_component_is_idempotent() {
        let root = temporary_test_root("idempotent");
        let config = root.join("config.json");
        write_json(&config, &json!({ "anthropic": { "model": "keep" } }));
        let original_config = fs::read(&config).unwrap();

        let first = remove_local_component_at("pi-audio", &root, &config).unwrap();
        let second = remove_local_component_at("pi-audio", &root, &config).unwrap();

        assert!(!first.changed());
        assert!(!second.changed());
        assert_eq!(fs::read(&config).unwrap(), original_config);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn component_usage_guard_excludes_install_or_remove_writer() {
        fn assert_send<T: Send>() {}
        assert_send::<ComponentUsageGuard>();
        let activity: &'static ComponentActivity = Box::leak(Box::new(ComponentActivity::new()));
        let usage_guard = component_usage_guard_for(activity).unwrap();
        let started = std::sync::Arc::new(AtomicBool::new(false));
        let acquired = std::sync::Arc::new(AtomicBool::new(false));
        let thread_started = started.clone();
        let thread_acquired = acquired.clone();
        let writer = std::thread::spawn(move || {
            thread_started.store(true, Ordering::SeqCst);
            let _guard = component_mutation_guard_for(activity);
            thread_acquired.store(true, Ordering::SeqCst);
        });
        while !started.load(Ordering::SeqCst) {
            std::thread::yield_now();
        }
        while !activity.mutating.load(Ordering::SeqCst) {
            std::thread::yield_now();
        }
        assert!(!acquired.load(Ordering::SeqCst));
        assert!(component_usage_guard_for(activity).is_err());
        drop(usage_guard);
        writer.join().unwrap();
        assert!(acquired.load(Ordering::SeqCst));
    }

    #[test]
    fn parses_only_the_major_and_minor_python_version() {
        assert_eq!(parse_python_version(b"Python 3.11.9\n"), Some((3, 11)));
        assert_eq!(parse_python_version(b"Python 3.14.2\n"), Some((3, 14)));
        assert_eq!(parse_python_version(b"3.11.9\n"), None);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_config_write_preserves_permissions_and_new_files_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let root = temporary_test_root("config-permissions");
        fs::create_dir_all(&root).unwrap();
        let existing = root.join("existing.json");
        fs::write(&existing, b"old").unwrap();
        fs::set_permissions(&existing, fs::Permissions::from_mode(0o640)).unwrap();

        write_config_atomically(&existing, b"updated").unwrap();

        assert_eq!(
            fs::metadata(&existing).unwrap().permissions().mode() & 0o777,
            0o640
        );
        let new_config = root.join("new.json");
        write_config_atomically(&new_config, b"new").unwrap();
        assert_eq!(
            fs::metadata(&new_config).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn managed_component_symlink_is_rejected_without_touching_target() {
        use std::os::unix::fs::symlink;

        let base = temporary_test_root("symlink");
        let root = base.join("managed-data");
        let config = root.join("config.json");
        let external = base.join("external-runtime");
        fs::create_dir_all(root.join("components")).unwrap();
        fs::create_dir_all(&external).unwrap();
        let sentinel = external.join("keep.txt");
        fs::write(&sentinel, b"keep").unwrap();
        symlink(&external, root.join("components/pi-audio")).unwrap();
        write_json(
            &config,
            &json!({ "audio": { "python": "x", "script": "y" } }),
        );

        assert!(remove_local_component_at("pi-audio", &root, &config).is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"keep");
        let value: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        assert!(value.get("audio").is_some());
        fs::remove_file(root.join("components/pi-audio")).unwrap();
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn ffmpeg_archive_manifest_and_paths_are_strictly_allowlisted() {
        let entries = vec![
            "ffmpeg-n8.1.2-50-g1a748fe2cd-win64-lgpl-8.1/bin/ffmpeg.exe".to_string(),
            "ffmpeg-n8.1.2-50-g1a748fe2cd-win64-lgpl-8.1/bin/ffprobe.exe".to_string(),
        ];
        assert_eq!(
            find_archive_binary(&entries, "ffmpeg.exe").unwrap(),
            entries[0]
        );
        assert!(validate_archive_entry("../outside").is_err());
        assert!(validate_archive_entry("C:/outside").is_err());
        assert!(validate_archive_entry("bin/ffmpeg.exe").is_ok());
        assert!(validate_archive_entry_types(
            b"drwxr-xr-x  0 user group 0 Jan 1 00:00 bin/\n-rwxr-xr-x  0 user group 1 Jan 1 00:00 bin/ffmpeg.exe\n"
        )
        .is_ok());
        assert!(validate_archive_entry_types(
            b"lrwxrwxrwx  0 user group 0 Jan 1 00:00 bin/ffmpeg.exe -> ../../outside\n"
        )
        .is_err());
    }

    #[test]
    fn sha256_verification_accepts_only_the_expected_digest() {
        let root = temporary_test_root("sha256");
        fs::create_dir_all(&root).unwrap();
        let file = root.join("fixture.bin");
        fs::write(&file, b"abc").unwrap();
        assert!(verify_sha256(
            &file,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )
        .is_ok());
        assert!(verify_sha256(&file, FFMPEG_ARCHIVE_SHA256).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    fn write_valid_ffmpeg_install(root: &Path) {
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::write(root.join("bin/ffmpeg.exe"), b"ffmpeg").unwrap();
        fs::write(root.join("bin/ffprobe.exe"), b"ffprobe").unwrap();
        fs::write(
            root.join(FFMPEG_MANIFEST_NAME),
            serde_json::to_vec_pretty(&FfmpegInstallManifest {
                schema_version: FFMPEG_MANIFEST_SCHEMA,
                managed_by: FFMPEG_MANAGED_BY.to_string(),
                version: FFMPEG_VERSION.to_string(),
                release_tag: FFMPEG_RELEASE_TAG.to_string(),
                archive: FFMPEG_ARCHIVE_NAME.to_string(),
                sha256: FFMPEG_ARCHIVE_SHA256.to_string(),
                source: "BtbN LGPL".to_string(),
                binaries: ["bin/ffmpeg.exe".to_string(), "bin/ffprobe.exe".to_string()],
            })
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn managed_ffmpeg_manifest_rejects_changed_binary_allowlist() {
        let root = temporary_test_root("ffmpeg-manifest-binaries");
        write_valid_ffmpeg_install(&root);
        let mut manifest: FfmpegInstallManifest =
            serde_json::from_slice(&fs::read(root.join(FFMPEG_MANIFEST_NAME)).unwrap()).unwrap();
        manifest.binaries[1] = "bin/other.exe".to_string();
        fs::write(
            root.join(FFMPEG_MANIFEST_NAME),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        assert!(read_ffmpeg_manifest(&root).is_none());
        assert!(!managed_ffmpeg_directory_exists_at(&root));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn managed_ffmpeg_manifest_never_follows_a_symbolic_link() {
        use std::os::unix::fs::symlink;

        let base = temporary_test_root("ffmpeg-manifest-link");
        let root = base.join("managed");
        write_valid_ffmpeg_install(&root);
        let manifest_path = root.join(FFMPEG_MANIFEST_NAME);
        let external = base.join("external-manifest.json");
        fs::write(&external, fs::read(&manifest_path).unwrap()).unwrap();
        fs::remove_file(&manifest_path).unwrap();
        symlink(&external, &manifest_path).unwrap();
        assert!(read_toolbox_ffmpeg_manifest(&root).is_none());
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn managed_ffmpeg_manifest_never_follows_a_reparse_point_when_available() {
        use std::os::windows::fs::symlink_file;

        let base = temporary_test_root("ffmpeg-manifest-link");
        let root = base.join("managed");
        write_valid_ffmpeg_install(&root);
        let manifest_path = root.join(FFMPEG_MANIFEST_NAME);
        let external = base.join("external-manifest.json");
        fs::write(&external, fs::read(&manifest_path).unwrap()).unwrap();
        fs::remove_file(&manifest_path).unwrap();
        if symlink_file(&external, &manifest_path).is_ok() {
            assert!(read_toolbox_ffmpeg_manifest(&root).is_none());
        }
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn ffmpeg_artifact_cleanup_recovers_only_a_verified_backup() {
        let base = temporary_test_root("ffmpeg-artifact-recovery");
        let components = base.join("components");
        let target = components.join("ffmpeg");
        let backup = components.join(format!(".ffmpeg.backup-{}", Uuid::new_v4()));
        fs::create_dir_all(&components).unwrap();
        write_valid_ffmpeg_install(&backup);

        cleanup_ffmpeg_artifacts(
            &components,
            &target,
            SystemTime::now() + FFMPEG_ARTIFACT_MAX_AGE + Duration::from_secs(1),
        )
        .unwrap();

        assert!(managed_ffmpeg_directory_exists_at(&target));
        assert!(!backup.exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn ffmpeg_artifact_cleanup_preserves_unverified_and_normal_directories() {
        let base = temporary_test_root("ffmpeg-artifact-safety");
        let components = base.join("components");
        let target = components.join("ffmpeg");
        let unverified = components.join(format!(".ffmpeg.backup-{}", Uuid::new_v4()));
        let normal = components.join("ffmpeg-backup");
        let extract = components.join(format!(".ffmpeg.extract-{}", Uuid::new_v4()));
        let install = components.join(format!(".ffmpeg.install-{}", Uuid::new_v4()));
        fs::create_dir_all(unverified.join("bin")).unwrap();
        fs::write(unverified.join("bin/ffmpeg.exe"), b"external").unwrap();
        fs::write(unverified.join("bin/ffprobe.exe"), b"external").unwrap();
        fs::create_dir_all(&normal).unwrap();
        fs::create_dir_all(&extract).unwrap();
        fs::create_dir_all(&install).unwrap();

        cleanup_ffmpeg_artifacts(
            &components,
            &target,
            SystemTime::now() + FFMPEG_ARTIFACT_MAX_AGE + Duration::from_secs(1),
        )
        .unwrap();

        assert!(unverified.exists());
        assert!(normal.exists());
        assert!(!extract.exists());
        assert!(!install.exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn ffmpeg_artifact_names_require_an_exact_uuid_suffix() {
        let root = Path::new("components");
        assert_eq!(
            ffmpeg_artifact_kind(&root.join(format!(".ffmpeg.extract-{}", Uuid::new_v4()))),
            Some(FfmpegArtifactKind::Extract)
        );
        assert!(ffmpeg_artifact_kind(&root.join(".ffmpeg.extract-user-data")).is_none());
        assert!(ffmpeg_artifact_kind(&root.join(".ffmpeg.install-")).is_none());
        assert!(ffmpeg_artifact_kind(&root.join(".ffmpeg.backup-foo/bar")).is_none());
        assert!(ffmpeg_artifact_kind(&root.join("ffmpeg")).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn ffmpeg_artifact_cleanup_never_removes_a_tree_containing_a_symlink() {
        use std::os::unix::fs::symlink;

        let base = temporary_test_root("ffmpeg-artifact-link");
        let components = base.join("components");
        let target = components.join("ffmpeg");
        let artifact = components.join(format!(".ffmpeg.extract-{}", Uuid::new_v4()));
        let external = base.join("external");
        fs::create_dir_all(&components).unwrap();
        fs::create_dir_all(&external).unwrap();
        fs::create_dir_all(&artifact).unwrap();
        symlink(&external, artifact.join("linked")).unwrap();

        cleanup_ffmpeg_artifacts(
            &components,
            &target,
            SystemTime::now() + FFMPEG_ARTIFACT_MAX_AGE + Duration::from_secs(1),
        )
        .unwrap();

        assert!(artifact.exists());
        assert!(external.exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn atomic_ffmpeg_replace_preserves_an_unverified_existing_target() {
        let base = temporary_test_root("ffmpeg-atomic-safety");
        let components = base.join("components");
        let target = components.join("ffmpeg");
        let stage = components.join(format!(".ffmpeg.install-{}", Uuid::new_v4()));
        fs::create_dir_all(target.join("bin")).unwrap();
        fs::write(target.join("bin/ffmpeg.exe"), b"external").unwrap();
        fs::write(target.join("bin/ffprobe.exe"), b"external").unwrap();
        write_valid_ffmpeg_install(&stage);

        let error = atomic_replace_managed_directory(&stage, &target, &components).unwrap_err();

        assert!(error.contains("manifest"));
        assert_eq!(
            fs::read(target.join("bin/ffmpeg.exe")).unwrap(),
            b"external"
        );
        assert!(stage.exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn atomic_ffmpeg_replace_upgrades_a_previous_toolbox_managed_version() {
        let base = temporary_test_root("ffmpeg-atomic-upgrade");
        let components = base.join("components");
        let target = components.join("ffmpeg");
        let stage = components.join(format!(".ffmpeg.install-{}", Uuid::new_v4()));
        write_valid_ffmpeg_install(&target);
        let manifest_path = target.join(FFMPEG_MANIFEST_NAME);
        let mut previous: FfmpegInstallManifest =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        previous.version = "previous-version".to_string();
        previous.release_tag = "previous-release".to_string();
        previous.archive = "previous-lgpl.zip".to_string();
        previous.sha256 = "0".repeat(64);
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&previous).unwrap(),
        )
        .unwrap();
        assert!(toolbox_managed_ffmpeg_directory_exists_at(&target));
        assert!(!managed_ffmpeg_directory_exists_at(&target));

        write_valid_ffmpeg_install(&stage);
        atomic_replace_managed_directory(&stage, &target, &components).unwrap();

        assert!(managed_ffmpeg_directory_exists_at(&target));
        assert!(!stage.exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    #[test]
    fn managed_ffmpeg_directory_is_removable_but_external_sources_are_not() {
        let base = temporary_test_root("ffmpeg-removal");
        let root = base.join("managed-data");
        let config = root.join("config.json");
        let target = managed_ffmpeg_directory(&root);
        fs::create_dir_all(target.join("bin")).unwrap();
        fs::write(target.join("bin/ffmpeg.exe"), b"ffmpeg").unwrap();
        fs::write(target.join("bin/ffprobe.exe"), b"ffprobe").unwrap();
        fs::write(
            target.join(FFMPEG_MANIFEST_NAME),
            serde_json::to_vec_pretty(&FfmpegInstallManifest {
                schema_version: FFMPEG_MANIFEST_SCHEMA,
                managed_by: FFMPEG_MANAGED_BY.to_string(),
                version: FFMPEG_VERSION.to_string(),
                release_tag: FFMPEG_RELEASE_TAG.to_string(),
                archive: FFMPEG_ARCHIVE_NAME.to_string(),
                sha256: FFMPEG_ARCHIVE_SHA256.to_string(),
                source: "BtbN LGPL".to_string(),
                binaries: ["bin/ffmpeg.exe".to_string(), "bin/ffprobe.exe".to_string()],
            })
            .unwrap(),
        )
        .unwrap();
        write_json(&config, &json!({ "provider": "keep" }));

        let outcome = remove_local_component_at("ffmpeg", &root, &config).unwrap();

        assert!(outcome.removed_directory);
        assert!(!target.exists());
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&config).unwrap()).unwrap()["provider"],
            "keep"
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn unmanaged_ffmpeg_directory_is_never_deleted() {
        let base = temporary_test_root("ffmpeg-unmanaged-removal");
        let root = base.join("managed-data");
        let config = root.join("config.json");
        let target = managed_ffmpeg_directory(&root);
        fs::create_dir_all(target.join("bin")).unwrap();
        fs::write(target.join("bin/ffmpeg.exe"), b"external").unwrap();
        fs::write(target.join("bin/ffprobe.exe"), b"external").unwrap();
        write_json(&config, &json!({}));

        assert!(remove_local_component_at("ffmpeg", &root, &config).is_err());
        assert!(target.exists());

        fs::remove_dir_all(base).unwrap();
    }
}
