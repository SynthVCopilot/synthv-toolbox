use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::mcp::McpManager;
use crate::synthv::quiet_command;

const BRIDGE_START_KEY: &str = "F13";
const BRIDGE_STOP_KEY: &str = "F14";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthVProcess {
    pub process_id: u32,
    pub name: String,
    pub command: String,
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
    Stop,
    Save,
}

impl BridgeShortcutAction {
    pub fn label(self) -> &'static str {
        match self {
            Self::Start => BRIDGE_START_KEY,
            Self::Stop => BRIDGE_STOP_KEY,
            Self::Save => {
                if cfg!(target_os = "macos") {
                    "⌘S"
                } else {
                    "Ctrl+S"
                }
            }
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

pub async fn start_bridge_and_connect(
    process_id: u32,
    manager: &McpManager,
    node: String,
    bridge_dir: PathBuf,
) -> Result<(SynthVProcess, Vec<String>), String> {
    let process = tauri::async_runtime::spawn_blocking(move || {
        send_shortcut(process_id, BridgeShortcutAction::Start)
    })
    .await
    .map_err(|error| error.to_string())??;
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
    let text = format!("{name}\n{command}").to_ascii_lowercase();
    text.contains("synthv-studio") || text.contains("synthesizer v studio")
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    pub(super) fn list_processes() -> Result<Vec<SynthVProcess>, String> {
        let output = quiet_command("ps")
            .args(["-axo", "pid=,comm=,args="])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|error| format!("无法枚举 macOS 进程：{error}"))?;
        if !output.status.success() {
            return Err("macOS 进程枚举失败。".to_string());
        }
        let mut processes = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                let process_id = fields.next()?.parse::<u32>().ok()?;
                let name = fields.next()?.to_string();
                let command = fields.collect::<Vec<_>>().join(" ");
                is_synthv_process(&name, &command).then_some(SynthVProcess {
                    process_id,
                    name,
                    command,
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
        let key = match action {
            BridgeShortcutAction::Start => "key code 105".to_string(),
            BridgeShortcutAction::Stop => "key code 107".to_string(),
            BridgeShortcutAction::Save => "keystroke \"s\" using command down".to_string(),
        };
        let focus = format!(
            "tell application \"System Events\" to tell (first process whose unix id is {process_id}) to set frontmost to true"
        );
        let key = format!("tell application \"System Events\" to {key}");
        let output = quiet_command("osascript")
            .args(["-e", &focus, "-e", "delay 0.12", "-e", &key])
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
}

#[cfg(windows)]
mod platform {
    use std::mem::{size_of, zeroed};

    use windows_sys::Win32::Foundation::{BOOL, LPARAM};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow, ShowWindow,
        SW_RESTORE,
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
            if is_synthv_process(&name, &name) {
                processes.push(SynthVProcess {
                    process_id: entry.th32ProcessID,
                    command: name.clone(),
                    name,
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
        let mut hwnd = 0isize;
        unsafe {
            EnumWindows(
                Some(find_visible_window),
                &mut WindowLookup {
                    process_id,
                    hwnd: &mut hwnd,
                } as *mut _ as LPARAM,
            );
        }
        if hwnd == 0 {
            return Err("未找到可聚焦的 SynthV 窗口。".to_string());
        }
        unsafe {
            ShowWindow(hwnd, SW_RESTORE);
            if SetForegroundWindow(hwnd) == 0 {
                return Err("Windows 拒绝聚焦 SynthV 窗口。".to_string());
            }
        }
        let mut input = match action {
            BridgeShortcutAction::Start => vec![
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

    struct WindowLookup {
        process_id: u32,
        hwnd: *mut isize,
    }

    unsafe extern "system" fn find_visible_window(hwnd: isize, lparam: LPARAM) -> BOOL {
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
}
