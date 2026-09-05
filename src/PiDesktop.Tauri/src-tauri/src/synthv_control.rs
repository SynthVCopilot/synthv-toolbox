use std::path::PathBuf;
use std::time::Duration;

#[cfg(target_os = "macos")]
use std::process::Stdio;

use serde::{Deserialize, Serialize};

use crate::mcp::McpManager;
#[cfg(target_os = "macos")]
use crate::synthv::quiet_command;

const BRIDGE_START_KEY: &str = "F13";
const BRIDGE_STOP_KEY: &str = "F14";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthVProcess {
    pub process_id: u32,
    pub process_identity: String,
    pub name: String,
    pub product_name: String,
    pub version: String,
    pub command: String,
    pub window_title: String,
    pub is_sv2: bool,
    pub sandboxed: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthVShortcutProfile {
    pub bridge_start: String,
    pub bridge_stop: String,
    pub project_save: String,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BridgeShortcutAction {
    Start,
    StartLegacy,
    Stop,
    Save,
    Undo,
    Refresh,
}

impl BridgeShortcutAction {
    pub fn label(self) -> &'static str {
        match self {
            Self::Start | Self::StartLegacy => BRIDGE_START_KEY,
            Self::Stop => BRIDGE_STOP_KEY,
            Self::Save => {
                if cfg!(target_os = "macos") {
                    "⌘S"
                } else {
                    "Ctrl+S"
                }
            }
            Self::Undo => {
                if cfg!(target_os = "macos") {
                    "⌘Z"
                } else {
                    "Ctrl+Z"
                }
            }
            Self::Refresh => "F5",
        }
    }
}

pub fn shortcut_profile() -> SynthVShortcutProfile {
    SynthVShortcutProfile {
        bridge_start: BRIDGE_START_KEY.to_string(),
        bridge_stop: BRIDGE_STOP_KEY.to_string(),
        project_save: if cfg!(target_os = "macos") { "⌘S" } else { "Ctrl+S" }.to_string(),
        detail: "F13 触发 Bridge 启动或重连，F14 触发停止；Cover 保存使用标准 Ctrl/⌘+S。快捷键直接发送到被聚焦的 SynthV 进程。"
            .to_string(),
    }
}

pub fn list_processes() -> Result<Vec<SynthVProcess>, String> {
    platform::list_processes()
}

pub fn send_shortcut(
    process_id: u32,
    action: BridgeShortcutAction,
) -> Result<SynthVProcess, String> {
    let process = list_processes()?
        .into_iter()
        .find(|process| process.process_id == process_id)
        .ok_or_else(|| format!("没有找到 PID {process_id} 对应的 SynthV 进程。"))?;
    platform::focus_and_send(process_id, action)?;
    Ok(process)
}

pub fn focus_instance(process_id: u32, process_identity: String) -> Result<SynthVProcess, String> {
    let process = validate_instance_target(process_id, &process_identity)?;
    platform::focus_verified(process_id, &process_identity)?;
    Ok(process)
}

pub fn terminate_instance(
    process_id: u32,
    process_identity: String,
) -> Result<SynthVProcess, String> {
    let process = validate_instance_target(process_id, &process_identity)?;
    platform::terminate_verified(process_id, &process_identity)?;
    Ok(process)
}

fn validate_instance_target(
    process_id: u32,
    process_identity: &str,
) -> Result<SynthVProcess, String> {
    if process_identity.trim().is_empty() {
        return Err("实例身份令牌不能为空。".to_string());
    }
    let process = list_processes()?
        .into_iter()
        .find(|process| process.process_id == process_id)
        .ok_or_else(|| format!("没有找到 PID {process_id} 对应的 SynthV 实例。"))?;
    if !matches_control_target(&process, process_identity) {
        return Err("目标实例已变化或不是 SynthV 实例，操作已取消。".to_string());
    }
    Ok(process)
}

fn matches_control_target(process: &SynthVProcess, process_identity: &str) -> bool {
    !process.process_identity.is_empty()
        && process.process_identity == process_identity
        && is_synthv_process(&process.name, &process.command)
}

pub async fn start_bridge(process_id: u32) -> Result<SynthVProcess, String> {
    tauri::async_runtime::spawn_blocking(move || {
        send_shortcut(process_id, BridgeShortcutAction::Start)
    })
    .await
    .map_err(|error| error.to_string())?
}

pub async fn start_bridge_and_connect(
    process_id: u32,
    manager: &McpManager,
    node: String,
    bridge_dir: PathBuf,
) -> Result<(SynthVProcess, Vec<String>), String> {
    let process = start_bridge(process_id).await?;
    let mut last_error = "Bridge 尚未就绪。".to_string();
    for _ in 0..16 {
        manager.disconnect("synthv").await;
        match manager
            .connect_bridge(node.clone(), bridge_dir.clone())
            .await
        {
            Ok(tools) => return Ok((process, tools)),
            Err(error) => last_error = error,
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(format!(
        "已向 PID {} 发送 {}，但 Bridge 未在 4 秒内就绪：{last_error}",
        process.process_id,
        BridgeShortcutAction::Start.label(),
    ))
}

fn is_synthv_process(name: &str, command: &str) -> bool {
    if is_flat_executable_name(name) || is_flat_executable_name(command) {
        return true;
    }
    is_sv1_executable_path(command) || is_sv2_executable_path(command)
}

fn is_sv1_executable_path(path: &str) -> bool {
    let value = path
        .trim()
        .trim_matches('"')
        .replace('\\', "/")
        .to_ascii_lowercase();
    let file_name = value.rsplit('/').next().unwrap_or_default();
    let known_directory = value
        .split('/')
        .any(|part| matches!(part, "synthesizer v studio" | "synthesizer v studio pro"));
    value.contains('/')
        && (matches!(file_name, "synthesizer v studio.exe" | "svstudio.exe")
            || (known_directory && matches!(file_name, "synthv-studio.exe" | "synthv-studio")))
}

fn is_sv2_executable_path(path: &str) -> bool {
    let value = path
        .trim()
        .trim_matches('"')
        .replace('\\', "/")
        .to_ascii_lowercase();
    let file_name = value.rsplit('/').next().unwrap_or_default();
    let explicit_name = matches!(
        file_name,
        "synthesizer v studio 2 pro.exe"
            | "synthesizer v studio 2.exe"
            | "svstudio2-pro.exe"
            | "svstudio2.exe"
            | "svstudio2 pro"
            | "svstudio2"
    );
    let known_directory = value.split('/').any(|part| {
        matches!(
            part,
            "synthesizer v studio 2"
                | "synthesizer v studio 2 pro"
                | "synthesizer v studio 2.app"
                | "synthesizer v studio 2 pro.app"
                | "svstudio2 pro.app"
                | "svstudio2.app"
        )
    });
    value.contains('/')
        && (explicit_name
            || (known_directory && matches!(file_name, "synthv-studio.exe" | "synthv-studio")))
}

fn product_name(path: &str, is_sv2: bool) -> String {
    if !is_sv2 && is_sv1_executable_path(path) {
        return "Synthesizer V Studio".to_string();
    }
    if !is_sv2 {
        return "Synthesizer V Flat".to_string();
    }
    let value = path.replace('\\', "/").to_ascii_lowercase();
    let file_name = value.rsplit('/').next().unwrap_or_default();
    let is_pro = matches!(
        file_name,
        "svstudio2-pro.exe" | "synthesizer v studio 2 pro.exe"
    ) || value.split('/').any(|part| {
        matches!(
            part,
            "synthesizer v studio 2 pro" | "synthesizer v studio 2 pro.app" | "svstudio2 pro.app"
        )
    });
    if is_pro {
        "SVStudio2 Pro".to_string()
    } else {
        "SVStudio2".to_string()
    }
}

#[cfg(any(target_os = "macos", test))]
fn parse_macos_processes(output: &str) -> Vec<(u32, String, String)> {
    output
        .lines()
        .filter_map(|line| {
            let mut remainder = line.trim_start();
            let process_id = take_process_field(&mut remainder)?.parse::<u32>().ok()?;
            let started = (0..5)
                .map(|_| take_process_field(&mut remainder))
                .collect::<Option<Vec<_>>>()?
                .join(" ");
            let command = remainder.trim_start().to_string();
            (!command.is_empty()).then_some((
                process_id,
                format!("macos:{process_id}:{started}"),
                command,
            ))
        })
        .collect()
}

#[cfg(any(target_os = "macos", test))]
fn take_process_field<'a>(remainder: &mut &'a str) -> Option<&'a str> {
    *remainder = remainder.trim_start();
    let end = remainder
        .find(char::is_whitespace)
        .unwrap_or(remainder.len());
    let field = &remainder[..end];
    *remainder = &remainder[end..];
    (!field.is_empty()).then_some(field)
}

#[cfg(target_os = "macos")]
fn executable_name(command: &str) -> String {
    command
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string()
}

fn is_flat_executable_name(value: &str) -> bool {
    let trimmed = value.trim().trim_matches('"');
    let file_name = std::path::Path::new(trimmed)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(trimmed);
    matches!(
        file_name.to_ascii_lowercase().as_str(),
        "synthesizer v flat" | "synthesizer v flat.exe" | "synthesizer-v-flat.exe"
    )
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    pub(super) fn list_processes() -> Result<Vec<SynthVProcess>, String> {
        let output = quiet_command("ps")
            .args(["-axo", "pid=,lstart=,comm="])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|error| format!("无法枚举 macOS 进程：{error}"))?;
        if !output.status.success() {
            return Err("macOS 进程枚举失败。".to_string());
        }
        let mut processes = parse_macos_processes(&String::from_utf8_lossy(&output.stdout))
            .into_iter()
            .filter_map(|(process_id, process_identity, command)| {
                let name = executable_name(&command);
                let is_sv2 = is_sv2_executable_path(&command);
                is_synthv_process(&name, &command).then_some(SynthVProcess {
                    process_id,
                    process_identity,
                    name,
                    product_name: product_name(&command, is_sv2),
                    version: macos_bundle_version(&command),
                    window_title: macos_window_title(process_id),
                    is_sv2,
                    command,
                    sandboxed: Some(false),
                })
            })
            .collect::<Vec<_>>();
        processes.sort_by_key(|process| process.process_id);
        Ok(processes)
    }

    pub(super) fn focus_and_send(
        process_id: u32,
        action: BridgeShortcutAction,
    ) -> Result<(), String> {
        let command = match action {
            BridgeShortcutAction::Start => "key code 105".to_string(),
            BridgeShortcutAction::StartLegacy => format!(
                "tell application \"System Events\" to tell (first process whose unix id is {process_id}) to click menu item \"SynthV Agent Bridge SV1 Legacy\" of menu 1 of menu item \"SynthV Agent Bridge\" of menu \"Scripts\" of menu bar 1"
            ),
            BridgeShortcutAction::Stop => "key code 107".to_string(),
            BridgeShortcutAction::Save => "keystroke \"s\" using command down".to_string(),
            BridgeShortcutAction::Undo => "keystroke \"z\" using command down".to_string(),
            BridgeShortcutAction::Refresh => format!(
                "tell application \"System Events\" to tell (first process whose unix id is {process_id}) to click menu item \"Rescan\" of menu \"Scripts\" of menu bar 1"
            ),
        };
        let focus = format!(
            "tell application \"System Events\" to tell (first process whose unix id is {process_id}) to set frontmost to true"
        );
        let command = if matches!(
            action,
            BridgeShortcutAction::StartLegacy | BridgeShortcutAction::Refresh
        ) {
            command
        } else {
            format!("tell application \"System Events\" to {command}")
        };
        let output = quiet_command("osascript")
            .args(["-e", &focus, "-e", "delay 0.12", "-e", &command])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|error| format!("无法向 SynthV 发送 {}：{error}", action.label()))?;
        if output.status.success() {
            Ok(())
        } else {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(format!(
                "无法向 SynthV 发送 {}。请在 macOS“辅助功能”中允许 SynthV Toolbox 控制电脑。{}",
                action.label(),
                if detail.is_empty() {
                    String::new()
                } else {
                    format!(" {detail}")
                }
            ))
        }
    }

    pub(super) fn focus_verified(process_id: u32, _process_identity: &str) -> Result<(), String> {
        let focus = format!(
            "tell application \"System Events\" to tell (first process whose unix id is {process_id}) to set frontmost to true"
        );
        let output = quiet_command("osascript")
            .args(["-e", &focus])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|error| format!("无法聚焦 SynthV：{error}"))?;
        output.status.success().then_some(()).ok_or_else(|| {
            "无法聚焦 SynthV。请在 macOS“辅助功能”中允许 SynthV Toolbox 控制电脑。".to_string()
        })
    }

    pub(super) fn terminate_verified(
        process_id: u32,
        _process_identity: &str,
    ) -> Result<(), String> {
        let result = unsafe { libc::kill(process_id as i32, libc::SIGTERM) };
        (result == 0)
            .then_some(())
            .ok_or_else(|| format!("无法终止 PID {process_id} 对应的 SynthV 实例。"))
    }

    fn macos_bundle_version(command: &str) -> String {
        let Some(index) = command.to_ascii_lowercase().find(".app/") else {
            return String::new();
        };
        let bundle = &command[..index + 4];
        let output = quiet_command("mdls")
            .args(["-name", "kMDItemVersion", "-raw", bundle])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();
        output
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .filter(|version| !version.is_empty() && version != "(null)")
            .unwrap_or_default()
    }

    fn macos_window_title(process_id: u32) -> String {
        let script = format!(
            "tell application \"System Events\" to tell (first process whose unix id is {process_id}) to get name of front window"
        );
        quiet_command("osascript")
            .args(["-e", &script])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .unwrap_or_default()
    }
}

#[cfg(windows)]
mod platform {
    use std::mem::{size_of, zeroed};
    use std::ptr::null_mut;

    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible, SetForegroundWindow, ShowWindow, GW_OWNER, SW_RESTORE,
    };

    use super::*;

    pub(super) fn list_processes() -> Result<Vec<SynthVProcess>, String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            return Err("无法枚举 Windows 进程。".to_string());
        }
        let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut processes = Vec::new();
        let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        while ok {
            let name = wide_text(&entry.szExeFile);
            let command = process_image_path(entry.th32ProcessID).unwrap_or_else(|| name.clone());
            if is_synthv_process(&name, &command) {
                let is_sv2 = is_sv2_executable_path(&command);
                processes.push(SynthVProcess {
                    process_id: entry.th32ProcessID,
                    process_identity: process_identity(entry.th32ProcessID).unwrap_or_default(),
                    command: command.clone(),
                    name,
                    product_name: product_name(&command, is_sv2),
                    version: file_version(&command).unwrap_or_default(),
                    window_title: window_title(entry.th32ProcessID),
                    is_sv2,
                    sandboxed: sandboxed(entry.th32ProcessID),
                });
            }
            ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        unsafe { windows_sys::Win32::Foundation::CloseHandle(snapshot) };
        processes.sort_by_key(|process| process.process_id);
        Ok(processes)
    }

    pub(super) fn focus_and_send(
        process_id: u32,
        action: BridgeShortcutAction,
    ) -> Result<(), String> {
        focus_window(process_id)?;
        let mut input = match action {
            BridgeShortcutAction::Start | BridgeShortcutAction::StartLegacy => vec![
                keyboard_input(0x7C, 0),
                keyboard_input(0x7C, KEYEVENTF_KEYUP),
            ],
            BridgeShortcutAction::Stop => vec![
                keyboard_input(0x7D, 0),
                keyboard_input(0x7D, KEYEVENTF_KEYUP),
            ],
            BridgeShortcutAction::Save => vec![
                keyboard_input(0x11, 0),
                keyboard_input(0x53, 0),
                keyboard_input(0x53, KEYEVENTF_KEYUP),
                keyboard_input(0x11, KEYEVENTF_KEYUP),
            ],
            BridgeShortcutAction::Undo => vec![
                keyboard_input(0x11, 0),
                keyboard_input(0x5A, 0),
                keyboard_input(0x5A, KEYEVENTF_KEYUP),
                keyboard_input(0x11, KEYEVENTF_KEYUP),
            ],
            BridgeShortcutAction::Refresh => vec![
                keyboard_input(0x74, 0),
                keyboard_input(0x74, KEYEVENTF_KEYUP),
            ],
        };
        let sent = unsafe {
            SendInput(
                input.len() as u32,
                input.as_mut_ptr(),
                size_of::<INPUT>() as i32,
            )
        };
        if sent == input.len() as u32 {
            Ok(())
        } else {
            Err(format!("无法向 SynthV 发送 {}。", action.label()))
        }
    }

    pub(super) fn focus_verified(process_id: u32, process_identity: &str) -> Result<(), String> {
        let handle = open_verified_process(process_id, process_identity, false)?;
        let result = focus_window(process_id);
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        result
    }

    fn focus_window(process_id: u32) -> Result<(), String> {
        let mut hwnd: HWND = null_mut();
        unsafe {
            EnumWindows(
                Some(find_visible_window),
                &mut WindowLookup {
                    process_id,
                    hwnd: &mut hwnd,
                } as *mut _ as LPARAM,
            );
        }
        if hwnd.is_null() {
            return Err("未找到可聚焦的 SynthV 窗口。".to_string());
        }
        unsafe {
            ShowWindow(hwnd, SW_RESTORE);
            if SetForegroundWindow(hwnd) == 0 {
                return Err("Windows 拒绝聚焦 SynthV 窗口。".to_string());
            }
        }
        Ok(())
    }

    pub(super) fn terminate_verified(
        process_id: u32,
        process_identity: &str,
    ) -> Result<(), String> {
        use windows_sys::Win32::System::Threading::TerminateProcess;

        let handle = open_verified_process(process_id, process_identity, true)?;
        let terminated = unsafe { TerminateProcess(handle, 0) } != 0;
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        terminated
            .then_some(())
            .ok_or_else(|| format!("无法终止 PID {process_id} 对应的 SynthV 实例。"))
    }

    fn open_verified_process(
        process_id: u32,
        process_identity: &str,
        terminate: bool,
    ) -> Result<windows_sys::Win32::Foundation::HANDLE, String> {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
        };

        let access =
            PROCESS_QUERY_LIMITED_INFORMATION | if terminate { PROCESS_TERMINATE } else { 0 };
        let handle = unsafe { OpenProcess(access, 0, process_id) };
        if handle.is_null() {
            return Err(format!("无法打开 PID {process_id} 对应的 SynthV 实例。"));
        }
        let identity = process_identity_from_handle(handle, process_id);
        let image = process_image_path_from_handle(handle);
        let valid = identity.as_deref() == Some(process_identity)
            && image
                .as_deref()
                .is_some_and(is_strict_synthv_executable_path);
        if !valid {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            return Err("目标实例已变化或不是 SynthV 实例，操作已取消。".to_string());
        }
        Ok(handle)
    }

    struct WindowLookup {
        process_id: u32,
        hwnd: *mut HWND,
    }

    struct WindowTitleLookup {
        process_id: u32,
        title: String,
        owned_title: String,
    }

    fn window_title(process_id: u32) -> String {
        let mut lookup = WindowTitleLookup {
            process_id,
            title: String::new(),
            owned_title: String::new(),
        };
        unsafe {
            EnumWindows(Some(find_window_title), &mut lookup as *mut _ as LPARAM);
        }
        if lookup.title.is_empty() {
            lookup.owned_title
        } else {
            lookup.title
        }
    }

    fn process_image_path(process_id: u32) -> Option<String> {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
        if handle.is_null() {
            return None;
        }
        let result = process_image_path_from_handle(handle);
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(handle);
        }
        result
    }

    fn process_image_path_from_handle(
        handle: windows_sys::Win32::Foundation::HANDLE,
    ) -> Option<String> {
        use windows_sys::Win32::System::Threading::QueryFullProcessImageNameW;

        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        let ok =
            unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) } != 0;
        ok.then(|| String::from_utf16_lossy(&buffer[..length as usize]))
    }

    fn process_identity(process_id: u32) -> Option<String> {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
        if handle.is_null() {
            return None;
        }
        let result = process_identity_from_handle(handle, process_id);
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        result
    }

    fn process_identity_from_handle(
        handle: windows_sys::Win32::Foundation::HANDLE,
        process_id: u32,
    ) -> Option<String> {
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::System::Threading::GetProcessTimes;

        let mut created: FILETIME = unsafe { zeroed() };
        let mut exited: FILETIME = unsafe { zeroed() };
        let mut kernel: FILETIME = unsafe { zeroed() };
        let mut user: FILETIME = unsafe { zeroed() };
        let ok =
            unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }
                != 0;
        ok.then(|| {
            let created =
                (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
            format!("windows:{process_id}:{created}")
        })
    }

    fn file_version(path: &str) -> Option<String> {
        use std::ffi::c_void;
        use std::os::windows::ffi::OsStrExt;
        use std::ptr::null_mut;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
        };

        let path = std::ffi::OsStr::new(path)
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), null_mut()) };
        if size == 0 {
            return None;
        }
        let mut data = vec![0_u8; size as usize];
        if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, data.as_mut_ptr().cast()) } == 0 {
            return None;
        }
        let mut value: *mut c_void = null_mut();
        let mut length = 0_u32;
        let root = ['\\' as u16, 0];
        if unsafe { VerQueryValueW(data.as_ptr().cast(), root.as_ptr(), &mut value, &mut length) }
            == 0
            || length < std::mem::size_of::<VS_FIXEDFILEINFO>() as u32
        {
            return None;
        }
        if value.is_null() {
            return None;
        }
        let fixed = unsafe { std::ptr::read_unaligned(value.cast::<VS_FIXEDFILEINFO>()) };
        (fixed.dwSignature == 0xFEEF_04BD).then(|| {
            format!(
                "{}.{}.{}",
                fixed.dwFileVersionMS >> 16,
                fixed.dwFileVersionMS & 0xffff,
                fixed.dwFileVersionLS >> 16
            )
        })
    }

    fn sandboxed(process_id: u32) -> Option<bool> {
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            Module32FirstW, MODULEENTRY32W, TH32CS_SNAPMODULE, TH32CS_SNAPMODULE32,
        };
        let snapshot = unsafe {
            CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, process_id)
        };
        if snapshot == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            return None;
        }
        let mut module: MODULEENTRY32W = unsafe { zeroed() };
        module.dwSize = size_of::<MODULEENTRY32W>() as u32;
        let mut found = false;
        let mut ok = unsafe { Module32FirstW(snapshot, &mut module) } != 0;
        if !ok {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(snapshot);
            }
            return None;
        }
        while ok {
            if wide_text(&module.szModule).eq_ignore_ascii_case("SbieDll.dll") {
                found = true;
                break;
            }
            ok = unsafe {
                windows_sys::Win32::System::Diagnostics::ToolHelp::Module32NextW(
                    snapshot,
                    &mut module,
                )
            } != 0;
        }
        let completed = found
            || unsafe { windows_sys::Win32::Foundation::GetLastError() }
                == windows_sys::Win32::Foundation::ERROR_NO_MORE_FILES;
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(snapshot);
        }
        completed.then_some(found)
    }

    unsafe extern "system" fn find_window_title(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let lookup = &mut *(lparam as *mut WindowTitleLookup);
        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, &mut process_id);
        if process_id != lookup.process_id {
            return 1;
        }
        let length = GetWindowTextLengthW(hwnd);
        if length <= 0 {
            return 1;
        }
        let mut buffer = vec![0u16; length as usize + 1];
        let actual = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
        let title = wide_text(&buffer[..actual.max(0) as usize]);
        if title.is_empty() {
            return 1;
        }
        if GetWindow(hwnd, GW_OWNER).is_null() {
            lookup.title = title;
        } else if lookup.owned_title.is_empty() {
            lookup.owned_title = title;
        }
        1
    }

    unsafe extern "system" fn find_visible_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let lookup = &mut *(lparam as *mut WindowLookup);
        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, &mut process_id);
        if process_id == lookup.process_id {
            *lookup.hwnd = hwnd;
            0
        } else {
            1
        }
    }

    fn keyboard_input(virtual_key: u16, flags: u32) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: virtual_key,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn wide_text(value: &[u16]) -> String {
        let length = value
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(value.len());
        String::from_utf16_lossy(&value[..length])
    }
}

#[cfg(windows)]
fn is_strict_synthv_executable_path(path: &str) -> bool {
    is_sv1_executable_path(path) || is_sv2_executable_path(path) || is_flat_executable_name(path)
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::*;

    pub(super) fn list_processes() -> Result<Vec<SynthVProcess>, String> {
        Ok(Vec::new())
    }

    pub(super) fn focus_and_send(
        _process_id: u32,
        _action: BridgeShortcutAction,
    ) -> Result<(), String> {
        Err("当前平台尚未实现 SynthV 进程快捷键控制。".to_string())
    }

    pub(super) fn focus_verified(_process_id: u32, _process_identity: &str) -> Result<(), String> {
        Err("当前平台尚未实现 SynthV 实例聚焦。".to_string())
    }

    pub(super) fn terminate_verified(
        _process_id: u32,
        _process_identity: &str,
    ) -> Result<(), String> {
        Err("当前平台尚未实现 SynthV 实例终止。".to_string())
    }
}

#[cfg(test)]
#[path = "../../../../test/synthv_control_tests.rs"]
mod tests;
