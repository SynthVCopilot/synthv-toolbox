use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::synthv::{quiet_command, succeeded, OperationResult};

// Sandboxie uses `-` (rather than a boolean `n`) for "do not alter the title".
const BOX_NAME_TITLE_SETTING: &str = "-";
const INSTANCE_MARKER: &str = ".synthv-toolbox-instance.json";
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
            app_settings: self.app_settings,
            voice_libraries: Sv2IsolationPreference::On,
            effective_app_settings: false,
            effective_voice_libraries: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SandboxieProvider {
    start: PathBuf,
    sbie_ini: PathBuf,
    version: (u16, u16, u16, u16),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstanceMarker {
    slot_id: String,
    instance_id: String,
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
    let data_path = slot_data_root(vault, slot_id);
    let mut ready = validate_slot_root(vault, slot_id).is_ok();
    let mut detail = if ready {
        "账号数据目录已就绪；每次启动会创建独立的 Sandboxie 实例。".to_string()
    } else {
        "账号数据目录不存在。".to_string()
    };
    let running_pids = match provider.map(|provider| slot_running_pids(provider, vault, slot_id)) {
        Some(Ok(pids)) => pids,
        Some(Err(error)) => {
            ready = false;
            detail = error;
            Vec::new()
        }
        None => Vec::new(),
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
    _shared_data_root: &Path,
    slot_id: &str,
    content: Sv2ConcurrentContentView,
) -> Result<(), String> {
    let _ = provider;
    let _ = content;
    let expected = validate_slot_root(vault, slot_id)?;
    if source != expected {
        return Err("并发账号数据必须使用槽位权威目录。".to_string());
    }
    Ok(())
}

pub fn launch_slot(
    provider: &SandboxieProvider,
    vault: &Path,
    slot_id: &str,
    executable: &Path,
    project: Option<&Path>,
    slot_data_root: &Path,
    content: Sv2ConcurrentContentView,
) -> Result<OperationResult, String> {
    if slot_data_root != validate_slot_root(vault, slot_id)?.as_path() {
        return Err("并发账号数据必须使用槽位权威目录。".to_string());
    }
    let reused = reusable_instance(provider, vault, slot_id, slot_data_root)?;
    let instance_id = reused
        .as_ref()
        .and_then(|root| root.file_name())
        .and_then(|id| id.to_str())
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let name = instance_box_name(slot_id, &instance_id)?;
    let root = reused.unwrap_or_else(|| instance_box_root(vault, slot_id, &instance_id));
    let parent = root.parent().ok_or("隔离实例目录无效。")?;
    for path in [vault.join("instances"), parent.to_path_buf()] {
        reject_reparse_point(&path)?;
    }
    if !root.exists() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建隔离实例目录：{error}"))?;
        fs::create_dir(&root).map_err(|error| format!("无法创建独立实例目录：{error}"))?;
        configure_box(provider, &name, &root, slot_data_root, content)?;
        fs::write(root.join(INSTANCE_MARKER), serde_json::to_vec(&InstanceMarker { slot_id: slot_id.to_string(), instance_id }).map_err(|error| error.to_string())?)
            .map_err(|error| format!("无法记录隔离实例：{error}"))?;
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
        "已在独立的注册表和 IPC 命名空间中启动 SV2。",
        "同账号实例共用槽位数据。".to_string(),
    ))
}

#[cfg(windows)]
pub fn concurrent_folder(vault: &Path, slot_id: &str) -> Result<PathBuf, String> {
    validate_slot_root(vault, slot_id)
}

pub fn remove_slot_data(vault: &Path, slot_id: &str) -> Result<(), String> {
    validate_uuid(slot_id)?;
    let root = vault.join("instances").join(compact_slot_id(slot_id));
    reject_reparse_point(vault)?;
    reject_reparse_point(&vault.join("instances"))?;
    reject_reparse_point(&root)?;
    if root.exists() {
        let entries = fs::read_dir(&root)
            .map_err(|error| error.to_string())?
            .map(|entry| {
                entry
                    .map(|entry| entry.path())
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        for instance in &entries {
            validate_uuid(
                instance
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("无效实例目录。")?,
            )?;
            validate_instance_tree(
                instance,
                &virtual_data_root(instance),
                &slot_data_root(vault, slot_id),
            )?;
        }
        #[cfg(windows)]
        for instance in entries {
            let overlay = virtual_data_root(&instance);
            if fs::symlink_metadata(&overlay).is_ok() {
                junction::delete(&overlay)
                    .map_err(|error| format!("无法移除隔离数据链接：{error}"))?;
            }
        }
        fs::remove_dir_all(root).map_err(|error| format!("无法删除隔离实例目录：{error}"))?;
    }
    Ok(())
}

fn reusable_instance(
    provider: &SandboxieProvider,
    vault: &Path,
    slot_id: &str,
    slot: &Path,
) -> Result<Option<PathBuf>, String> {
    let parent = vault.join("instances").join(compact_slot_id(slot_id));
    if !parent.exists() { return Ok(None); }
    reject_reparse_point(&parent)?;
    let Some(entry) = fs::read_dir(&parent).map_err(|error| error.to_string())?.next() else { return Ok(None); };
    let root = entry.map_err(|error| error.to_string())?.path();
    reject_reparse_point(&root)?;
    let marker: InstanceMarker = serde_json::from_slice(&fs::read(root.join(INSTANCE_MARKER)).map_err(|error| error.to_string())?)
        .map_err(|error| format!("隔离实例记录损坏：{error}"))?;
    if marker.slot_id != slot_id || root.file_name().and_then(|name| name.to_str()) != Some(marker.instance_id.as_str()) {
        return Err("隔离实例记录与账号目录不一致。".to_string());
    }
    validate_instance_tree(&root, &virtual_data_root(&root), slot)?;
    let name = instance_box_name(slot_id, &marker.instance_id)?;
    verify_box_root(provider, &name, &root)?;
    Ok(Some(root))
}

fn verify_box_root(provider: &SandboxieProvider, box_name: &str, root: &Path) -> Result<(), String> {
    let output = quiet_command(&provider.sbie_ini).arg("queryex").arg(box_name).arg("FileRootPath").output()
        .map_err(|error| format!("无法验证 Sandboxie 配置：{error}"))?;
    if !output.status.success() { return Err("无法验证 Sandboxie FileRootPath。".to_string()); }
    let text = decode_output(&output.stdout);
    let actual_line = text.lines().map(str::trim).rfind(|line| !line.is_empty()).unwrap_or_default();
    let actual = actual_line.strip_prefix("FileRootPath=").unwrap_or(actual_line).trim_start_matches(r"\??\");
    let expected = root.to_string_lossy();
    if !actual.eq_ignore_ascii_case(expected.trim_start_matches(r"\??\")) { return Err("Sandboxie FileRootPath 与实例目录不一致。".to_string()); }
    Ok(())
}

fn validate_instance_tree(path: &Path, overlay: &Path, slot: &Path) -> Result<(), String> {
    #[cfg(windows)]
    if path == overlay {
        let target =
            junction::get_target(path).map_err(|error| format!("无法检查隔离数据链接：{error}"))?;
        let normalize = |path: &Path| {
            path.to_string_lossy()
                .trim_start_matches(r"\\?\")
                .replace('/', "\\")
                .to_lowercase()
        };
        if normalize(&target) != normalize(slot) {
            return Err("隔离数据链接未指向所属账号；操作已停止。".to_string());
        }
        return Ok(());
    }
    reject_reparse_point(path)?;
    if path.is_dir() {
        for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
            validate_instance_tree(
                &entry.map_err(|error| error.to_string())?.path(),
                overlay,
                slot,
            )?;
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
    configure_slot_mapping(provider, box_name, root, shared_data_root, content)?;
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

fn configure_slot_mapping(
    provider: &SandboxieProvider,
    box_name: &str,
    root: &Path,
    slot_data_root: &Path,
    _content: Sv2ConcurrentContentView,
) -> Result<(), String> {
    let slot_rule = sandbox_directory_rule(slot_data_root)?;

    let mut clear = quiet_command(&provider.sbie_ini);
    clear.arg("set").arg(box_name).arg("OpenFilePath");
    run_checked(&mut clear, "无法清除 Sandboxie 共享内容规则")?;

    run_checked(
        quiet_command(&provider.sbie_ini)
            .arg("append")
            .arg(box_name)
            .arg("OpenFilePath")
            .arg(&slot_rule),
        "无法配置 Sandboxie 账号数据映射",
    )?;
    create_overlay_slot_junction(root, slot_data_root)?;
    Ok(())
}

fn create_overlay_slot_junction(root: &Path, slot_data_root: &Path) -> Result<(), String> {
    reject_reparse_point(root)?;
    reject_reparse_point(slot_data_root)?;
    let overlay = virtual_data_root(root);
    let parent = overlay
        .parent()
        .ok_or_else(|| "隔离数据映射路径无效。".to_string())?;
    let relative = parent
        .strip_prefix(root)
        .map_err(|_| "隔离映射超出实例目录。")?;
    let mut current = root.to_path_buf();
    reject_reparse_point(&current)?;
    for part in relative.components() {
        current.push(part);
        reject_reparse_point(&current)?;
    }
    fs::create_dir_all(parent).map_err(|error| format!("无法创建隔离数据映射父目录：{error}"))?;
    if fs::symlink_metadata(&overlay).is_ok() {
        #[cfg(windows)]
        if !junction::exists(&overlay).map_err(|error| error.to_string())? {
            return Err("隔离数据映射已存在普通目录；不会覆盖。".to_string());
        }
        let actual = overlay
            .canonicalize()
            .map_err(|error| format!("无法解析隔离数据映射：{error}"))?;
        let expected = slot_data_root
            .canonicalize()
            .map_err(|error| format!("无法解析账号数据目录：{error}"))?;
        if actual == expected {
            return Ok(());
        }
        return Err("隔离实例数据映射已指向未知目录；不会覆盖。".to_string());
    }
    #[cfg(windows)]
    junction::create(slot_data_root, &overlay)
        .map_err(|error| format!("无法创建隔离账号数据映射：{error}"))?;
    #[cfg(not(windows))]
    return Err("并发隔离当前仅支持 Windows。".to_string());
    #[cfg(windows)]
    Ok(())
}

fn sandbox_directory_rule(path: &Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("Sandboxie 共享内容路径必须是绝对路径。".to_string());
    }
    let mut value = path.to_string_lossy().into_owned();
    if value
        .chars()
        .any(|character| matches!(character, '\r' | '\n' | '\0' | '%' | ',' | '*' | '?'))
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
    parse_pid_list(&decode_output(&output.stdout))
}

pub fn slot_running_pids(
    provider: &SandboxieProvider,
    vault: &Path,
    slot_id: &str,
) -> Result<Vec<u32>, String> {
    validate_uuid(slot_id)?;
    let root = vault.join("instances").join(compact_slot_id(slot_id));
    for path in [vault, &vault.join("instances"), &root] {
        reject_reparse_point(path)?;
    }
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut pids = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| format!("无法读取隔离实例目录：{error}"))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        reject_reparse_point(&entry.path())?;
        let marker_path = entry.path().join(INSTANCE_MARKER);
        reject_reparse_point(&marker_path)?;
        if !marker_path.is_file() {
            continue;
        }
        let marker: InstanceMarker =
            serde_json::from_slice(&fs::read(&marker_path).map_err(|error| error.to_string())?)
                .map_err(|error| format!("隔离实例记录损坏：{error}"))?;
        if marker.slot_id != slot_id
            || entry.file_name().to_str() != Some(marker.instance_id.as_str())
        {
            return Err("隔离实例记录与账号目录不一致。".to_string());
        }
        let box_name = instance_box_name(slot_id, &marker.instance_id)?;
        pids.extend(list_pids(provider, &box_name)?);
    }
    pids.sort_unstable();
    pids.dedup();
    Ok(pids)
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

fn parse_pid_list(value: &str) -> Result<Vec<u32>, String> {
    let mut lines = value
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let count = lines
        .next()
        .and_then(|line| line.parse::<usize>().ok())
        .ok_or("Sandboxie 进程列表缺少有效计数。")?;
    let mut pids = lines
        .map(|line| {
            line.parse::<u32>()
                .ok()
                .filter(|pid| *pid > 0)
                .ok_or_else(|| "Sandboxie 进程列表包含无效 PID。".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if pids.len() != count {
        return Err("Sandboxie 进程列表计数不一致。".to_string());
    }
    pids.sort_unstable();
    pids.dedup();
    Ok(pids)
}

fn reject_reparse_point(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => reject_reparse_metadata(path, &metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法检查路径 {}：{error}", path.display())),
    }
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

fn slot_data_root(vault: &Path, slot_id: &str) -> PathBuf {
    vault.join("slots").join(slot_id)
}

fn validate_uuid(value: &str) -> Result<Uuid, String> {
    let id = Uuid::parse_str(value).map_err(|_| "账号或实例 ID 无效。".to_string())?;
    if id.get_version_num() != 4 || id.to_string() != value {
        return Err("账号和实例 ID 必须是标准 UUID v4。".to_string());
    }
    Ok(id)
}

fn validate_slot_root(vault: &Path, slot_id: &str) -> Result<PathBuf, String> {
    validate_uuid(slot_id)?;
    if !vault.is_absolute() {
        return Err("账号保管区必须是绝对路径。".to_string());
    }
    let root = slot_data_root(vault, slot_id);
    let marker = root.join(".synthv-toolbox-slot.json");
    for path in [vault, &vault.join("slots"), &root, &marker] {
        reject_reparse_point(path)?;
    }
    let value: serde_json::Value = serde_json::from_slice(
        &fs::read(marker).map_err(|error| format!("无法读取账号槽位标记：{error}"))?,
    )
    .map_err(|error| format!("账号槽位标记损坏：{error}"))?;
    if value.get("slotId").and_then(|value| value.as_str()) != Some(slot_id) {
        return Err("账号数据目录与槽位标记不一致。".to_string());
    }
    Ok(root)
}

fn instance_box_root(vault: &Path, slot_id: &str, instance_id: &str) -> PathBuf {
    vault
        .join("instances")
        .join(compact_slot_id(slot_id))
        .join(instance_id)
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

fn instance_box_name(slot_id: &str, instance_id: &str) -> Result<String, String> {
    let id = validate_uuid(slot_id)?;
    let instance = validate_uuid(instance_id)?;
    Ok(format!(
        "SV2TB{}{}",
        &id.simple().to_string()[..12],
        &instance.simple().to_string()[..12]
    ))
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
#[path = "../../../../test/sv2_concurrent_tests.rs"]
mod tests;
