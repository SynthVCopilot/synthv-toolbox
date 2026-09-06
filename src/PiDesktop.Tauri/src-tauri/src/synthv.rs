use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BridgeProfile {
    Sv2,
    Sv1,
    Flat,
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthVInstallation {
    pub display_name: String,
    pub install_path: Option<String>,
    pub executable_path: Option<String>,
    pub scripts_path: Option<String>,
    pub source: String,
    pub bridge_profile: BridgeProfile,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub succeeded: bool,
    pub summary: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTargetResult {
    pub scripts_path: String,
    pub bridge_profile: BridgeProfile,
    pub result: OperationResult,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTarget {
    pub scripts_path: String,
    pub bridge_profile: BridgeProfile,
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
        for scripts_path in windows_flat_script_candidates() {
            add_installation(
                &mut found,
                "Synthesizer V Studio Flat",
                None,
                Some(scripts_path),
                "Windows Flat 脚本目录",
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
    if install_exists && executable_path.is_none() {
        return;
    }
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
        bridge_profile: bridge_profile(name),
    });
}

fn bridge_profile(name: &str) -> BridgeProfile {
    let name = name.to_ascii_lowercase();
    if name.contains("flat") {
        BridgeProfile::Flat
    } else if name.contains("studio 2") {
        BridgeProfile::Sv2
    } else if name.contains("studio basic") {
        BridgeProfile::Unsupported
    } else if name.contains("studio pro") || name.contains("synthesizer v studio") {
        BridgeProfile::Sv1
    } else {
        BridgeProfile::Unsupported
    }
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
        install_path.join("Synthesizer V Flat.exe"),
        install_path.join("synthesizer-v-flat.exe"),
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
                if !is_synthv_host_display_name(&display_name) {
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
fn is_synthv_host_display_name(display_name: &str) -> bool {
    let name = display_name.to_ascii_lowercase();
    name.contains("synthesizer v flat")
        || name.contains("synthesizer v studio flat")
        || name.contains("synthesizer v studio 2")
        || name.contains("synthesizer v studio pro")
        || name.contains("synthesizer v studio basic")
}

#[cfg(windows)]
fn windows_flat_script_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(root) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        candidates.push(root.join("Documents/Dreamtonics/Synthesizer V Studio/scripts"));
        candidates.push(root.join("Documents/Anthronics/Synthesizer V Studio/scripts"));
    }
    for variable in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(variable).map(PathBuf::from) {
            candidates.push(root.join("Anthronics/Synthesizer V Studio/scripts"));
        }
    }
    candidates
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
        && bridge_dir
            .join("scripts/install-sv1-legacy-bridge.mjs")
            .is_file()
}

pub fn install_bridge(bridge_dir: &Path, scripts_path: &str) -> OperationResult {
    run_bridge_script(
        bridge_dir,
        "scripts/install-synthv-bridge.mjs",
        scripts_path,
    )
}

pub fn install_bridge_many(
    bridge_dir: &Path,
    targets: Vec<BridgeTarget>,
) -> Vec<BridgeTargetResult> {
    unique_bridge_targets(targets)
        .into_iter()
        .map(|target| {
            let result = match target.bridge_profile {
                BridgeProfile::Sv2 => install_bridge(bridge_dir, &target.scripts_path),
                BridgeProfile::Sv1 => run_bridge_script(
                    bridge_dir,
                    "scripts/install-sv1-legacy-bridge.mjs",
                    &target.scripts_path,
                ),
                BridgeProfile::Flat => install_bridge(bridge_dir, &target.scripts_path),
                BridgeProfile::Unsupported => failed(
                    "此 SynthV 版本不支持安装 Bridge 脚本。",
                    "请使用已支持的 SV1 或 SV2 scripts 目录。",
                ),
            };
            BridgeTargetResult {
                scripts_path: target.scripts_path,
                bridge_profile: target.bridge_profile,
                result,
            }
        })
        .collect()
}

pub fn diagnose_bridge_many(targets: Vec<BridgeTarget>) -> Vec<BridgeTargetResult> {
    unique_bridge_targets(targets)
        .into_iter()
        .map(|target| {
            let expected_bundle = match target.bridge_profile {
                BridgeProfile::Sv2 | BridgeProfile::Flat => Some("SynthV Agent Bridge"),
                BridgeProfile::Sv1 => Some("SynthV Agent Bridge SV1 Legacy"),
                BridgeProfile::Unsupported => None,
            };
            let result = match expected_bundle {
                Some(_)
                    if bridge_script_bundle_is_valid(
                        Path::new(&target.scripts_path),
                        target.bridge_profile,
                    ) =>
                {
                    let detail = if target.bridge_profile == BridgeProfile::Sv1 {
                        "已验证 SV1 兼容脚本与协议版本。"
                    } else {
                        "已验证 Bridge、停止和侧栏脚本版本。"
                    };
                    succeeded("Bridge 脚本已安装。", detail)
                }
                Some(bundle) => failed(
                    "Bridge 脚本尚未安装或版本不匹配。",
                    format!("缺少或未匹配 {bundle}"),
                ),
                None => failed(
                    "此 SynthV 版本不支持 Bridge 脚本。",
                    "请选择 SV1 或 SV2 scripts 目录。",
                ),
            };
            BridgeTargetResult {
                scripts_path: target.scripts_path,
                bridge_profile: target.bridge_profile,
                result,
            }
        })
        .collect()
}

fn bridge_script_bundle_is_valid(directory: &Path, profile: BridgeProfile) -> bool {
    const COMPONENT_VERSION: &str = "0.3.1";
    match profile {
        BridgeProfile::Sv1 => std::fs::read_to_string(
            directory.join("SynthV Agent Bridge SV1 Legacy/SynthVAgentBridgeSV1Legacy.lua"),
        )
        .is_ok_and(|content| {
            content.contains("SCRIPT_NAME = \"SynthV Agent Bridge SV1 Legacy\"")
                && content.contains("PROTOCOL_VERSION = 1")
        }),
        BridgeProfile::Sv2 | BridgeProfile::Flat => {
            let directory = directory.join("SynthV Agent Bridge");
            let bridge = std::fs::read_to_string(directory.join("SynthVAgentBridge.lua"));
            let stop = std::fs::read_to_string(directory.join("StopSynthVAgentBridge.lua"));
            let sidebar = std::fs::read_to_string(directory.join("SynthVAgentSidebar.lua"));
            matches!(bridge, Ok(ref content) if content.contains(&format!("BRIDGE_VERSION = \"{COMPONENT_VERSION}\"")) && content.contains("PROTOCOL_VERSION = 3"))
                && matches!(stop, Ok(ref content) if content.contains("BRIDGE_NAME = \"SynthV Agent Bridge\""))
                && matches!(sidebar, Ok(ref content) if content.contains(&format!("SIDEBAR_VERSION = \"{COMPONENT_VERSION}\"")) && content.contains("SIDEBAR_BUILD_ID"))
        }
        BridgeProfile::Unsupported => false,
    }
}

pub fn unique_bridge_targets(targets: Vec<BridgeTarget>) -> Vec<BridgeTarget> {
    let mut unique = std::collections::HashSet::new();
    targets
        .into_iter()
        .filter_map(|target| {
            let scripts_path = target.scripts_path.trim();
            (!scripts_path.is_empty()).then(|| BridgeTarget {
                scripts_path: normalized_path_string(Path::new(scripts_path)),
                bridge_profile: target.bridge_profile,
            })
        })
        .filter(|target| unique.insert(target_key(&target.scripts_path)))
        .collect()
}

fn target_key(path: &str) -> String {
    #[cfg(windows)]
    {
        path.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        path.to_string()
    }
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
