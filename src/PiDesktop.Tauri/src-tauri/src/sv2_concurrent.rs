use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::synthv::{quiet_command, succeeded, OperationResult};

const CONCURRENT_SCHEMA_VERSION: u32 = 1;
const CONCURRENT_MARKER_FILE: &str = ".synthv-toolbox-concurrent.json";
// Sandboxie uses `-` (rather than a boolean `n`) for "do not alter the title".
const BOX_NAME_TITLE_SETTING: &str = "-";
#[cfg(windows)]
const PROVIDER_ENV: &str = "SV2_TOOLBOX_SANDBOXIE_HOME";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2ConcurrentProviderView {
    pub available: bool,
    pub name: String,
    pub edition: String,
    pub version: String,
    pub install_path: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2ConcurrentSlotView {
    pub ready: bool,
    pub data_path: String,
    pub running_pids: Vec<u32>,
    pub detail: String,
    pub content: Sv2ConcurrentContentView,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Sv2IsolationPreference {
    #[default]
    Global,
    On,
    Off,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2ConcurrentDefaults {
    pub app_settings: bool,
    pub voice_libraries: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2ConcurrentContentPreferences {
    pub app_settings: Sv2IsolationPreference,
    pub voice_libraries: Sv2IsolationPreference,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2ConcurrentContentView {
    pub app_settings: Sv2IsolationPreference,
    pub voice_libraries: Sv2IsolationPreference,
    pub effective_app_settings: bool,
    pub effective_voice_libraries: bool,
}

impl Sv2ConcurrentContentPreferences {
    pub fn resolve(self, _defaults: Sv2ConcurrentDefaults) -> Sv2ConcurrentContentView {
        Sv2ConcurrentContentView {
            // Sessions and settings remain per-environment; only voice data is shared.
            app_settings: Sv2IsolationPreference::On,
            voice_libraries: Sv2IsolationPreference::Off,
            effective_app_settings: true,
            effective_voice_libraries: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SandboxieProvider {
    start: PathBuf,
    sbie_ini: PathBuf,
    version: (u16, u16, u16, u16),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConcurrentMarker {
    schema_version: u32,
    slot_id: String,
    box_name: String,
}

pub fn detect_provider() -> Result<SandboxieProvider, String> {
    #[cfg(not(windows))]
    return Err("并发隔离当前仅支持 Windows。".to_string());

    #[cfg(windows)]
    {
        let mut homes = Vec::<PathBuf>::new();
        if let Some(path) = std::env::var_os(PROVIDER_ENV) {
            homes.push(PathBuf::from(path));
        }
        for variable in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(variable).map(PathBuf::from) {
                homes.push(root.join("Sandboxie-Plus"));
                homes.push(root.join("Sandboxie"));
            }
        }
        homes.sort();
        homes.dedup();
        for home in homes {
            if !home.is_absolute() {
                continue;
            }
            let start = home.join("Start.exe");
            let sbie_ini = home.join("SbieIni.exe");
            if start.is_file() && sbie_ini.is_file() {
                let version = file_version(&start)?;
                if !supported_provider_version(version) {
                    return Err(format!(
                        "检测到 Sandboxie {}，但并发模式至少需要 Plus 1.17.6 / Classic 5.72.6（该版本修复了关键隔离安全问题）。",
                        format_version(version)
                    ));
                }
                return Ok(SandboxieProvider {
                    start,
                    sbie_ini,
                    version,
                });
            }
        }
        Err(format!(
            "未检测到 Sandboxie Plus / Classic。安装后重启工具箱，或将 {PROVIDER_ENV} 设置为包含 Start.exe 和 SbieIni.exe 的目录。"
        ))
    }
}

pub fn provider_view(provider: &Result<SandboxieProvider, String>) -> Sv2ConcurrentProviderView {
    match provider {
        Ok(provider) => Sv2ConcurrentProviderView {
            available: true,
            name: provider_name(provider.version).to_string(),
            edition: provider_edition(provider.version).to_string(),
            version: format_version(provider.version),
            install_path: provider
                .start
                .parent()
                .unwrap_or(&provider.start)
                .to_string_lossy()
                .into_owned(),
            detail: "隔离核心已就绪，可以为不同账号槽位运行相互独立的 SV2 实例。".to_string(),
        },
        Err(detail) => Sv2ConcurrentProviderView {
            available: false,
            name: "Sandboxie Plus / Classic".to_string(),
            edition: String::new(),
            version: String::new(),
            install_path: String::new(),
            detail: detail.clone(),
        },
    }
}

pub fn slot_view(
    vault: &Path,
    slot_id: &str,
    provider: Option<&SandboxieProvider>,
    content: Sv2ConcurrentContentView,
) -> Sv2ConcurrentSlotView {
    let box_name = box_name(slot_id).unwrap_or_else(|_| "invalid".to_string());
    let box_root = existing_box_root(vault, slot_id);
    let data_path = virtual_data_root(&box_root);
    let status = validate_prepared(&box_root, slot_id, &box_name);
    let (ready, detail) = match status {
        Ok(()) => (
            true,
            "隔离副本已准备；本地变化不会自动覆盖普通槽位。".to_string(),
        ),
        Err(_error) if !box_root.exists() => (false, "尚未准备隔离副本。".to_string()),
        Err(error) => (false, error),
    };
    let running_pids = if ready {
        provider
            .and_then(|provider| list_pids(provider, &box_name).ok())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    Sv2ConcurrentSlotView {
        ready,
        data_path: data_path.to_string_lossy().into_owned(),
        running_pids,
        detail,
        content,
    }
}

pub fn prepare_slot(
    provider: &SandboxieProvider,
    vault: &Path,
    source: &Path,
    shared_data_root: &Path,
    slot_id: &str,
    content: Sv2ConcurrentContentView,
) -> Result<(), String> {
    let name = box_name(slot_id)?;
    migrate_legacy_box(vault, slot_id, &name)?;
    let concurrent_root = vault.join("c");
    let final_root = box_root(vault, slot_id);
    let slot_root = final_root
        .parent()
        .ok_or_else(|| "隔离副本路径无效。".to_string())?;
    reject_reparse_point(vault)?;
    reject_reparse_point(&concurrent_root)?;
    reject_reparse_point(slot_root)?;
    reject_reparse_point(&final_root)?;
    reject_reparse_point(source)?;
    if !source.is_dir() {
        return Err("槽位源数据目录不存在。".to_string());
    }

    if final_root.exists() {
        validate_prepared(&final_root, slot_id, &name)?;
        remove_copied_database(&final_root)?;
        configure_box(provider, &name, &final_root, shared_data_root, content)?;
        return Ok(());
    }

    fs::create_dir_all(slot_root).map_err(|error| format!("无法创建并发槽位目录：{error}"))?;
    reject_reparse_point(slot_root)?;
    let staging = slot_root.join(format!(".staging-{}", Uuid::new_v4()));
    let staged_data = virtual_data_root(&staging);
    let result = (|| {
        copy_slot_tree(source, &staged_data)?;
        write_marker(
            &staging,
            &ConcurrentMarker {
                schema_version: CONCURRENT_SCHEMA_VERSION,
                slot_id: slot_id.to_string(),
                box_name: name.clone(),
            },
        )?;
        fs::rename(&staging, &final_root)
            .map_err(|error| format!("无法提交并发槽位副本：{error}"))?;
        remove_copied_database(&final_root)?;
        configure_box(provider, &name, &final_root, shared_data_root, content)
    })();
    if result.is_err() {
        cleanup_staging(&staging, slot_root);
    }
    result
}

pub fn launch_slot(
    provider: &SandboxieProvider,
    vault: &Path,
    slot_id: &str,
    executable: &Path,
    project: Option<&Path>,
    shared_data_root: &Path,
    content: Sv2ConcurrentContentView,
) -> Result<OperationResult, String> {
    let name = box_name(slot_id)?;
    migrate_legacy_box(vault, slot_id, &name)?;
    let root = box_root(vault, slot_id);
    validate_prepared(&root, slot_id, &name)?;
    remove_copied_database(&root)?;
    configure_box(provider, &name, &root, shared_data_root, content)?;
    let pids = list_pids(provider, &name)?;
    if !pids.is_empty() {
        return Err(format!(
            "槽位的隔离实例已在运行（PID：{}）。",
            pids.iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    let mut command = quiet_command(&provider.start);
    command
        .arg(sandbox_box_argument(&name))
        .arg("/silent")
        .arg(executable);
    if let Some(project) = project {
        command.arg(project);
    }
    let output = command
        .output()
        .map_err(|error| format!("无法调用 Sandboxie：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Sandboxie 启动失败（退出码 {:?}）：{}",
            output.status.code(),
            command_detail(&output.stdout, &output.stderr)
        ));
    }
    Ok(succeeded(
        "已在独立文件、注册表和 IPC 命名空间中启动 SV2。",
        "隔离实例已启动。".to_string(),
    ))
}

#[cfg(windows)]
pub fn concurrent_folder(vault: &Path, slot_id: &str) -> Result<PathBuf, String> {
    let name = box_name(slot_id)?;
    let root = existing_box_root(vault, slot_id);
    validate_prepared(&root, slot_id, &name)?;
    Ok(virtual_data_root(&root))
}

pub fn remove_slot_data(vault: &Path, slot_id: &str) -> Result<(), String> {
    let name = box_name(slot_id)?;
    remove_prepared_box(&box_root(vault, slot_id), slot_id, &name)?;
    remove_prepared_box(&legacy_box_root(vault, slot_id), slot_id, &name)
}

fn migrate_legacy_box(vault: &Path, slot_id: &str, box_name: &str) -> Result<(), String> {
    let legacy = legacy_box_root(vault, slot_id);
    let short = box_root(vault, slot_id);
    if !legacy.exists() || short.exists() {
        return Ok(());
    }
    validate_prepared(&legacy, slot_id, box_name)?;
    let parent = short
        .parent()
        .ok_or_else(|| "隔离副本路径无效。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建短隔离路径：{error}"))?;
    fs::rename(&legacy, &short).map_err(|error| format!("无法迁移隔离副本到短路径：{error}"))
}

fn remove_prepared_box(root: &Path, slot_id: &str, box_name: &str) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    validate_prepared(root, slot_id, box_name)?;
    fs::remove_dir_all(root).map_err(|error| format!("无法删除隔离副本：{error}"))
}

fn remove_copied_database(root: &Path) -> Result<(), String> {
    let database = virtual_data_root(root).join("databases");
    if !database.exists() {
        return Ok(());
    }
    assert_tree_has_no_reparse_points(&database)?;
    fs::remove_dir_all(&database).map_err(|error| format!("无法移除隔离副本中的重复声库：{error}"))
}

fn assert_tree_has_no_reparse_points(path: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("无法检查隔离副本内容：{error}"))?;
    reject_reparse_metadata(path, &metadata)?;
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|error| format!("无法读取隔离副本内容：{error}"))?
        {
            let entry = entry.map_err(|error| format!("无法读取隔离副本目录项：{error}"))?;
            assert_tree_has_no_reparse_points(&entry.path())?;
        }
    }
    Ok(())
}

fn configure_box(
    provider: &SandboxieProvider,
    box_name: &str,
    root: &Path,
    shared_data_root: &Path,
    content: Sv2ConcurrentContentView,
) -> Result<(), String> {
    let root_value = root.to_string_lossy().into_owned();
    if root_value
        .chars()
        .any(|character| character == '\r' || character == '\n' || character == '\0')
    {
        return Err("Sandboxie 容器路径包含不允许的控制字符。".to_string());
    }
    for (setting, value) in [
        ("Enabled", "y"),
        ("FileRootPath", root_value.as_str()),
        ("KeyRootPath", r"\REGISTRY\USER\Sandbox_%USER%_%SANDBOX%"),
        (
            "IpcRootPath",
            r"\Sandbox\%USER%\%SANDBOX%\Session_%SESSION%",
        ),
        ("SeparateUserFolders", "y"),
        ("AutoRecover", "n"),
        ("NeverDelete", "y"),
        ("BoxNameTitle", BOX_NAME_TITLE_SETTING),
        ("ConfigLevel", "10"),
        ("UseFileDeleteV2", "y"),
        ("UseRegDeleteV2", "y"),
    ] {
        run_checked(
            quiet_command(&provider.sbie_ini)
                .arg("set")
                .arg(box_name)
                .arg(setting)
                .arg(value),
            &format!("无法配置 Sandboxie 设置 {setting}"),
        )?;
    }
    configure_shared_content(provider, box_name, shared_data_root, content)?;
    run_checked(
        quiet_command(&provider.start).arg("/silent").arg("/reload"),
        "无法让 Sandboxie 重新载入配置",
    )?;

    let output = quiet_command(&provider.sbie_ini)
        .arg("queryex")
        .arg(box_name)
        .arg("FileRootPath")
        .output()
        .map_err(|error| format!("无法验证 Sandboxie 配置：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "无法验证 Sandboxie FileRootPath：{}",
            command_detail(&output.stdout, &output.stderr)
        ));
    }
    let decoded = decode_output(&output.stdout);
    let actual_line = decoded
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or_default();
    let actual = actual_line
        .strip_prefix("FileRootPath=")
        .unwrap_or(actual_line)
        .trim_start_matches(r"\??\");
    let expected = root_value.trim_start_matches(r"\??\");
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(format!(
            "Sandboxie FileRootPath 校验失败：期望 {expected}，实际 {actual}。"
        ));
    }
    Ok(())
}

fn configure_shared_content(
    provider: &SandboxieProvider,
    box_name: &str,
    shared_data_root: &Path,
    _content: Sv2ConcurrentContentView,
) -> Result<(), String> {
    let shared_paths = [sandbox_directory_rule(shared_data_root)?];

    let mut clear = quiet_command(&provider.sbie_ini);
    clear.arg("set").arg(box_name).arg("OpenFilePath");
    run_checked(&mut clear, "无法清除 Sandboxie 共享内容规则")?;

    for path in &shared_paths {
        run_checked(
            quiet_command(&provider.sbie_ini)
                .arg("append")
                .arg(box_name)
                .arg("OpenFilePath")
                .arg(path),
            "无法配置 Sandboxie 共享内容规则",
        )?;
    }
    Ok(())
}

fn sandbox_directory_rule(path: &Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("Sandboxie 共享内容路径必须是绝对路径。".to_string());
    }
    let mut value = path.to_string_lossy().into_owned();
    if value
        .chars()
        .any(|character| character == '\r' || character == '\n' || character == '\0')
    {
        return Err("Sandboxie 共享内容路径包含不允许的控制字符。".to_string());
    }
    if !value.ends_with(['\\', '/']) {
        value.push(std::path::MAIN_SEPARATOR);
    }
    Ok(value)
}

fn list_pids(provider: &SandboxieProvider, box_name: &str) -> Result<Vec<u32>, String> {
    let output = quiet_command(&provider.start)
        .arg(sandbox_box_argument(box_name))
        .arg("/listpids")
        .output()
        .map_err(|error| format!("无法查询隔离实例：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "无法查询隔离实例：{}",
            command_detail(&output.stdout, &output.stderr)
        ));
    }
    Ok(parse_pid_list(&decode_output(&output.stdout)))
}

fn run_checked(command: &mut Command, label: &str) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|error| format!("{label}：{error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{label}（退出码 {:?}）：{}",
            output.status.code(),
            command_detail(&output.stdout, &output.stderr)
        ))
    }
}

fn command_detail(stdout: &[u8], stderr: &[u8]) -> String {
    let detail = [decode_output(stdout), decode_output(stderr)]
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if detail.is_empty() {
        "未返回详细信息".to_string()
    } else {
        detail
    }
}

fn decode_output(bytes: &[u8]) -> String {
    let looks_utf16 = bytes.len() >= 2
        && bytes.len().is_multiple_of(2)
        && bytes
            .iter()
            .skip(1)
            .step_by(2)
            .filter(|byte| **byte == 0)
            .count()
            > bytes.len() / 8;
    if looks_utf16 {
        let words = bytes
            .chunks(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&words)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn parse_pid_list(value: &str) -> Vec<u32> {
    let mut numbers = value
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect::<Vec<_>>();
    if numbers
        .first()
        .is_some_and(|count| *count as usize == numbers.len().saturating_sub(1))
    {
        numbers.remove(0);
    }
    numbers.sort_unstable();
    numbers.dedup();
    numbers
}

fn validate_prepared(root: &Path, slot_id: &str, box_name: &str) -> Result<(), String> {
    reject_reparse_point(root)?;
    let marker_path = root.join(CONCURRENT_MARKER_FILE);
    if !marker_path.is_file() {
        return Err("隔离副本缺少工具箱标记；不会覆盖该目录。".to_string());
    }
    let text = fs::read_to_string(&marker_path)
        .map_err(|error| format!("无法读取隔离副本标记：{error}"))?;
    let marker: ConcurrentMarker = serde_json::from_str(&text)
        .map_err(|error| format!("隔离副本标记不是有效 JSON：{error}"))?;
    if marker.schema_version != CONCURRENT_SCHEMA_VERSION
        || marker.slot_id != slot_id
        || marker.box_name != box_name
    {
        return Err("隔离副本标记与槽位不匹配；不会使用该目录。".to_string());
    }
    let data = virtual_data_root(root);
    reject_reparse_point(&data)?;
    if !data.is_dir() {
        return Err("隔离副本的数据根不存在。".to_string());
    }
    Ok(())
}

fn write_marker(root: &Path, marker: &ConcurrentMarker) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| format!("无法创建隔离副本目录：{error}"))?;
    let path = root.join(CONCURRENT_MARKER_FILE);
    let bytes = serde_json::to_vec_pretty(marker).map_err(|error| error.to_string())?;
    let mut file = File::create(&path).map_err(|error| format!("无法创建隔离副本标记：{error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("无法写入隔离副本标记：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("无法刷新隔离副本标记：{error}"))
}

fn copy_slot_tree(source: &Path, destination: &Path) -> Result<(), String> {
    copy_tree(source, destination, true)
}

fn copy_tree(source: &Path, destination: &Path, skip_databases: bool) -> Result<(), String> {
    reject_reparse_point(source)?;
    let metadata =
        fs::symlink_metadata(source).map_err(|error| format!("无法读取槽位源数据：{error}"))?;
    if !metadata.is_dir() {
        return Err("槽位源数据不是目录。".to_string());
    }
    fs::create_dir_all(destination).map_err(|error| format!("无法创建隔离数据目录：{error}"))?;
    for entry in fs::read_dir(source).map_err(|error| format!("无法枚举槽位源数据：{error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取槽位目录项：{error}"))?;
        if skip_databases && entry.file_name() == "databases" {
            continue;
        }
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("无法检查槽位目录项：{error}"))?;
        reject_reparse_metadata(&source_path, &metadata)?;
        if metadata.is_dir() {
            copy_tree(&source_path, &destination_path, false)?;
        } else if metadata.is_file() {
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("无法复制 {}：{error}", source_path.display()))?;
        } else {
            return Err(format!("不支持的槽位目录项：{}", source_path.display()));
        }
    }
    Ok(())
}

fn reject_reparse_point(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("无法检查目录 {}：{error}", path.display()))?;
    reject_reparse_metadata(path, &metadata)
}

fn reject_reparse_metadata(path: &Path, metadata: &fs::Metadata) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!(
                "路径 {} 是 reparse point；为避免越界复制，操作已停止。",
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

fn cleanup_staging(staging: &Path, slot_root: &Path) {
    let is_owned_staging = staging.parent() == Some(slot_root)
        && staging
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".staging-"));
    if is_owned_staging {
        let _ = fs::remove_dir_all(staging);
    }
}

fn box_root(vault: &Path, slot_id: &str) -> PathBuf {
    vault.join("c").join(compact_slot_id(slot_id))
}

fn existing_box_root(vault: &Path, slot_id: &str) -> PathBuf {
    let short = box_root(vault, slot_id);
    if short.exists() {
        short
    } else {
        let legacy = legacy_box_root(vault, slot_id);
        if legacy.exists() {
            legacy
        } else {
            short
        }
    }
}

fn legacy_box_root(vault: &Path, slot_id: &str) -> PathBuf {
    vault.join("concurrent").join(slot_id).join("box")
}

fn compact_slot_id(slot_id: &str) -> String {
    Uuid::parse_str(slot_id)
        .map(|id| id.simple().to_string()[..16].to_string())
        .unwrap_or_else(|_| "invalid".to_string())
}

fn virtual_data_root(box_root: &Path) -> PathBuf {
    box_root
        .join("user")
        .join("current")
        .join("AppData")
        .join("Roaming")
        .join("Dreamtonics")
        .join("Synthesizer V Studio 2")
}

fn box_name(slot_id: &str) -> Result<String, String> {
    let id = Uuid::parse_str(slot_id).map_err(|_| "槽位 ID 无效。".to_string())?;
    if id.get_version_num() != 4 {
        return Err("槽位 ID 必须是 UUID v4。".to_string());
    }
    let compact = id.simple().to_string();
    Ok(format!("SV2TB{}", &compact[..24]))
}

#[cfg(any(windows, test))]
fn supported_provider_version(version: (u16, u16, u16, u16)) -> bool {
    match version.0 {
        0 => false,
        1 => version >= (1, 17, 6, 0),
        2..=4 => true,
        5 => version >= (5, 72, 6, 0),
        _ => true,
    }
}

fn provider_edition(version: (u16, u16, u16, u16)) -> &'static str {
    match version.0 {
        1 => "Plus",
        5 => "Classic",
        _ => "Compatible",
    }
}

fn provider_name(version: (u16, u16, u16, u16)) -> &'static str {
    match provider_edition(version) {
        "Plus" => "Sandboxie Plus",
        "Classic" => "Sandboxie Classic",
        _ => "Sandboxie",
    }
}

fn sandbox_box_argument(box_name: &str) -> String {
    format!("/box:{box_name}")
}

fn format_version(version: (u16, u16, u16, u16)) -> String {
    let mut parts = vec![version.0, version.1, version.2, version.3];
    while parts.len() > 3 && parts.last() == Some(&0) {
        parts.pop();
    }
    parts
        .into_iter()
        .map(|part| part.to_string())
        .collect::<Vec<_>>()
        .join(".")
}

#[cfg(windows)]
fn file_version(path: &Path) -> Result<(u16, u16, u16, u16), String> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null_mut, NonNull};

    use windows_sys::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
    };

    let path = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), null_mut()) };
    if size == 0 {
        return Err("无法读取 Sandboxie 文件版本。".to_string());
    }
    let mut data = vec![0_u8; size as usize];
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, data.as_mut_ptr().cast()) } == 0 {
        return Err("无法载入 Sandboxie 文件版本。".to_string());
    }
    let sub_block = ['\\' as u16, 0];
    let mut value: *mut c_void = null_mut();
    let mut length = 0_u32;
    if unsafe {
        VerQueryValueW(
            data.as_ptr().cast(),
            sub_block.as_ptr(),
            &mut value,
            &mut length,
        )
    } == 0
        || length < std::mem::size_of::<VS_FIXEDFILEINFO>() as u32
    {
        return Err("Sandboxie 文件没有有效版本信息。".to_string());
    }
    let value = NonNull::new(value.cast::<VS_FIXEDFILEINFO>())
        .ok_or_else(|| "Sandboxie 版本指针为空。".to_string())?;
    let fixed = unsafe { value.as_ref() };
    if fixed.dwSignature != 0xFEEF_04BD {
        return Err("Sandboxie 文件版本签名无效。".to_string());
    }
    Ok((
        (fixed.dwFileVersionMS >> 16) as u16,
        fixed.dwFileVersionMS as u16,
        (fixed.dwFileVersionLS >> 16) as u16,
        fixed.dwFileVersionLS as u16,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_name_is_stable_alphanumeric_and_bounded() {
        let id = "11111111-1111-4111-8111-111111111111";
        let name = box_name(id).unwrap();
        assert_eq!(name, "SV2TB111111111111411181111111");
        assert!(name.len() <= 32);
        assert!(name
            .chars()
            .all(|character| character.is_ascii_alphanumeric()));
        assert!(box_name("../../escape").is_err());
        assert_eq!(sandbox_box_argument(&name), format!("/box:{name}"));
        assert!(!sandbox_box_argument(&name).contains('#'));
        assert_eq!(BOX_NAME_TITLE_SETTING, "-");
        assert_eq!(compact_slot_id(id), "1111111111114111");
    }

    #[test]
    fn pid_output_ignores_the_leading_count() {
        assert_eq!(parse_pid_list("3\r\n42\r\n7\r\n42\r\n"), vec![7, 42]);
        assert_eq!(parse_pid_list("0\r\n"), Vec::<u32>::new());
    }

    #[test]
    fn content_preferences_isolate_settings_and_share_voice_libraries() {
        let defaults = Sv2ConcurrentDefaults {
            app_settings: true,
            voice_libraries: false,
        };
        let inherited = Sv2ConcurrentContentPreferences::default().resolve(defaults);
        assert!(inherited.effective_app_settings);
        assert!(!inherited.effective_voice_libraries);

        let overridden = Sv2ConcurrentContentPreferences {
            app_settings: Sv2IsolationPreference::Off,
            voice_libraries: Sv2IsolationPreference::On,
        }
        .resolve(defaults);
        assert!(overridden.effective_app_settings);
        assert!(!overridden.effective_voice_libraries);
    }

    #[test]
    fn shared_content_rules_are_scoped_to_a_directory() {
        let rule = sandbox_directory_rule(&std::env::temp_dir().join("sv2-settings")).unwrap();
        assert!(rule.ends_with(std::path::MAIN_SEPARATOR));
        assert!(!rule.contains(['\r', '\n', '\0']));
    }

    #[test]
    fn opaque_slot_tree_is_copied_into_the_sandbox_overlay() {
        let root = std::env::temp_dir().join(format!("sv2-concurrent-test-{}", Uuid::new_v4()));
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(source.join("license")).unwrap();
        fs::create_dir_all(source.join("webview2/Default")).unwrap();
        fs::write(source.join("license/session"), [0_u8, 1, 2, 255]).unwrap();
        fs::write(source.join("webview2/Default/Cookies"), b"opaque").unwrap();

        copy_tree(&source, &destination, false).unwrap();

        assert_eq!(
            fs::read(destination.join("license/session")).unwrap(),
            [0_u8, 1, 2, 255]
        );
        assert_eq!(
            fs::read(destination.join("webview2/Default/Cookies")).unwrap(),
            b"opaque"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn slot_copy_skips_the_shared_voice_database() {
        let root =
            std::env::temp_dir().join(format!("sv2-concurrent-copy-test-{}", Uuid::new_v4()));
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(source.join("databases/voice")).unwrap();
        fs::create_dir_all(source.join("license")).unwrap();
        fs::write(source.join("databases/voice/model"), b"voice").unwrap();
        fs::write(source.join("license/session"), b"session").unwrap();

        copy_slot_tree(&source, &destination).unwrap();

        assert!(!destination.join("databases").exists());
        assert_eq!(
            fs::read(destination.join("license/session")).unwrap(),
            b"session"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prepared_marker_must_match_the_slot_and_box() {
        let root = std::env::temp_dir().join(format!("sv2-concurrent-test-{}", Uuid::new_v4()));
        let id = Uuid::new_v4().to_string();
        let name = box_name(&id).unwrap();
        fs::create_dir_all(virtual_data_root(&root)).unwrap();
        write_marker(
            &root,
            &ConcurrentMarker {
                schema_version: CONCURRENT_SCHEMA_VERSION,
                slot_id: id.clone(),
                box_name: name.clone(),
            },
        )
        .unwrap();

        validate_prepared(&root, &id, &name).unwrap();
        assert!(validate_prepared(&root, &Uuid::new_v4().to_string(), &name).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn utf16_command_output_is_decoded() {
        let text = "C:\\并发\\box\r\n";
        let bytes = text
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        assert_eq!(decode_output(&bytes), text);
    }

    #[test]
    fn provider_version_rejects_known_vulnerable_builds() {
        assert!(!supported_provider_version((1, 17, 2, 0)));
        assert!(supported_provider_version((1, 17, 6, 0)));
        assert!(!supported_provider_version((5, 72, 2, 0)));
        assert!(supported_provider_version((5, 72, 6, 0)));
    }

    #[test]
    fn provider_identity_matches_the_sandboxie_version_line() {
        assert_eq!(provider_name((1, 17, 6, 0)), "Sandboxie Plus");
        assert_eq!(provider_edition((1, 17, 6, 0)), "Plus");
        assert_eq!(provider_name((5, 73, 2, 0)), "Sandboxie Classic");
        assert_eq!(provider_edition((5, 73, 2, 0)), "Classic");
        assert_eq!(format_version((5, 73, 2, 0)), "5.73.2");
    }
}
