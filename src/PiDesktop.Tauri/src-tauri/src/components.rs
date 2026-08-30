use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{RwLock, RwLockReadGuard};

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
static COMPONENT_MUTATION_LOCK: RwLock<()> = RwLock::new(());

pub(crate) type ComponentUsageGuard = RwLockReadGuard<'static, ()>;

pub(crate) fn component_usage_guard() -> Result<ComponentUsageGuard, String> {
    COMPONENT_MUTATION_LOCK
        .read()
        .map_err(|_| "组件使用锁已损坏。请重启 SynthV Toolbox 后重试。".to_string())
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
        .filter(|component| matches!(component.id.as_str(), "ffmpeg" | "pi-audio" | "cvrs"))
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
        "ffmpeg" => {
            bundled_binary(resource_root, "ffmpeg").is_some() || command_available("ffmpeg")
        }
        "pi-audio" => configured_component_at("audio", config_path),
        "cvrs" => configured_component_at("cvrs", config_path),
        _ => false,
    };
    let id = component.id;
    let removable = managed_component_paths(&id, managed_data_root)
        .ok()
        .is_some_and(|managed| {
            managed_component_directory_exists(&managed.target)
                || config_references_managed_component(config_path, &managed)
        });
    let installable = installed || matches!(id.as_str(), "pi-audio" | "cvrs");
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
        downloaded: false,
        status: if installed {
            "已就绪".to_string()
        } else if installable {
            "可通过 aria2 下载".to_string()
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
    let _mutation_guard = match COMPONENT_MUTATION_LOCK.write() {
        Ok(guard) => guard,
        Err(_) => return failed("组件操作锁已损坏。", "请重启 SynthV Toolbox 后重试。"),
    };
    match id {
        "ffmpeg" => {
            progress("installing", 80, "正在检查系统或应用内 FFmpeg。");
            if bundled_binary(resource_root, "ffmpeg").is_some() || command_available("ffmpeg") {
                succeeded("FFmpeg 已可用。", "已发现应用内或系统 FFmpeg。")
            } else {
                failed(
                    "当前平台包未包含 FFmpeg。",
                    "为避免不可信下载，应用不会自动安装未锁定哈希的二进制。请安装 FFmpeg，或在发布构建中提供对应平台的签名资源。",
                )
            }
        }
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
    let _mutation_guard = match COMPONENT_MUTATION_LOCK.write() {
        Ok(guard) => guard,
        Err(_) => return failed("组件操作锁已损坏。", "请重启 SynthV Toolbox 后重试。"),
    };
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
        "ffmpeg" | "sandboxie" => {
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
            "可通过 aria2 下载官方 x64 安装包".to_string()
        } else {
            "仅适用于 Windows x64".to_string()
        },
    }
}

fn download_sandboxie_installer<F>(resource_root: &Path, progress: &mut F) -> OperationResult
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
    let Some(aria2) = find_aria2(resource_root) else {
        return failed(
            "未找到 aria2c。",
            "请安装 aria2，或设置 SYNTHV_TOOLBOX_ARIA2 指向 aria2c。",
        );
    };
    progress(
        "downloading",
        12,
        &format!("aria2 正在下载 Sandboxie Plus {SANDBOXIE_VERSION} 官方安装包。"),
    );
    let payload = ComponentPayload {
        name: SANDBOXIE_INSTALLER_NAME,
        relative_url: "",
        sha256: SANDBOXIE_INSTALLER_SHA256,
    };
    if let Err(error) = download_with_aria2(&aria2, SANDBOXIE_INSTALLER_URL, &directory, &payload) {
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

fn download_component_source<F>(
    id: &str,
    resource_root: &Path,
    progress: &mut F,
) -> Result<PathBuf, String>
where
    F: FnMut(&str, u8, &str),
{
    let payloads = match id {
        "pi-audio" => PI_AUDIO_PAYLOADS,
        "cvrs" => CVRS_PAYLOADS,
        _ => return Err("该组件没有受信任的 aria2 下载清单。".to_string()),
    };
    let aria2 = find_aria2(resource_root).ok_or_else(|| {
        "未找到 aria2c。请安装 aria2（Windows 可使用 winget/choco，macOS 可使用 Homebrew），或设置 SYNTHV_TOOLBOX_ARIA2 指向 aria2c。".to_string()
    })?;
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
            &format!("aria2 正在下载 {}。", payload.name),
        );
        let url = format!(
            "https://raw.githubusercontent.com/SynthVCopilot/pi-agent/{PI_AGENT_COMPONENT_REVISION}/{}",
            payload.relative_url
        );
        download_with_aria2(&aria2, &url, &cache, payload)?;
        let complete = 8 + (((index + 1) * 48) / payloads.len()) as u8;
        progress(
            "downloading",
            complete,
            &format!("{} 已通过 SHA-256 校验。", payload.name),
        );
    }
    Ok(cache)
}

fn find_aria2(resource_root: &Path) -> Option<PathBuf> {
    if let Some(configured) = std::env::var_os("SYNTHV_TOOLBOX_ARIA2").map(PathBuf::from) {
        if configured.is_file() {
            return Some(configured);
        }
    }
    let bundled = if cfg!(windows) {
        resource_root.join("download-tools/windows/aria2c.exe")
    } else {
        resource_root.join("download-tools/macos/aria2c")
    };
    if bundled.is_file() {
        return Some(bundled);
    }
    quiet_command("aria2c")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
        .then(|| PathBuf::from("aria2c"))
}

fn download_with_aria2(
    aria2: &Path,
    url: &str,
    directory: &Path,
    payload: &ComponentPayload,
) -> Result<(), String> {
    let output = quiet_command(aria2)
        .args([
            "--allow-overwrite=true",
            "--auto-file-renaming=false",
            "--check-certificate=true",
            "--console-log-level=warn",
            "--continue=true",
            "--download-result=hide",
            "--file-allocation=none",
            "--max-connection-per-server=8",
            "--min-split-size=1M",
        ])
        .arg(format!("--checksum=sha-256={}", payload.sha256))
        .arg("--dir")
        .arg(directory)
        .arg("--out")
        .arg(payload.name)
        .arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("无法启动 aria2c：{error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(1600)
            .collect::<String>();
        return Err(format!(
            "aria2c 下载 {} 失败（退出码 {:?}）：{}",
            payload.name,
            output.status.code(),
            detail.trim()
        ));
    }
    verify_sha256(&directory.join(payload.name), payload.sha256)
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

fn command_available(command: &str) -> bool {
    quiet_command(command)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn bundled_binary(resource_root: &Path, name: &str) -> Option<PathBuf> {
    let filename = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let candidate = resource_root.join("ffmpeg").join(filename);
    candidate.is_file().then_some(candidate)
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

    fn temporary_test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "synthv-toolbox-components-{label}-{}",
            Uuid::new_v4()
        ))
    }

    fn write_json(path: &Path, value: &Value) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
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

        for id in ["ffmpeg", "sandboxie", "unknown", "../../outside"] {
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
        let usage_guard = component_usage_guard().unwrap();
        assert!(COMPONENT_MUTATION_LOCK.try_write().is_err());

        drop(usage_guard);
        assert!(COMPONENT_MUTATION_LOCK.try_write().is_ok());
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
}
