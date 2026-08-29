use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sv2_profiles::{Sv2ProfileSlotView, Sv2ProfilesState};

const MAX_PROJECT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_VOICE_REQUIREMENTS: usize = 128;
const MAX_INSTALLED_DATABASES: usize = 512;

pub const TOOLBOX_SVP_PROG_ID: &str = "SynthVToolbox.SVP";
#[cfg(windows)]
const TOOLBOX_REGISTERED_APP_NAME: &str = "SynthV Toolbox";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SvpActivation {
    pub project_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SvpAssociationView {
    pub supported: bool,
    pub registered: bool,
    pub is_default: bool,
    pub original_prog_id: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Sv2VoiceInventoryStatus {
    Manual,
    LocalEvidence,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sv2VoiceInventoryView {
    pub status: Sv2VoiceInventoryStatus,
    pub manually_confirmed_voices: Vec<String>,
    pub installed_opaque_count: usize,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SvpVoiceRequirement {
    pub name: String,
    pub version: Option<u32>,
    pub backend_type: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SvpLaunchMode {
    Normal,
    Concurrent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SvpRouteCandidate {
    pub slot_id: String,
    pub display_name: String,
    pub idle: bool,
    pub launch_mode: Option<SvpLaunchMode>,
    pub matched_voices: Vec<String>,
    pub missing_or_unknown_voices: Vec<String>,
    pub exact_authorization_match: bool,
    pub reason: String,
    #[serde(skip)]
    score: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SvpRoutePlan {
    pub project_path: String,
    pub required_voices: Vec<SvpVoiceRequirement>,
    pub candidates: Vec<SvpRouteCandidate>,
    pub selected_slot_id: Option<String>,
    pub selected_launch_mode: Option<SvpLaunchMode>,
    pub requires_confirmation: bool,
    pub summary: String,
    pub detail: String,
}

/// Parses an operating-system activation without treating arbitrary command-line
/// arguments as projects. File associations registered by this module always use
/// the explicit `--svp-route <file>` marker.
pub fn parse_svp_activation(
    args: &[String],
    cwd: Option<&str>,
) -> Result<Option<SvpActivation>, String> {
    let positions = args
        .iter()
        .enumerate()
        .filter_map(|(index, value)| (value == "--svp-route").then_some(index))
        .collect::<Vec<_>>();
    let Some(&marker_index) = positions.first() else {
        return Ok(None);
    };
    if positions.len() != 1 || marker_index > 1 {
        return Err("无效的 .svp 启动路由参数。".to_string());
    }
    let value = args
        .get(marker_index + 1)
        .filter(|value| !value.is_empty() && value.as_str() != "--svp-route")
        .ok_or_else(|| "启动路由缺少 .svp 工程路径。".to_string())?;
    if args.len() != marker_index + 2 {
        return Err("一次启动路由只接受一个 .svp 工程。".to_string());
    }
    let path = resolve_project_path(value, cwd.map(Path::new))?;
    Ok(Some(SvpActivation {
        project_path: path.to_string_lossy().into_owned(),
    }))
}

/// Returns the current per-user `.svp` association status. `configured_original_prog_id`
/// is the previously preserved non-Toolbox handler, if the caller has one.
pub fn svp_association_view(
    configured_original_prog_id: Option<&str>,
) -> Result<SvpAssociationView, String> {
    #[cfg(windows)]
    {
        windows_association::association_view(configured_original_prog_id)
    }
    #[cfg(not(windows))]
    {
        let _ = configured_original_prog_id;
        Ok(unsupported_association_view())
    }
}

/// Registers SynthV Toolbox as an Open With candidate. This intentionally does
/// not write Explorer's `UserChoice` and therefore never silently becomes the
/// default `.svp` application.
pub fn register_svp_open_with_candidate(
    toolbox_executable: &Path,
    configured_original_prog_id: Option<&str>,
) -> Result<SvpAssociationView, String> {
    #[cfg(windows)]
    {
        windows_association::register_candidate(toolbox_executable, configured_original_prog_id)
    }
    #[cfg(not(windows))]
    {
        let _ = (toolbox_executable, configured_original_prog_id);
        Err("当前平台不支持注册 Windows .svp 打开方式。".to_string())
    }
}

/// Opens the Windows Default Apps UI so the user, rather than the Toolbox, can
/// explicitly choose the `.svp` default application.
pub fn open_svp_default_apps_settings() -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_association::open_default_apps_settings()
    }
    #[cfg(not(windows))]
    {
        Err("当前平台没有 Windows 默认应用设置。".to_string())
    }
}

/// Opens a validated project through a preserved, non-Toolbox ProgID. Using
/// `SEE_MASK_CLASSNAME` bypasses the current `.svp` default and prevents a
/// Toolbox -> Toolbox association loop.
pub fn passthrough_svp_project(
    project_path: &str,
    original_prog_id: Option<&str>,
) -> Result<(), String> {
    let project_path = resolve_project_path(project_path, None)?;
    let original_prog_id =
        original_prog_id.ok_or_else(|| "未保存可用的原 .svp 处理器，无法安全透传。".to_string())?;
    let original_prog_id = validate_original_prog_id(original_prog_id)?;
    #[cfg(windows)]
    {
        windows_association::passthrough(&project_path, &original_prog_id)
    }
    #[cfg(not(windows))]
    {
        let _ = (project_path, original_prog_id);
        Err("当前平台不支持按 Windows ProgID 透传 .svp 工程。".to_string())
    }
}

pub fn validate_confirmed_voice_names(values: Vec<String>) -> Result<Vec<String>, String> {
    if values.len() > 256 {
        return Err("每个账号最多记录 256 个声库授权。".to_string());
    }
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for value in values {
        let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
        if value.is_empty() {
            continue;
        }
        if value.len() > 160 || value.chars().any(char::is_control) {
            return Err("声库名称过长或包含控制字符。".to_string());
        }
        let key = normalized_voice_name(&value);
        if seen.insert(key) {
            result.push(value);
        }
    }
    result.sort_by_key(|value| normalized_voice_name(value));
    Ok(result)
}

pub fn inspect_voice_inventory(
    data_root: &Path,
    manually_confirmed_voices: &[String],
) -> Sv2VoiceInventoryView {
    let installed_opaque_count = count_installed_opaque_databases(data_root);
    let (status, detail) = if !manually_confirmed_voices.is_empty() {
        (
            Sv2VoiceInventoryStatus::Manual,
            format!(
                "已手工确认 {} 个声库；本地另检测到 {} 个不透明安装项。Dreamtonics 官方授权仍以 SV2 启动验证为准。",
                manually_confirmed_voices.len(),
                installed_opaque_count
            ),
        )
    } else if installed_opaque_count > 0 {
        (
            Sv2VoiceInventoryStatus::LocalEvidence,
            format!(
                "检测到 {installed_opaque_count} 个本地声库安装项，但本地文件不公开产品映射，无法据此确认账号授权。"
            ),
        )
    } else {
        (
            Sv2VoiceInventoryStatus::Unknown,
            "未发现可安全映射的账号声库授权；不会把商店目录或可下载状态当作已授权。".to_string(),
        )
    };
    Sv2VoiceInventoryView {
        status,
        manually_confirmed_voices: manually_confirmed_voices.to_vec(),
        installed_opaque_count,
        detail,
    }
}

pub fn analyze_svp_project(value: &str) -> Result<(PathBuf, Vec<SvpVoiceRequirement>), String> {
    let path = validate_project_path(value)?;
    let metadata = fs::metadata(&path).map_err(|error| format!("无法检查 .svp 工程：{error}"))?;
    if metadata.len() == 0 || metadata.len() > MAX_PROJECT_BYTES {
        return Err(".svp 工程为空或超过 128 MiB 安全上限。".to_string());
    }
    let bytes = fs::read(&path).map_err(|error| format!("无法读取 .svp 工程：{error}"))?;
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    let text = std::str::from_utf8(bytes).map_err(|_| ".svp 工程不是有效 UTF-8。".to_string())?;
    let text = text.trim_matches(|character: char| character == '\0' || character.is_whitespace());
    let project: Value =
        serde_json::from_str(text).map_err(|error| format!(".svp 工程不是有效 JSON：{error}"))?;
    let requirements = collect_voice_requirements(&project)?;
    Ok((path, requirements))
}

pub fn build_route_plan(value: &str, state: &Sv2ProfilesState) -> Result<SvpRoutePlan, String> {
    let (project_path, required_voices) = analyze_svp_project(value)?;
    let mut candidates = state
        .slots
        .iter()
        .map(|slot| route_candidate(slot, state, &required_voices))
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .idle
            .cmp(&left.idle)
            .then_with(|| right.score.cmp(&left.score))
            .then_with(|| left.display_name.cmp(&right.display_name))
            .then_with(|| left.slot_id.cmp(&right.slot_id))
    });
    let selected = candidates
        .iter()
        .find(|candidate| candidate.idle && candidate.launch_mode.is_some());
    let selected_slot_id = selected.map(|candidate| candidate.slot_id.clone());
    let selected_launch_mode = selected.and_then(|candidate| candidate.launch_mode);
    let requires_confirmation = selected.is_some_and(|candidate| {
        !required_voices.is_empty() && !candidate.exact_authorization_match
    });
    let (summary, detail) = match selected {
        None => (
            "没有可用于打开该工程的空闲账号。".to_string(),
            "所有账号均在使用中，或当前实例无法安全切换/隔离启动。".to_string(),
        ),
        Some(candidate) if requires_confirmation => (
            format!("需要确认使用账号“{}”。", candidate.display_name),
            "工程声库与账号授权没有完整的权威匹配结果；请选择账号，最终授权由 SV2 官方验证。"
                .to_string(),
        ),
        Some(candidate) => (
            format!("将使用账号“{}”打开工程。", candidate.display_name),
            candidate.reason.clone(),
        ),
    };
    Ok(SvpRoutePlan {
        project_path: project_path.to_string_lossy().into_owned(),
        required_voices,
        candidates,
        selected_slot_id,
        selected_launch_mode,
        requires_confirmation,
        summary,
        detail,
    })
}

fn route_candidate(
    slot: &Sv2ProfileSlotView,
    state: &Sv2ProfilesState,
    required: &[SvpVoiceRequirement],
) -> SvpRouteCandidate {
    let recovery_pending = slot.session_protection.recovery_pending()
        || slot.concurrent_session_protection.recovery_pending();
    let locally_busy =
        !slot.concurrent.running_pids.is_empty() || (slot.is_active && !state.blockers.is_empty());
    let idle = !locally_busy && !recovery_pending;
    let launch_mode = if !idle {
        None
    } else if state.blockers.is_empty() {
        Some(SvpLaunchMode::Normal)
    } else if state.concurrent_provider.available && slot.concurrent.ready {
        Some(SvpLaunchMode::Concurrent)
    } else {
        None
    };
    let confirmed = slot
        .voice_inventory
        .manually_confirmed_voices
        .iter()
        .map(|name| normalized_voice_name(name))
        .collect::<HashSet<_>>();
    let mut matched_voices = Vec::new();
    let mut missing_or_unknown_voices = Vec::new();
    for voice in required {
        if confirmed.contains(&normalized_voice_name(&voice.name)) {
            matched_voices.push(voice.name.clone());
        } else {
            missing_or_unknown_voices.push(voice.name.clone());
        }
    }
    let exact_authorization_match = !required.is_empty() && missing_or_unknown_voices.is_empty();
    let mut score = if required.is_empty() {
        5_000
    } else if exact_authorization_match {
        10_000 + matched_voices.len() as i32 * 100
    } else {
        matched_voices.len() as i32 * 100
    };
    if slot.is_active {
        score += 20;
    }
    if launch_mode == Some(SvpLaunchMode::Normal) {
        score += 5;
    }
    let reason = if !idle {
        "账号当前正在使用或存在远端冲突证据。".to_string()
    } else if launch_mode.is_none() {
        "当前普通槽位被占用，且该账号的并发隔离副本不可用。".to_string()
    } else if required.is_empty() {
        "工程没有可识别的演唱声库要求，优先使用空闲默认账号。".to_string()
    } else if exact_authorization_match {
        format!("已匹配工程所需的 {} 个手工确认声库。", required.len())
    } else {
        "账号授权不完整或未知，需要人工确认。".to_string()
    };
    SvpRouteCandidate {
        slot_id: slot.id.clone(),
        display_name: slot.display_name.clone(),
        idle,
        launch_mode,
        matched_voices,
        missing_or_unknown_voices,
        exact_authorization_match,
        reason,
        score,
    }
}

fn collect_voice_requirements(project: &Value) -> Result<Vec<SvpVoiceRequirement>, String> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let tracks = project
        .get("tracks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for track in tracks {
        let Some(track) = track.as_object() else {
            continue;
        };
        let main_ref = track.get("mainRef").and_then(Value::as_object);
        let main_database = main_ref
            .filter(|reference| !is_instrumental(reference))
            .and_then(|reference| reference.get("database"))
            .and_then(parse_database);
        if let Some(requirement) = &main_database {
            insert_requirement(&mut result, &mut seen, requirement.clone())?;
        }
        for reference in track
            .get("groups")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
        {
            if is_instrumental(reference) {
                continue;
            }
            let requirement = reference
                .get("database")
                .and_then(parse_database)
                .filter(|requirement| !requirement.name.is_empty())
                .or_else(|| main_database.clone());
            if let Some(requirement) = requirement {
                insert_requirement(&mut result, &mut seen, requirement)?;
            }
        }
    }
    Ok(result)
}

fn parse_database(value: &Value) -> Option<SvpVoiceRequirement> {
    let object = value.as_object()?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if name.is_empty() {
        return None;
    }
    let version = object.get("version").and_then(|value| {
        value
            .as_u64()
            .and_then(|version| u32::try_from(version).ok())
            .or_else(|| value.as_str()?.parse::<u32>().ok())
    });
    let backend_type = object
        .get("backendType")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some(SvpVoiceRequirement {
        name,
        version,
        backend_type,
    })
}

fn insert_requirement(
    result: &mut Vec<SvpVoiceRequirement>,
    seen: &mut HashSet<String>,
    requirement: SvpVoiceRequirement,
) -> Result<(), String> {
    if result.len() >= MAX_VOICE_REQUIREMENTS {
        return Err(".svp 工程包含过多声库引用，已停止自动路由。".to_string());
    }
    let key = format!(
        "{}\0{:?}\0{}",
        normalized_voice_name(&requirement.name),
        requirement.version,
        requirement.backend_type.to_lowercase()
    );
    if seen.insert(key) {
        result.push(requirement);
    }
    Ok(())
}

fn is_instrumental(reference: &serde_json::Map<String, Value>) -> bool {
    reference
        .get("isInstrumental")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn normalized_voice_name(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn count_installed_opaque_databases(data_root: &Path) -> usize {
    let databases = data_root.join("databases");
    let Ok(entries) = fs::read_dir(databases) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if matches!(name.as_ref(), "meta" | "tmp") || !entry.path().is_dir() {
                return false;
            }
            fs::read_dir(entry.path())
                .ok()
                .into_iter()
                .flatten()
                .flatten()
                .take(32)
                .any(|version| {
                    version.path().is_dir()
                        && version
                            .file_name()
                            .to_string_lossy()
                            .chars()
                            .all(|character| character.is_ascii_digit())
                })
        })
        .take(MAX_INSTALLED_DATABASES)
        .count()
}

fn validate_project_path(value: &str) -> Result<PathBuf, String> {
    resolve_project_path(value, None)
}

fn resolve_project_path(value: &str, cwd: Option<&Path>) -> Result<PathBuf, String> {
    if value.is_empty() || value.chars().any(|character| character == '\0') {
        return Err("启动路由只接受现有的 .svp 工程文件。".to_string());
    }
    let input = PathBuf::from(value);
    let path = if input.is_relative() {
        cwd.map(|cwd| cwd.join(&input)).unwrap_or(input)
    } else {
        input
    };
    let metadata =
        fs::metadata(&path).map_err(|_| "启动路由只接受现有的 .svp 工程文件。".to_string())?;
    if !metadata.file_type().is_file()
        || !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("svp"))
    {
        return Err("启动路由只接受现有的 .svp 工程文件。".to_string());
    }
    path.canonicalize()
        .map_err(|error| format!("无法解析 .svp 工程路径：{error}"))
}

fn validate_original_prog_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 260
        || value
            .chars()
            .any(|character| character.is_control() || character == '"')
    {
        return Err("原 .svp 处理器 ProgID 无效。".to_string());
    }
    let normalized = value.to_ascii_lowercase();
    let toolbox = TOOLBOX_SVP_PROG_ID.to_ascii_lowercase();
    if normalized == toolbox || normalized.starts_with(&(toolbox + "\\")) {
        return Err("原 .svp 处理器不能指回 SynthV Toolbox。".to_string());
    }
    Ok(value.to_string())
}

#[cfg(not(windows))]
fn unsupported_association_view() -> SvpAssociationView {
    SvpAssociationView {
        supported: false,
        registered: false,
        is_default: false,
        original_prog_id: None,
        detail: "当前平台不支持 Windows .svp 文件关联；智能启动不会拦截系统打开行为。".to_string(),
    }
}

#[cfg(windows)]
mod windows_association {
    use std::ffi::OsStr;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::process::Command;
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_CLASSNAME, SHELLEXECUTEINFOW};
    use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, KEY_READ, REG_NONE};
    use winreg::{RegKey, RegValue};

    use super::{
        validate_original_prog_id, Path, PathBuf, SvpAssociationView, TOOLBOX_REGISTERED_APP_NAME,
        TOOLBOX_SVP_PROG_ID,
    };

    const USER_CHOICE_KEY: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.svp\UserChoice";
    const USER_CLASSES_EXTENSION_KEY: &str = r"Software\Classes\.svp";
    const TOOLBOX_CLASS_KEY: &str = r"Software\Classes\SynthVToolbox.SVP";
    const OPEN_WITH_PROG_IDS_KEY: &str = r"Software\Classes\.svp\OpenWithProgids";
    const CAPABILITIES_KEY: &str = r"Software\SynthVToolbox\Capabilities";
    const FILE_ASSOCIATIONS_KEY: &str = r"Software\SynthVToolbox\Capabilities\FileAssociations";
    const REGISTERED_APPLICATIONS_KEY: &str = r"Software\RegisteredApplications";
    const CAPABILITIES_REGISTRY_PATH: &str = r"Software\SynthVToolbox\Capabilities";
    const DEFAULT_APPS_URI: &str = "ms-settings:defaultapps?registeredAppUser=SynthV%20Toolbox";

    pub(super) fn association_view(
        configured_original_prog_id: Option<&str>,
    ) -> Result<SvpAssociationView, String> {
        let current_prog_id = current_prog_id();
        let original_prog_id =
            select_original_prog_id(configured_original_prog_id, current_prog_id.as_deref());
        let registered = candidate_is_registered();
        let is_default = current_prog_id.as_deref().is_some_and(is_toolbox_prog_id);
        let detail = match (registered, is_default, original_prog_id.as_deref()) {
            (true, true, Some(_)) => {
                "SynthV Toolbox 已是 .svp 默认处理器，并已保存可用于安全透传的原处理器。"
                    .to_string()
            }
            (true, true, None) => {
                "SynthV Toolbox 已是 .svp 默认处理器，但未找到可安全透传的原处理器。".to_string()
            }
            (true, false, _) => {
                "SynthV Toolbox 已注册为“打开方式”候选；默认应用仍由用户选择。".to_string()
            }
            (false, _, _) => "SynthV Toolbox 尚未注册为 .svp“打开方式”候选。".to_string(),
        };
        Ok(SvpAssociationView {
            supported: true,
            registered,
            is_default,
            original_prog_id,
            detail,
        })
    }

    pub(super) fn register_candidate(
        toolbox_executable: &Path,
        configured_original_prog_id: Option<&str>,
    ) -> Result<SvpAssociationView, String> {
        let executable = validate_toolbox_executable(toolbox_executable)?;
        let detected_original =
            select_original_prog_id(configured_original_prog_id, current_prog_id().as_deref());
        let executable_text = executable.to_string_lossy();
        let command = format!("\"{executable_text}\" --svp-route \"%1\"");
        let icon = format!("\"{executable_text}\",0");
        let current_user = RegKey::predef(HKEY_CURRENT_USER);

        let (class, _) = current_user
            .create_subkey(TOOLBOX_CLASS_KEY)
            .map_err(|error| format!("无法注册 .svp 处理器：{error}"))?;
        class
            .set_value("", &"SynthV Toolbox project router")
            .map_err(|error| format!("无法写入 .svp 处理器描述：{error}"))?;
        let (default_icon, _) = class
            .create_subkey("DefaultIcon")
            .map_err(|error| format!("无法注册 .svp 图标：{error}"))?;
        default_icon
            .set_value("", &icon)
            .map_err(|error| format!("无法写入 .svp 图标：{error}"))?;
        let (open_command, _) = class
            .create_subkey(r"shell\open\command")
            .map_err(|error| format!("无法注册 .svp 打开命令：{error}"))?;
        open_command
            .set_value("", &command)
            .map_err(|error| format!("无法写入 .svp 打开命令：{error}"))?;

        let (open_with, _) = current_user
            .create_subkey(OPEN_WITH_PROG_IDS_KEY)
            .map_err(|error| format!("无法注册 .svp 打开方式候选：{error}"))?;
        open_with
            .set_raw_value(
                TOOLBOX_SVP_PROG_ID,
                &RegValue {
                    bytes: Vec::new(),
                    vtype: REG_NONE,
                },
            )
            .map_err(|error| format!("无法写入 .svp 打开方式候选：{error}"))?;

        let (capabilities, _) = current_user
            .create_subkey(CAPABILITIES_KEY)
            .map_err(|error| format!("无法注册默认应用能力：{error}"))?;
        capabilities
            .set_value("ApplicationName", &TOOLBOX_REGISTERED_APP_NAME)
            .map_err(|error| format!("无法写入默认应用名称：{error}"))?;
        capabilities
            .set_value(
                "ApplicationDescription",
                &"Routes Synthesizer V projects to an available Toolbox account.",
            )
            .map_err(|error| format!("无法写入默认应用描述：{error}"))?;
        capabilities
            .set_value("ApplicationIcon", &icon)
            .map_err(|error| format!("无法写入默认应用图标：{error}"))?;
        let (associations, _) = current_user
            .create_subkey(FILE_ASSOCIATIONS_KEY)
            .map_err(|error| format!("无法注册默认应用文件类型：{error}"))?;
        associations
            .set_value(".svp", &TOOLBOX_SVP_PROG_ID)
            .map_err(|error| format!("无法写入默认应用文件类型：{error}"))?;
        let (registered_apps, _) = current_user
            .create_subkey(REGISTERED_APPLICATIONS_KEY)
            .map_err(|error| format!("无法注册默认应用入口：{error}"))?;
        registered_apps
            .set_value(TOOLBOX_REGISTERED_APP_NAME, &CAPABILITIES_REGISTRY_PATH)
            .map_err(|error| format!("无法写入默认应用入口：{error}"))?;

        association_view(detected_original.as_deref())
    }

    pub(super) fn open_default_apps_settings() -> Result<(), String> {
        Command::new("explorer.exe")
            .arg(DEFAULT_APPS_URI)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("无法打开 Windows 默认应用设置：{error}"))
    }

    pub(super) fn passthrough(project_path: &Path, original_prog_id: &str) -> Result<(), String> {
        if handler_points_to_toolbox(original_prog_id) {
            return Err("原 .svp 处理器会再次启动 SynthV Toolbox，已阻止递归透传。".to_string());
        }
        let verb = to_wide("open");
        let project = project_path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let class = to_wide(original_prog_id);
        let mut execute = SHELLEXECUTEINFOW {
            cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_CLASSNAME,
            hwnd: null_mut(),
            lpVerb: verb.as_ptr(),
            lpFile: project.as_ptr(),
            lpParameters: null(),
            lpDirectory: null(),
            nShow: 1,
            hInstApp: null_mut(),
            lpIDList: null_mut(),
            lpClass: class.as_ptr(),
            hkeyClass: null_mut(),
            dwHotKey: 0,
            Anonymous: Default::default(),
            hProcess: null_mut(),
        };
        // SAFETY: every string buffer is NUL terminated and remains alive for the
        // duration of the synchronous ShellExecuteExW call. All unused pointers
        // are null, and cbSize matches the initialized structure.
        let launched = unsafe { ShellExecuteExW(&mut execute) };
        if launched == 0 {
            return Err(format!(
                "原 .svp 处理器启动失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    fn validate_toolbox_executable(path: &Path) -> Result<PathBuf, String> {
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            path.canonicalize()
                .map_err(|error| format!("无法解析 Toolbox 可执行文件：{error}"))?
        };
        if !path.is_file() || path.to_string_lossy().contains(['"', '\0']) {
            return Err("Toolbox 可执行文件路径无效。".to_string());
        }
        Ok(path)
    }

    fn current_prog_id() -> Option<String> {
        let current_user = RegKey::predef(HKEY_CURRENT_USER);
        read_value(&current_user, USER_CHOICE_KEY, "ProgId")
            .or_else(|| read_value(&current_user, USER_CLASSES_EXTENSION_KEY, ""))
            .or_else(extension_default_prog_id)
    }

    fn extension_default_prog_id() -> Option<String> {
        let classes_root = RegKey::predef(HKEY_CLASSES_ROOT);
        read_value(&classes_root, ".svp", "")
    }

    fn select_original_prog_id(
        configured_original_prog_id: Option<&str>,
        detected_current_prog_id: Option<&str>,
    ) -> Option<String> {
        configured_original_prog_id
            .and_then(|value| validate_original_prog_id(value).ok())
            .or_else(|| {
                detected_current_prog_id.and_then(|value| validate_original_prog_id(value).ok())
            })
            .or_else(|| {
                extension_default_prog_id().and_then(|value| validate_original_prog_id(&value).ok())
            })
    }

    fn candidate_is_registered() -> bool {
        let current_user = RegKey::predef(HKEY_CURRENT_USER);
        let command = read_value(
            &current_user,
            &format!(r"{TOOLBOX_CLASS_KEY}\shell\open\command"),
            "",
        );
        let has_command = command
            .as_deref()
            .is_some_and(|value| value.contains("--svp-route"));
        let has_open_with = current_user
            .open_subkey_with_flags(OPEN_WITH_PROG_IDS_KEY, KEY_READ)
            .ok()
            .and_then(|key| key.get_raw_value(TOOLBOX_SVP_PROG_ID).ok())
            .is_some();
        let has_registered_app = read_value(
            &current_user,
            REGISTERED_APPLICATIONS_KEY,
            TOOLBOX_REGISTERED_APP_NAME,
        )
        .as_deref()
            == Some(CAPABILITIES_REGISTRY_PATH);
        has_command && has_open_with && has_registered_app
    }

    fn handler_points_to_toolbox(prog_id: &str) -> bool {
        if is_toolbox_prog_id(prog_id) {
            return true;
        }
        let command_key = format!(r"{prog_id}\shell\open\command");
        let current_user = RegKey::predef(HKEY_CURRENT_USER);
        let classes_root = RegKey::predef(HKEY_CLASSES_ROOT);
        let command = read_value(
            &current_user,
            &format!(r"Software\Classes\{command_key}"),
            "",
        )
        .or_else(|| read_value(&classes_root, &command_key, ""));
        let Some(command) = command else {
            return false;
        };
        let command = command.to_lowercase();
        if command.contains("--svp-route") {
            return true;
        }
        let Some(executable) = std::env::current_exe().ok() else {
            return false;
        };
        let raw = executable.to_string_lossy().to_lowercase();
        if command.contains(&raw) {
            return true;
        }
        executable
            .canonicalize()
            .ok()
            .map(|path| command.contains(&path.to_string_lossy().to_lowercase()))
            .unwrap_or(false)
    }

    fn is_toolbox_prog_id(value: &str) -> bool {
        let normalized = value.trim().to_ascii_lowercase();
        let toolbox = TOOLBOX_SVP_PROG_ID.to_ascii_lowercase();
        normalized == toolbox || normalized.starts_with(&(toolbox + "\\"))
    }

    fn read_value(root: &RegKey, path: &str, name: &str) -> Option<String> {
        root.open_subkey_with_flags(path, KEY_READ)
            .ok()?
            .get_value::<String, _>(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    fn to_wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(Some(0)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn write_project(project: Value) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("svp-router-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("voice project.svp");
        fs::write(&path, serde_json::to_vec(&project).unwrap()).unwrap();
        (root, path)
    }

    #[test]
    fn extracts_main_and_group_voice_requirements_without_instrumentals() {
        let (root, path) = write_project(serde_json::json!({
            "version": 187,
            "tracks": [{
                "mainRef": {"database": {"name": "Mai 2", "version": 104, "backendType": "sv2"}},
                "groups": [
                    {"database": {"name": "SOLARIA", "version": "101", "backendType": "sv2"}},
                    {"isInstrumental": true, "database": {"name": "Not a voice", "version": 1}}
                ]
            }]
        }));

        let (_, voices) = analyze_svp_project(path.to_str().unwrap()).unwrap();

        assert_eq!(voices.len(), 2);
        assert_eq!(voices[0].name, "Mai 2");
        assert_eq!(voices[0].version, Some(104));
        assert_eq!(voices[1].name, "SOLARIA");
        assert_eq!(voices[1].version, Some(101));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn confirmed_voice_names_are_deduplicated_without_fuzzy_aliasing() {
        let voices = validate_confirmed_voice_names(vec![
            "  Mai   2 ".to_string(),
            "mai 2".to_string(),
            "Mai".to_string(),
        ])
        .unwrap();
        assert_eq!(voices, vec!["Mai", "Mai 2"]);
    }

    #[test]
    fn local_database_count_does_not_expose_opaque_ids() {
        let root = std::env::temp_dir().join(format!("svp-inventory-test-{}", Uuid::new_v4()));
        let version = root.join("databases").join("opaque-license-id").join("104");
        fs::create_dir_all(&version).unwrap();
        fs::write(version.join("model.dnni"), b"opaque").unwrap();

        let inventory = inspect_voice_inventory(&root, &[]);

        assert_eq!(inventory.installed_opaque_count, 1);
        assert_eq!(inventory.status, Sv2VoiceInventoryStatus::LocalEvidence);
        assert!(!inventory.detail.contains("opaque-license-id"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn activation_resolves_one_relative_project_against_callback_cwd() {
        let (root, path) = write_project(serde_json::json!({"tracks": []}));
        let args = vec![
            "synthv-toolbox.exe".to_string(),
            "--svp-route".to_string(),
            path.file_name().unwrap().to_string_lossy().into_owned(),
        ];

        let activation = parse_svp_activation(&args, root.to_str()).unwrap().unwrap();

        assert_eq!(
            PathBuf::from(activation.project_path),
            path.canonicalize().unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn activation_ignores_normal_start_and_rejects_ambiguous_route_args() {
        assert!(
            parse_svp_activation(&["synthv-toolbox.exe".to_string()], None)
                .unwrap()
                .is_none()
        );
        let duplicate = vec![
            "--svp-route".to_string(),
            "first.svp".to_string(),
            "--svp-route".to_string(),
            "second.svp".to_string(),
        ];
        assert!(parse_svp_activation(&duplicate, None).is_err());
        let extra = vec![
            "--svp-route".to_string(),
            "project.svp".to_string(),
            "unexpected".to_string(),
        ];
        assert!(parse_svp_activation(&extra, None).is_err());
    }

    #[test]
    fn project_route_requires_an_existing_svp_regular_file() {
        let root = std::env::temp_dir().join(format!("svp-path-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let wrong_extension = root.join("project.json");
        let uppercase_extension = root.join("project.SVP");
        fs::write(&wrong_extension, b"{}").unwrap();
        fs::write(&uppercase_extension, b"{}").unwrap();

        assert!(resolve_project_path(wrong_extension.to_str().unwrap(), None).is_err());
        assert!(resolve_project_path(root.to_str().unwrap(), None).is_err());
        assert!(resolve_project_path(uppercase_extension.to_str().unwrap(), None).is_ok());
        assert!(resolve_project_path(root.join("missing.svp").to_str().unwrap(), None).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn original_handler_cannot_point_back_to_toolbox() {
        assert!(validate_original_prog_id(TOOLBOX_SVP_PROG_ID).is_err());
        assert!(validate_original_prog_id("synthvtoolbox.svp\\shell").is_err());
        assert_eq!(
            validate_original_prog_id("Dreamtonics.svpfile").unwrap(),
            "Dreamtonics.svpfile"
        );
    }
}
