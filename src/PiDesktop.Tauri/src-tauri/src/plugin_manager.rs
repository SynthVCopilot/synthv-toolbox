use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use semver::Version;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zip::ZipArchive;

const HOST_API_VERSION: &str = "1.0";
const STATE_FILE: &str = ".toolbox-plugin-state.json";
const MAX_ARCHIVE_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 2_048;
const PERMISSIONS: [&str; 7] = [
    "agent.tools",
    "host.advanced",
    "host.internal",
    "host.read",
    "host.execute",
    "project.read",
    "project.write",
];

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub schema_version: u8,
    pub id: String,
    pub name: String,
    pub version: String,
    pub host_api: VersionRange,
    #[serde(default)]
    pub backend: Option<PluginBackend>,
    #[serde(default)]
    pub pages: Vec<PluginPage>,
    #[serde(default)]
    pub actions: Vec<PluginAction>,
    #[serde(default)]
    pub permissions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VersionRange {
    pub min: String,
    pub max: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PluginBackend {
    pub entry: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PluginPage {
    pub id: String,
    pub title: String,
    pub entry: String,
    #[serde(default)]
    pub icon: Option<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PluginAction {
    pub id: String,
    pub location: String,
    pub title: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub when_capability: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub manifest: PluginManifest,
    pub enabled: bool,
    pub internal_functions_enabled: bool,
    pub advanced_functions_enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginState {
    #[serde(default = "default_enabled")]
    enabled: bool,
    #[serde(default)]
    internal_functions_enabled: bool,
    #[serde(default)]
    advanced_functions_enabled: bool,
}

impl Default for PluginState {
    fn default() -> Self {
        Self {
            enabled: true,
            internal_functions_enabled: false,
            advanced_functions_enabled: false,
        }
    }
}

fn default_enabled() -> bool {
    true
}

pub fn plugins_root() -> PathBuf {
    crate::agent::data_root().join("plugins")
}

pub fn list(root: &Path) -> Result<Vec<InstalledPlugin>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut plugins = Vec::new();
    for entry in fs::read_dir(root).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        if !entry.file_type().map_err(io_error)?.is_dir() {
            continue;
        }
        let path = entry.path();
        reject_symlink(&path)?;
        let manifest = match read_manifest(&path) {
            Ok(manifest) => manifest,
            Err(_) => continue,
        };
        plugins.push(installed_plugin(manifest, read_state(&path)?));
    }
    plugins.sort_by(|left, right| left.manifest.name.cmp(&right.manifest.name));
    Ok(plugins)
}

pub fn install(source: &Path, root: &Path) -> Result<InstalledPlugin, String> {
    let metadata = fs::symlink_metadata(source).map_err(io_error)?;
    if metadata.file_type().is_symlink() {
        return Err("插件安装源不能是符号链接。".to_string());
    }
    fs::create_dir_all(root).map_err(io_error)?;
    let staging = root.join(format!(".staging-{}", Uuid::new_v4()));
    fs::create_dir(&staging).map_err(io_error)?;
    let result = (|| {
        if metadata.is_dir() {
            copy_tree(source, &staging)?;
        } else if source
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("zip"))
        {
            extract_zip(source, &staging)?;
        } else {
            return Err("请选择插件目录或 .zip 安装包。".to_string());
        }
        let manifest = read_manifest(&staging)?;
        let target = root.join(&manifest.id);
        replace_directory(&staging, &target)?;
        let state = PluginState::default();
        write_state(&target, &state)?;
        Ok(installed_plugin(manifest, state))
    })();
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

pub fn set_enabled(root: &Path, plugin_id: &str, enabled: bool) -> Result<InstalledPlugin, String> {
    let path = plugin_path(root, plugin_id)?;
    let manifest = read_manifest(&path)?;
    let mut state = read_state(&path)?;
    state.enabled = enabled;
    write_state(&path, &state)?;
    Ok(installed_plugin(manifest, state))
}

pub fn set_internal_functions_enabled(
    root: &Path,
    plugin_id: &str,
    enabled: bool,
) -> Result<InstalledPlugin, String> {
    let path = plugin_path(root, plugin_id)?;
    let manifest = read_manifest(&path)?;
    if enabled
        && !manifest
            .permissions
            .iter()
            .any(|value| value == "host.internal")
    {
        return Err("插件未声明内部函数权限。".to_string());
    }
    let mut state = read_state(&path)?;
    state.internal_functions_enabled = enabled;
    write_state(&path, &state)?;
    Ok(installed_plugin(manifest, state))
}

pub fn set_advanced_functions_enabled(
    root: &Path,
    plugin_id: &str,
    enabled: bool,
) -> Result<InstalledPlugin, String> {
    let path = plugin_path(root, plugin_id)?;
    let manifest = read_manifest(&path)?;
    if enabled
        && !manifest
            .permissions
            .iter()
            .any(|value| value == "host.advanced")
    {
        return Err("插件未声明高级功能权限。".to_string());
    }
    let mut state = read_state(&path)?;
    state.advanced_functions_enabled = enabled;
    write_state(&path, &state)?;
    Ok(installed_plugin(manifest, state))
}

pub fn authorize_capability(
    root: &Path,
    plugin_id: &str,
    permission: &str,
    internal_functions_globally_enabled: bool,
    advanced_functions_globally_enabled: bool,
) -> Result<(), String> {
    let path = plugin_path(root, plugin_id)?;
    let manifest = read_manifest(&path)?;
    let state = read_state(&path)?;
    if !state.enabled {
        return Err("插件已停用。".to_string());
    }
    if !manifest
        .permissions
        .iter()
        .any(|declared| declared == permission)
    {
        return Err("插件未声明该宿主权限。".to_string());
    }
    match permission {
        "host.internal" if !internal_functions_globally_enabled => {
            Err("设置中尚未启用插件内部函数。".to_string())
        }
        "host.internal" if !state.internal_functions_enabled => {
            Err("尚未为此插件启用内部函数。".to_string())
        }
        "host.advanced" if !advanced_functions_globally_enabled => {
            Err("设置中尚未启用插件高级功能。".to_string())
        }
        "host.advanced" if !state.advanced_functions_enabled => {
            Err("尚未为此插件启用高级功能。".to_string())
        }
        _ => Ok(()),
    }
}

pub fn uninstall(root: &Path, plugin_id: &str) -> Result<(), String> {
    let path = plugin_path(root, plugin_id)?;
    reject_symlink(&path)?;
    fs::remove_dir_all(path).map_err(io_error)
}

fn read_manifest(root: &Path) -> Result<PluginManifest, String> {
    reject_symlink(root)?;
    let manifest_path = root.join("manifest.json");
    reject_symlink(&manifest_path)?;
    let manifest =
        serde_json::from_slice::<PluginManifest>(&fs::read(&manifest_path).map_err(io_error)?)
            .map_err(|error| format!("插件 manifest 无效：{error}"))?;
    validate_manifest(&manifest, root)?;
    Ok(manifest)
}

fn validate_manifest(manifest: &PluginManifest, root: &Path) -> Result<(), String> {
    if manifest.schema_version != 1
        || !is_plugin_id(&manifest.id)
        || manifest.name.trim().is_empty()
        || Version::parse(&manifest.version).is_err()
    {
        return Err("插件 manifest 的标识、名称、版本或 schemaVersion 无效。".to_string());
    }
    if !api_compatible(&manifest.host_api)? {
        return Err(format!(
            "插件要求的 Host API {}-{} 与当前 {} 不兼容。",
            manifest.host_api.min, manifest.host_api.max, HOST_API_VERSION
        ));
    }
    if let Some(backend) = &manifest.backend {
        validate_entry(root, &backend.entry)?;
    }
    let mut page_ids = HashSet::new();
    for page in &manifest.pages {
        if !is_contribution_id(&page.id)
            || !page_ids.insert(&page.id)
            || page.title.trim().is_empty()
        {
            return Err("插件页面声明无效。".to_string());
        }
        validate_entry(root, &page.entry)?;
    }
    let mut action_ids = HashSet::new();
    for action in &manifest.actions {
        if !is_contribution_id(&action.id)
            || !action_ids.insert(&action.id)
            || action.title.trim().is_empty()
            || !matches!(
                action.location.as_str(),
                "home.toolbar" | "project.toolbar" | "project.context" | "conversation.toolbar"
            )
        {
            return Err("插件操作声明无效。".to_string());
        }
    }
    let mut permissions = HashSet::new();
    if manifest.permissions.iter().any(|permission| {
        !PERMISSIONS.contains(&permission.as_str()) || !permissions.insert(permission)
    }) {
        return Err("插件权限声明无效。".to_string());
    }
    Ok(())
}

fn api_compatible(range: &VersionRange) -> Result<bool, String> {
    let parse = |value: &str| {
        Version::parse(&format!("{value}.0")).map_err(|_| "Host API 版本范围无效。".to_string())
    };
    let min = parse(&range.min)?;
    let max = parse(&range.max)?;
    let host = parse(HOST_API_VERSION)?;
    Ok(min <= host && host <= max)
}

fn validate_entry(root: &Path, entry: &str) -> Result<(), String> {
    let relative = safe_relative(entry)?;
    let path = root.join(relative);
    reject_symlink(&path)?;
    if !path.is_file() {
        return Err(format!("插件入口不存在：{entry}"));
    }
    Ok(())
}

fn plugin_path(root: &Path, plugin_id: &str) -> Result<PathBuf, String> {
    if !is_plugin_id(plugin_id) {
        return Err("插件标识无效。".to_string());
    }
    let path = root.join(plugin_id);
    if !path.is_dir() {
        return Err("未找到插件。".to_string());
    }
    Ok(path)
}
fn safe_relative(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("插件入口必须是安全的相对路径。".to_string());
    }
    Ok(path.to_path_buf())
}
fn reject_symlink(path: &Path) -> Result<(), String> {
    if fs::symlink_metadata(path)
        .map_err(io_error)?
        .file_type()
        .is_symlink()
    {
        Err("插件不能包含符号链接。".to_string())
    } else {
        Ok(())
    }
}
fn is_plugin_id(value: &str) -> bool {
    value.split('.').count() >= 2
        && value.split('.').all(|segment| {
            !segment.is_empty()
                && segment.chars().all(|value| {
                    value.is_ascii_lowercase() || value.is_ascii_digit() || value == '-'
                })
        })
}
fn is_contribution_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == '-')
}
fn io_error(error: io::Error) -> String {
    error.to_string()
}

fn installed_plugin(manifest: PluginManifest, state: PluginState) -> InstalledPlugin {
    InstalledPlugin {
        manifest,
        enabled: state.enabled,
        internal_functions_enabled: state.internal_functions_enabled,
        advanced_functions_enabled: state.advanced_functions_enabled,
    }
}

fn read_state(root: &Path) -> Result<PluginState, String> {
    let path = root.join(STATE_FILE);
    if !path.exists() {
        return Ok(PluginState::default());
    }
    reject_symlink(&path)?;
    serde_json::from_slice::<PluginState>(&fs::read(path).map_err(io_error)?)
        .map_err(|error| format!("插件状态无效：{error}"))
}
fn write_state(root: &Path, state: &PluginState) -> Result<(), String> {
    let target = root.join(STATE_FILE);
    let temporary = root.join(format!("{STATE_FILE}.{}", Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec(state).map_err(|error| error.to_string())?,
    )
    .map_err(io_error)?;
    fs::rename(temporary, target).map_err(io_error)
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let source_path = entry.path();
        let target_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path).map_err(io_error)?;
        if metadata.file_type().is_symlink() {
            return Err("插件不能包含符号链接。".to_string());
        }
        if metadata.is_dir() {
            fs::create_dir(&target_path).map_err(io_error)?;
            copy_tree(&source_path, &target_path)?;
        } else if metadata.is_file() {
            fs::copy(&source_path, &target_path).map_err(io_error)?;
        }
    }
    Ok(())
}

fn extract_zip(source: &Path, destination: &Path) -> Result<(), String> {
    let file = fs::File::open(source).map_err(io_error)?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("插件 ZIP 无效：{error}"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("插件 ZIP 包含过多文件。".to_string());
    }
    let mut total_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if entry.is_symlink() {
            return Err("插件 ZIP 不能包含符号链接。".to_string());
        }
        if entry.size() > MAX_ARCHIVE_FILE_BYTES {
            return Err("插件 ZIP 包含过大的文件。".to_string());
        }
        total_bytes = total_bytes
            .checked_add(entry.size())
            .ok_or_else(|| "插件 ZIP 解压大小无效。".to_string())?;
        if total_bytes > MAX_ARCHIVE_TOTAL_BYTES {
            return Err("插件 ZIP 解压后过大。".to_string());
        }
        let path = entry
            .enclosed_name()
            .ok_or_else(|| "插件 ZIP 包含不安全路径。".to_string())?
            .to_path_buf();
        if path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("插件 ZIP 包含不安全路径。".to_string());
        }
        let target = destination.join(path);
        if entry.is_dir() {
            fs::create_dir_all(target).map_err(io_error)?;
        } else {
            let parent = target
                .parent()
                .ok_or_else(|| "插件 ZIP 路径无效。".to_string())?;
            fs::create_dir_all(parent).map_err(io_error)?;
            let mut output = fs::File::create(target).map_err(io_error)?;
            io::copy(&mut entry, &mut output).map_err(io_error)?;
        }
    }
    Ok(())
}

fn replace_directory(staging: &Path, target: &Path) -> Result<(), String> {
    let backup = target.with_extension(format!("backup-{}", Uuid::new_v4()));
    let had_target = target.exists();
    if had_target {
        fs::rename(target, &backup).map_err(io_error)?;
    }
    if let Err(error) = fs::rename(staging, target) {
        if had_target {
            let _ = fs::rename(&backup, target);
        }
        return Err(io_error(error));
    }
    if had_target {
        fs::remove_dir_all(backup).map_err(io_error)?;
    }
    Ok(())
}
