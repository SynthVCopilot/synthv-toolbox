use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthVInstallation {
    pub display_name: String,
    pub install_path: Option<String>,
    pub executable_path: Option<String>,
    pub scripts_path: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub succeeded: bool,
    pub summary: String,
    pub detail: String,
}

pub fn scan_installations() -> Vec<SynthVInstallation> {
    let mut found = Vec::new();
    let home = home_dir();

    #[cfg(target_os = "macos")]
    {
        for (name, path) in [
            (
                "Synthesizer V Studio 2 Pro",
                PathBuf::from("/Applications/Synthesizer V Studio 2 Pro.app"),
            ),
            (
                "Synthesizer V Studio Pro",
                PathBuf::from("/Applications/Synthesizer V Studio Pro.app"),
            ),
        ] {
            add_installation(&mut found, name, Some(path), None, "macOS Applications");
        }
        if let Some(home) = &home {
            for (name, relative) in [
                (
                    "Synthesizer V Studio 2",
                    "Library/Application Support/Dreamtonics/Synthesizer V Studio 2/scripts",
                ),
                (
                    "Synthesizer V Studio",
                    "Library/Application Support/Dreamtonics/Synthesizer V Studio/scripts",
                ),
            ] {
                add_installation(
                    &mut found,
                    name,
                    None,
                    Some(home.join(relative)),
                    "macOS 用户脚本目录",
                );
            }
        }
        add_installation(
            &mut found,
            "Synthesizer V Studio",
            None,
            Some(PathBuf::from(
                "/Library/Application Support/Dreamtonics/Synthesizer V Studio/scripts",
            )),
            "macOS 系统脚本目录",
        );
    }

    #[cfg(windows)]
    {
        scan_windows_registry(&mut found);
        if let Some(app_data) = std::env::var_os("APPDATA").map(PathBuf::from) {
            for folder in ["Synthesizer V Studio 2", "Synthesizer V Studio"] {
                add_installation(
                    &mut found,
                    folder,
                    None,
                    Some(app_data.join("Dreamtonics").join(folder).join("scripts")),
                    "Windows 用户脚本目录",
                );
            }
        }
        if let Some(home) = &home {
            add_installation(
                &mut found,
                "Synthesizer V Studio",
                None,
                Some(
                    home.join("Documents")
                        .join("Dreamtonics")
                        .join("Synthesizer V Studio")
                        .join("scripts"),
                ),
                "Windows 文档脚本目录",
            );
        }
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(program_files) = std::env::var_os(variable).map(PathBuf::from) {
                for folder in [
                    "Synthesizer V Studio 2",
                    "Synthesizer V Studio Pro",
                    "Synthesizer V Studio",
                ] {
                    add_installation(
                        &mut found,
                        folder,
                        Some(program_files.join("Dreamtonics").join(folder)),
                        None,
                        "Windows 标准安装目录",
                    );
                }
            }
        }
    }

    found.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    found.dedup_by(|left, right| {
        left.executable_path == right.executable_path
            && left.install_path == right.install_path
            && left.scripts_path == right.scripts_path
    });
    found
}

fn add_installation(
    found: &mut Vec<SynthVInstallation>,
    name: &str,
    install_path: Option<PathBuf>,
    scripts_path: Option<PathBuf>,
    source: &str,
) {
    let install_exists = install_path.as_ref().is_some_and(|path| path.exists());
    let scripts_exists = scripts_path.as_ref().is_some_and(|path| path.is_dir());
    if !install_exists && !scripts_exists {
        return;
    }
    let executable_path = install_path
        .as_deref()
        .and_then(find_executable_in)
        .map(|path| normalized_path_string(&path));
    found.push(SynthVInstallation {
        display_name: name.to_string(),
        install_path: install_path
            .filter(|_| install_exists)
            .map(|path| normalized_path_string(&path)),
        executable_path,
        scripts_path: scripts_path
            .filter(|_| scripts_exists)
            .map(|path| normalized_path_string(&path)),
        source: source.to_string(),
    });
}

pub fn normalized_path_string(path: &Path) -> String {
    path.components()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned()
}

pub fn find_sv2_executable() -> Option<PathBuf> {
    scan_installations()
        .into_iter()
        .filter(|installation| installation.display_name.contains("Studio 2"))
        .filter_map(|installation| installation.executable_path.map(PathBuf::from))
        .find(|path| path.is_file())
}

fn find_executable_in(install_path: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    let candidates = [
        install_path.join("synthv-studio.exe"),
        install_path.join("Synthesizer V Studio 2 Pro.exe"),
        install_path.join("Synthesizer V Studio Pro.exe"),
        install_path.join("Synthesizer V Studio.exe"),
    ];
    #[cfg(target_os = "macos")]
    let candidates = [
        install_path.join("Contents/MacOS/synthv-studio"),
        install_path.join("Contents/MacOS/Synthesizer V Studio 2 Pro"),
        install_path.join("Contents/MacOS/Synthesizer V Studio Pro"),
        install_path.join("Contents/MacOS/Synthesizer V Studio"),
    ];
    #[cfg(not(any(windows, target_os = "macos")))]
    let candidates: [PathBuf; 0] = [];
    candidates.into_iter().find(|candidate| candidate.is_file())
}

#[cfg(windows)]
fn scan_windows_registry(found: &mut Vec<SynthVInstallation>) {
    use winreg::enums::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
    };
    use winreg::RegKey;

    const UNINSTALL: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    for (hive, hive_name) in [(HKEY_CURRENT_USER, "HKCU"), (HKEY_LOCAL_MACHINE, "HKLM")] {
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let root = RegKey::predef(hive);
            let Ok(uninstall) = root.open_subkey_with_flags(UNINSTALL, KEY_READ | view) else {
                continue;
            };
            for child_name in uninstall.enum_keys().flatten() {
                let Ok(entry) = uninstall.open_subkey_with_flags(&child_name, KEY_READ | view)
                else {
                    continue;
                };
                let Ok(display_name) = entry.get_value::<String, _>("DisplayName") else {
                    continue;
                };
                if !display_name.to_ascii_lowercase().contains("synthesizer v") {
                    continue;
                }
                let install_path = entry
                    .get_value::<String, _>("InstallLocation")
                    .ok()
                    .and_then(|value| normalize_install_path(&value))
                    .or_else(|| {
                        entry
                            .get_value::<String, _>("DisplayIcon")
                            .ok()
                            .and_then(|value| normalize_icon_install_path(&value))
                    });
                add_installation(
                    found,
                    &display_name,
                    install_path,
                    None,
                    &format!("Windows 已安装应用 ({hive_name})"),
                );
            }
        }
    }
}

#[cfg(windows)]
fn normalize_install_path(value: &str) -> Option<PathBuf> {
    let path = PathBuf::from(value.trim().trim_matches('"'));
    path.is_dir().then_some(path)
}

#[cfg(windows)]
fn normalize_icon_install_path(value: &str) -> Option<PathBuf> {
    let value = value.trim().trim_matches('"');
    let without_index = value
        .rsplit_once(',')
        .filter(|(_, suffix)| suffix.parse::<i32>().is_ok())
        .map(|(path, _)| path)
        .unwrap_or(value)
        .trim_matches('"');
    let path = PathBuf::from(without_index);
    if path.is_file() {
        path.parent().map(Path::to_path_buf)
    } else if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

pub fn bridge_is_bundled(bridge_dir: &Path) -> bool {
    bridge_dir.join("dist/src/cli.js").is_file()
        && bridge_dir
            .join("scripts/install-synthv-bridge.mjs")
            .is_file()
}

pub fn install_bridge(bridge_dir: &Path, scripts_path: &str) -> OperationResult {
    run_bridge_script(
        bridge_dir,
        "scripts/install-synthv-bridge.mjs",
        scripts_path,
    )
}

pub fn diagnose_bridge(bridge_dir: &Path, scripts_path: &str) -> OperationResult {
    run_bridge_script(bridge_dir, "scripts/doctor.mjs", scripts_path)
}

fn run_bridge_script(bridge_dir: &Path, script: &str, scripts_path: &str) -> OperationResult {
    if !bridge_is_bundled(bridge_dir) {
        return failed("应用构建未包含完整的 SynthV Bridge。", "");
    }
    if !Path::new(scripts_path).is_dir() {
        return failed("目标不是有效的 SynthV scripts 目录。", scripts_path);
    }
    let Some(node) = find_node() else {
        return failed(
            "未找到 Node.js 22.19 或更高版本。",
            "可设置 SYNTHV_TOOLBOX_NODE 指向 node 可执行文件。",
        );
    };
    let mut command = quiet_command(&node);
    command
        .arg(bridge_dir.join(script))
        .arg("--target")
        .arg(scripts_path)
        .current_dir(bridge_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match command.output() {
        Ok(output) => operation_from_output(output, "Bridge 操作已完成。", "Bridge 操作失败。"),
        Err(error) => failed("无法启动 Bridge 操作。", error.to_string()),
    }
}

pub fn find_node() -> Option<String> {
    let mut candidates = Vec::new();
    if let Ok(configured) = std::env::var("SYNTHV_TOOLBOX_NODE") {
        candidates.push(configured);
    }
    #[cfg(target_os = "macos")]
    candidates.extend([
        "/opt/homebrew/bin/node".to_string(),
        "/usr/local/bin/node".to_string(),
        "/usr/bin/node".to_string(),
    ]);
    candidates.push("node".to_string());
    candidates.into_iter().find(|candidate| {
        quiet_command(candidate)
            .arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .is_ok_and(|output| {
                output.status.success()
                    && node_version_supported(String::from_utf8_lossy(&output.stdout).trim())
            })
    })
}

fn node_version_supported(value: &str) -> bool {
    let mut parts = value.trim_start_matches('v').split('.');
    let major = parts.next().and_then(|part| part.parse::<u32>().ok());
    let minor = parts.next().and_then(|part| part.parse::<u32>().ok());
    matches!((major, minor), (Some(major), Some(minor)) if major > 22 || (major == 22 && minor >= 19))
}

fn operation_from_output(output: Output, success: &str, failure: &str) -> OperationResult {
    let detail = [output.stdout, output.stderr]
        .into_iter()
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    OperationResult {
        succeeded: output.status.success(),
        summary: if output.status.success() {
            success
        } else {
            failure
        }
        .to_string(),
        detail: truncate(&detail, 2400),
    }
}

pub fn succeeded(summary: impl Into<String>, detail: impl Into<String>) -> OperationResult {
    OperationResult {
        succeeded: true,
        summary: summary.into(),
        detail: detail.into(),
    }
}

pub fn failed(summary: impl Into<String>, detail: impl Into<String>) -> OperationResult {
    OperationResult {
        succeeded: false,
        summary: summary.into(),
        detail: detail.into(),
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect::<String>() + "…"
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

pub fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new(program);
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

#[cfg(test)]
mod tests {
    use super::node_version_supported;
    #[cfg(windows)]
    use super::normalized_path_string;
    #[cfg(windows)]
    use std::path::Path;

    #[test]
    fn node_version_floor_matches_the_bundled_bridge() {
        assert!(!node_version_supported("v20.10.0"));
        assert!(!node_version_supported("v22.18.9"));
        assert!(node_version_supported("v22.19.0"));
        assert!(node_version_supported("v24.0.0"));
    }

    #[cfg(windows)]
    #[test]
    fn displayed_windows_paths_use_one_separator_and_no_trailing_separator() {
        assert_eq!(
            normalized_path_string(Path::new(
                "C:/Users/User/Documents/Dreamtonics/Synthesizer V Studio/scripts/"
            )),
            r"C:\Users\User\Documents\Dreamtonics\Synthesizer V Studio\scripts"
        );
        assert_eq!(
            normalized_path_string(Path::new(r"D:\Synthesizer V Studio 2 Pro\")),
            r"D:\Synthesizer V Studio 2 Pro"
        );
    }
}
