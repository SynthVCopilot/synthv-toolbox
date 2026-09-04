use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostKind {
    OfficialSv1,
    Flat,
    OfficialSv2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionKind {
    Bridge,
    LoopbackHttp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityAccess {
    pub read: bool,
    pub write: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCapabilities {
    pub project: bool,
    pub sequence: bool,
    pub transport: bool,
    pub tracks: bool,
    pub parts: bool,
    pub notes: bool,
    pub voice_parameters: CapabilityAccess,
    pub singer_list: bool,
    pub singer_assignment: bool,
    pub retakes: bool,
    pub computed_pitch: bool,
    pub export_snapshot: bool,
    pub audio_capture: bool,
    pub read_operations: Vec<&'static str>,
    pub write_operations: Vec<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandardSynthVHost {
    pub id: String,
    pub kind: HostKind,
    pub display_name: String,
    pub bundle_id: Option<String>,
    pub version: Option<String>,
    pub executable_name: String,
    pub application_path: Option<String>,
    pub script_directories: Vec<String>,
    pub process_id: Option<u32>,
    pub connection: ConnectionKind,
    pub endpoint: Option<String>,
    pub installed: bool,
    pub running: bool,
    pub connected: bool,
    pub capabilities: HostCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessRecord {
    pid: u32,
    args: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ApplicationRecord {
    kind: HostKind,
    path: PathBuf,
    bundle_id: Option<String>,
    version: Option<String>,
}

#[cfg(any(target_os = "macos", test))]
const SV1_APP: &str = "/Applications/Synthesizer V Studio Pro.app";
#[cfg(any(target_os = "macos", test))]
const SV2_APP: &str = "/Applications/Synthesizer V Studio 2 Pro.app";
#[cfg(target_os = "macos")]
const FLAT_APP: &str = "/Applications/Synthesizer V Flat.app";
const SYNTHV_EXECUTABLE: &str = "synthv-studio";
#[cfg(not(windows))]
const FLAT_EXECUTABLE_PATH: &str = "/Applications/Synthesizer V Flat.app/Contents/Resources/Synthesizer V Studio Pro/Contents/MacOS/Synthesizer V Flat";
#[cfg(target_os = "macos")]
const FLAT_MAC_SCRIPTS: &str =
    "/Library/Application Support/Anthronics/Synthesizer V Studio/scripts";

pub fn capabilities(kind: HostKind) -> HostCapabilities {
    let common_reads = vec![
        "status",
        "project",
        "sequence",
        "transport",
        "tracks",
        "track",
        "parts",
        "part",
        "notes",
    ];
    let common_edits = vec![
        "transport.play",
        "transport.pause",
        "transport.stop",
        "track.create",
        "track.update",
        "track.delete",
        "part.create",
        "part.update",
        "part.delete",
        "note.create",
        "note.update",
        "note.delete",
    ];
    let (read_operations, write_operations) = match kind {
        HostKind::OfficialSv1 => {
            let mut writes = common_edits.clone();
            writes.insert(3, "transport.seek");
            (common_reads, writes)
        }
        HostKind::Flat => {
            let mut reads = common_reads;
            reads.extend(["singers", "voice"]);
            let mut writes = vec![
                "project.open",
                "sequence.set_tempo",
                "sequence.remove_tempo",
                "sequence.set_time_signature",
                "sequence.remove_time_signature",
            ];
            writes.extend(common_edits);
            writes.push("voice.assign");
            (reads, writes)
        }
        HostKind::OfficialSv2 => {
            let mut reads = common_reads;
            reads.push("voice");
            let writes = vec![
                "sequence.set_tempo",
                "sequence.remove_tempo",
                "sequence.set_time_signature",
                "sequence.remove_time_signature",
                "transport.play",
                "transport.pause",
                "transport.stop",
                "transport.seek",
                "track.create",
                "track.update",
                "track.delete",
                "part.update",
                "part.delete",
                "voice.parameters.update",
                "note.create",
                "note.update",
                "note.delete",
            ];
            (reads, writes)
        }
    };
    HostCapabilities {
        project: true,
        sequence: true,
        transport: true,
        tracks: true,
        parts: true,
        notes: true,
        voice_parameters: CapabilityAccess {
            read: true,
            write: !matches!(kind, HostKind::Flat),
        },
        singer_list: matches!(kind, HostKind::Flat),
        singer_assignment: matches!(kind, HostKind::Flat),
        retakes: matches!(kind, HostKind::OfficialSv2),
        computed_pitch: matches!(kind, HostKind::OfficialSv2),
        export_snapshot: true,
        audio_capture: !matches!(kind, HostKind::Flat),
        read_operations,
        write_operations,
    }
}

pub fn discover() -> Result<Vec<StandardSynthVHost>, String> {
    #[cfg(target_os = "macos")]
    {
        let processes = read_processes()?;
        let applications = discover_applications(&processes);
        let flat_status = std::fs::read_to_string(flat_status_path()).ok();
        Ok(build_hosts(
            &processes,
            &applications,
            flat_status.as_deref(),
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        discover_windows()
    }
}

pub fn flat_process_ids() -> Result<Vec<u32>, String> {
    Ok(discover()?
        .into_iter()
        .filter(|host| host.kind == HostKind::Flat && host.running)
        .filter_map(|host| host.process_id)
        .collect())
}

pub fn launch_flat(
    host: &StandardSynthVHost,
    project_path: Option<&std::path::Path>,
) -> Result<(), String> {
    if host.kind != HostKind::Flat || !host.installed {
        return Err("Synthesizer V Flat 未安装，无法启动。".to_string());
    }
    let executable = flat_launch_executable(host)?;
    let mut command = std::process::Command::new(executable);
    if let Some(project_path) = project_path {
        command.arg(project_path);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法启动 Synthesizer V Flat：{error}"))
}

#[cfg(target_os = "macos")]
fn flat_launch_executable(host: &StandardSynthVHost) -> Result<PathBuf, String> {
    let application = host
        .application_path
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| "Synthesizer V Flat 安装路径不可用。".to_string())?;
    let executable = application
        .join("Contents/Resources/Synthesizer V Studio Pro/Contents/MacOS/Synthesizer V Flat");
    safe_regular_file(&executable)
        .then_some(executable)
        .ok_or_else(|| "Synthesizer V Flat 可执行文件不可用。".to_string())
}

#[cfg(windows)]
fn flat_launch_executable(host: &StandardSynthVHost) -> Result<PathBuf, String> {
    let directory = host
        .application_path
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| "Synthesizer V Flat 安装路径不可用。".to_string())?;
    ["Synthesizer V Flat.exe", "synthesizer-v-flat.exe"]
        .into_iter()
        .map(|name| directory.join(name))
        .find(|path| safe_regular_file(path))
        .ok_or_else(|| "Synthesizer V Flat 可执行文件不可用。".to_string())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn flat_launch_executable(_host: &StandardSynthVHost) -> Result<PathBuf, String> {
    Err("当前平台不支持启动 Synthesizer V Flat。".to_string())
}

#[cfg(windows)]
fn discover_windows() -> Result<Vec<StandardSynthVHost>, String> {
    let processes = crate::synthv_control::list_processes()?
        .into_iter()
        .map(|process| ProcessRecord {
            pid: process.process_id,
            args: process.command,
        })
        .collect::<Vec<_>>();
    let flat_process_ids = processes
        .iter()
        .filter(|process| is_windows_flat_process(&process.args))
        .map(|process| process.pid)
        .collect::<Vec<_>>();
    let flat_status = first_valid_flat_status(
        windows_flat_status_candidates()
            .into_iter()
            .filter(|path| safe_regular_file(path))
            .filter_map(|path| std::fs::read_to_string(path).ok()),
        &flat_process_ids,
    );
    Ok(build_hosts(
        &processes,
        &discover_windows_applications(),
        flat_status.as_deref(),
    ))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn discover_windows() -> Result<Vec<StandardSynthVHost>, String> {
    Ok(Vec::new())
}

#[cfg(target_os = "macos")]
fn flat_status_path() -> PathBuf {
    PathBuf::from(
        "/Library/Application Support/Anthronics/Synthesizer V Studio/settings/mcp-status.json",
    )
}

#[cfg(target_os = "macos")]
fn read_processes() -> Result<Vec<ProcessRecord>, String> {
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid=,args="])
        .output()
        .map_err(|error| format!("无法枚举 SynthV 宿主进程：{error}"))?;
    if !output.status.success() {
        return Err("macOS 进程枚举失败。".to_string());
    }
    Ok(parse_processes(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(any(target_os = "macos", test))]
fn parse_processes(text: &str) -> Vec<ProcessRecord> {
    text.lines()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            let split = trimmed.find(char::is_whitespace)?;
            let pid = trimmed[..split].parse().ok()?;
            let args = trimmed[split..].trim().to_string();
            (!args.is_empty()).then_some(ProcessRecord { pid, args })
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn discover_applications(processes: &[ProcessRecord]) -> Vec<ApplicationRecord> {
    let mut applications = [
        (HostKind::OfficialSv1, SV1_APP),
        (HostKind::Flat, FLAT_APP),
        (HostKind::OfficialSv2, SV2_APP),
    ]
    .into_iter()
    .map(|(kind, path)| (kind, PathBuf::from(path)))
    .filter(|(_, path)| path.is_dir())
    .filter_map(|(kind, path)| read_application(kind, path))
    .collect::<Vec<_>>();
    for process in processes {
        if let Some((kind, path)) = app_from_args(&process.args) {
            if !applications.iter().any(|app| app.path == path) {
                if let Some(app) = read_application(kind, path) {
                    applications.push(app);
                }
            }
        }
    }
    applications
}

#[cfg(target_os = "macos")]
fn read_application(kind: HostKind, path: PathBuf) -> Option<ApplicationRecord> {
    let plist = path.join("Contents/Info.plist");
    let output = std::process::Command::new("plutil")
        .args(["-convert", "json", "-o", "-", plist.to_str()?])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let expected_executable = match kind {
        HostKind::Flat => "Synthesizer V Flat",
        HostKind::OfficialSv1 | HostKind::OfficialSv2 => SYNTHV_EXECUTABLE,
    };
    if value.get("CFBundleExecutable")?.as_str()? != expected_executable {
        return None;
    }
    Some(ApplicationRecord {
        kind,
        path,
        bundle_id: value
            .get("CFBundleIdentifier")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        version: value
            .get("CFBundleShortVersionString")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

#[cfg(target_os = "macos")]
fn app_from_args(args: &str) -> Option<(HostKind, PathBuf)> {
    if args.contains(SV1_APP) {
        Some((HostKind::OfficialSv1, PathBuf::from(SV1_APP)))
    } else if args.contains(SV2_APP) {
        Some((HostKind::OfficialSv2, PathBuf::from(SV2_APP)))
    } else if args.contains(FLAT_APP) {
        Some((HostKind::Flat, PathBuf::from(FLAT_APP)))
    } else {
        None
    }
}

fn matches_process(
    kind: HostKind,
    process: &ProcessRecord,
    application: Option<&ApplicationRecord>,
) -> bool {
    match kind {
        HostKind::Flat => {
            #[cfg(windows)]
            {
                is_windows_flat_process(&process.args)
            }
            #[cfg(not(windows))]
            {
                command_has_exact_executable(process.args.as_str(), FLAT_EXECUTABLE_PATH)
            }
        }
        HostKind::OfficialSv1 | HostKind::OfficialSv2 => application.is_some_and(|app| {
            command_has_exact_executable(
                process.args.as_str(),
                &format!("{}/Contents/MacOS/{SYNTHV_EXECUTABLE}", app.path.display()),
            )
        }),
    }
}

#[cfg(windows)]
fn discover_windows_applications() -> Vec<ApplicationRecord> {
    windows_flat_application_candidates()
        .into_iter()
        .find_map(|directory| {
            ["Synthesizer V Flat.exe", "synthesizer-v-flat.exe"]
                .into_iter()
                .map(|name| directory.join(name))
                .find(|path| safe_regular_file(path))
                .map(|_| ApplicationRecord {
                    kind: HostKind::Flat,
                    path: directory,
                    bundle_id: None,
                    version: None,
                })
        })
        .into_iter()
        .collect()
}

#[cfg(windows)]
fn windows_flat_application_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for root in [
        std::env::var_os("LOCALAPPDATA"),
        std::env::var_os("PROGRAMFILES"),
        std::env::var_os("PROGRAMFILES(X86)"),
        std::env::var_os("USERPROFILE"),
    ]
    .into_iter()
    .flatten()
    {
        let root = PathBuf::from(root);
        candidates.extend([
            root.join("Programs/Anthronics/Synthesizer V Studio"),
            root.join("Programs/Synthesizer V Flat"),
            root.join("Anthronics/Synthesizer V Studio"),
            root.join("Synthesizer V Flat"),
        ]);
    }
    candidates
}

#[cfg(windows)]
fn windows_flat_status_candidates() -> Vec<PathBuf> {
    let program_data = std::env::var_os("PROGRAMDATA").map(PathBuf::from);
    let app_data = std::env::var_os("APPDATA").map(PathBuf::from);
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    windows_flat_status_candidates_from_roots(
        program_data.as_deref(),
        app_data.as_deref(),
        local_app_data.as_deref(),
    )
}

#[cfg(any(windows, test))]
fn windows_flat_status_candidates_from_roots(
    program_data: Option<&std::path::Path>,
    app_data: Option<&std::path::Path>,
    local_app_data: Option<&std::path::Path>,
) -> Vec<PathBuf> {
    [program_data, app_data, local_app_data]
        .into_iter()
        .flatten()
        .map(|root| root.join("Anthronics/Synthesizer V Studio/settings/mcp-status.json"))
        .collect()
}

#[cfg(windows)]
fn is_windows_flat_process(command: &str) -> bool {
    let executable = PathBuf::from(command.trim_matches('"'));
    let Some(name) = executable.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    matches!(
        name.to_ascii_lowercase().as_str(),
        "synthesizer v flat.exe" | "synthesizer-v-flat.exe"
    )
}

#[cfg(windows)]
fn safe_regular_file(path: &std::path::Path) -> bool {
    std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.file_type().is_file() && !is_reparse_point(&metadata))
}

#[cfg(not(windows))]
fn safe_regular_file(path: &std::path::Path) -> bool {
    std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.file_type().is_file() && !metadata.file_type().is_symlink())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn command_has_exact_executable(args: &str, full_path: &str) -> bool {
    args == full_path
        || args
            .strip_prefix(full_path)
            .is_some_and(|rest| rest.chars().next().is_some_and(char::is_whitespace))
}

fn build_hosts(
    processes: &[ProcessRecord],
    applications: &[ApplicationRecord],
    flat_status: Option<&str>,
) -> Vec<StandardSynthVHost> {
    let candidates = [
        (HostKind::OfficialSv1, "Synthesizer V Studio Pro"),
        (HostKind::Flat, "Synthesizer V Flat"),
        (HostKind::OfficialSv2, "Synthesizer V Studio 2 Pro"),
    ];
    let mut hosts = Vec::new();
    for (kind, display_name) in candidates {
        let application = applications.iter().find(|app| app.kind == kind);
        let mut matching_processes = processes
            .iter()
            .filter(|process| matches_process(kind, process, application))
            .map(Some)
            .collect::<Vec<_>>();
        if matching_processes.is_empty() {
            if application.is_none() {
                continue;
            }
            matching_processes.push(None);
        }
        for process in matching_processes {
            let process_id = process.map(|process| process.pid);
            let running = process_id.is_some();
            let endpoint = (kind == HostKind::Flat)
                .then(|| valid_flat_status(flat_status.unwrap_or(""), process_id))
                .flatten();
            let connected = kind == HostKind::Flat && endpoint.is_some();
            let script_directories = script_directories(kind);
            let kind_id = match kind {
                HostKind::OfficialSv1 => "official-sv1",
                HostKind::Flat => "flat",
                HostKind::OfficialSv2 => "official-sv2",
            };
            hosts.push(StandardSynthVHost {
                id: process_id
                    .map_or_else(|| kind_id.to_string(), |pid| format!("{kind_id}:{pid}")),
                kind,
                display_name: display_name.to_string(),
                bundle_id: application.and_then(|a| a.bundle_id.clone()),
                version: application.and_then(|a| a.version.clone()),
                executable_name: if kind == HostKind::Flat {
                    "Synthesizer V Flat".to_string()
                } else {
                    SYNTHV_EXECUTABLE.to_string()
                },
                application_path: application.map(|a| a.path.to_string_lossy().into_owned()),
                script_directories,
                process_id,
                connection: if kind == HostKind::Flat {
                    ConnectionKind::LoopbackHttp
                } else {
                    ConnectionKind::Bridge
                },
                endpoint,
                installed: application.is_some() || (kind == HostKind::Flat && running),
                running,
                connected,
                capabilities: capabilities(kind),
            });
        }
    }
    hosts
}

fn script_directories(kind: HostKind) -> Vec<String> {
    match kind {
        HostKind::OfficialSv1 => {
            #[cfg(target_os = "macos")]
            {
                vec![
                    "/Library/Application Support/Dreamtonics/Synthesizer V Studio/scripts"
                        .to_string(),
                ]
            }
            #[cfg(windows)]
            {
                windows_sv1_scripts_directory()
                    .into_iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect()
            }
            #[cfg(not(any(target_os = "macos", windows)))]
            {
                Vec::new()
            }
        }
        HostKind::Flat => {
            #[cfg(target_os = "macos")]
            {
                vec![FLAT_MAC_SCRIPTS.to_string()]
            }
            #[cfg(windows)]
            {
                windows_flat_scripts_directory()
                    .into_iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect()
            }
            #[cfg(not(any(target_os = "macos", windows)))]
            {
                Vec::new()
            }
        }
        HostKind::OfficialSv2 => {
            #[cfg(target_os = "macos")]
            {
                vec![
                    "~/Library/Application Support/Dreamtonics/Synthesizer V Studio 2/scripts"
                        .to_string(),
                ]
            }
            #[cfg(not(target_os = "macos"))]
            {
                Vec::new()
            }
        }
    }
}

pub fn flat_fallback_scripts_directory(host: &StandardSynthVHost) -> Result<PathBuf, String> {
    if host.kind != HostKind::Flat {
        return Err("所选 SynthV 宿主不支持此连接方式。".to_string());
    }
    let directory = host
        .script_directories
        .first()
        .map(PathBuf::from)
        .ok_or_else(|| "所选 SynthV 宿主没有可验证的扩展目录。".to_string())?;
    if safe_directory(&directory) {
        Ok(directory)
    } else {
        Err("所选 SynthV 宿主没有可验证的扩展目录。".to_string())
    }
}

fn safe_directory(path: &std::path::Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| {
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
            return false;
        }
        #[cfg(windows)]
        if is_reparse_point(&metadata) {
            return false;
        }
        true
    })
}

#[cfg(windows)]
fn windows_sv1_scripts_directory() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|root| root.join("Documents/Dreamtonics/Synthesizer V Studio/scripts"))
        .filter(|path| safe_directory(path))
}

#[cfg(windows)]
fn windows_flat_scripts_directory() -> Option<PathBuf> {
    windows_flat_script_candidates()
        .into_iter()
        .find(|path| safe_directory(path))
}

#[cfg(windows)]
fn windows_flat_script_candidates() -> Vec<PathBuf> {
    let user_profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let app_data = std::env::var_os("APPDATA").map(PathBuf::from);
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    windows_flat_script_candidates_from_roots(
        user_profile.as_deref(),
        app_data.as_deref(),
        local_app_data.as_deref(),
    )
}

#[cfg(any(windows, test))]
fn windows_flat_script_candidates_from_roots(
    user_profile: Option<&std::path::Path>,
    app_data: Option<&std::path::Path>,
    local_app_data: Option<&std::path::Path>,
) -> Vec<PathBuf> {
    let mut candidates = user_profile
        .into_iter()
        .map(|root| root.join("Documents/Anthronics/Synthesizer V Studio/scripts"))
        .collect::<Vec<_>>();
    candidates.extend(
        [app_data, local_app_data]
            .into_iter()
            .flatten()
            .map(|root| root.join("Anthronics/Synthesizer V Studio/scripts")),
    );
    candidates
}

fn valid_flat_status(status: &str, expected_pid: Option<u32>) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(status).ok()?;
    if value.get("pid")?.as_u64()? as u32 != expected_pid? {
        return None;
    }
    for key in ["running", "nativeHostReady", "bridgeReady", "runtimeReady"] {
        if !value.get(key)?.as_bool()? {
            return None;
        }
    }
    let endpoint = value.get("endpoint")?.as_str()?;
    let parsed = url::Url::parse(endpoint).ok()?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port().is_none()
        || parsed.path() != "/mcp"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(endpoint.to_string())
}

#[cfg(any(windows, test))]
fn first_valid_flat_status(
    statuses: impl IntoIterator<Item = String>,
    flat_process_ids: &[u32],
) -> Option<String> {
    statuses.into_iter().find(|status| {
        flat_process_ids
            .iter()
            .any(|process_id| valid_flat_status(status, Some(*process_id)).is_some())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn app(
        kind: HostKind,
        path: &str,
        bundle_id: Option<&str>,
        version: &str,
    ) -> ApplicationRecord {
        ApplicationRecord {
            kind,
            path: PathBuf::from(path),
            bundle_id: bundle_id.map(str::to_string),
            version: Some(version.to_string()),
        }
    }
    fn process(pid: u32, args: &str) -> ProcessRecord {
        ProcessRecord {
            pid,
            args: args.to_string(),
        }
    }

    #[test]
    fn ps_parser_preserves_spaces_in_full_args() {
        let processes = parse_processes("12 /Applications/Synthesizer V Studio Pro.app/Contents/MacOS/synthv-studio --project x\n");
        assert_eq!(processes[0].pid, 12);
        assert!(processes[0].args.contains("Synthesizer V Studio Pro.app"));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn sv1_uses_plist_identity_and_exact_app_path() {
        let apps = vec![app(HostKind::OfficialSv1, SV1_APP, None, "1.11.2")];
        let hosts = build_hosts(
            &[process(
                12,
                &format!("{SV1_APP}/Contents/MacOS/{SYNTHV_EXECUTABLE}"),
            )],
            &apps,
            None,
        );
        assert_eq!(hosts[0].bundle_id, None);
        assert_eq!(hosts[0].version.as_deref(), Some("1.11.2"));
        assert!(hosts[0].installed && hosts[0].running && !hosts[0].connected);
        assert_eq!(
            hosts[0].script_directories[0],
            "/Library/Application Support/Dreamtonics/Synthesizer V Studio/scripts"
        );
        assert!(!hosts[0].capabilities.singer_assignment);
    }
    #[test]
    fn same_executable_is_disambiguated_by_app_bundle_path() {
        let apps = vec![
            app(HostKind::OfficialSv1, SV1_APP, None, "1.11.2"),
            app(
                HostKind::OfficialSv2,
                SV2_APP,
                Some("com.dreamtonics.svstudio2.pro"),
                "2.2.1",
            ),
        ];
        let processes = vec![
            process(12, &format!("{SV1_APP}/Contents/MacOS/{SYNTHV_EXECUTABLE}")),
            process(13, &format!("{SV2_APP}/Contents/MacOS/{SYNTHV_EXECUTABLE}")),
        ];
        let hosts = build_hosts(&processes, &apps, None);
        assert_eq!(hosts[0].process_id, Some(12));
        assert_eq!(hosts[1].process_id, Some(13));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn flat_uses_anthronics_scripts_and_requires_complete_ready_status() {
        let apps = vec![app(
            HostKind::Flat,
            FLAT_APP,
            Some("org.anthronics.svflat.macos"),
            "1.4.3",
        )];
        let processes = vec![process(20, FLAT_EXECUTABLE_PATH)];
        let good = r#"{"pid":20,"running":true,"nativeHostReady":true,"bridgeReady":true,"runtimeReady":true,"endpoint":"http://127.0.0.1:17580/mcp"}"#.to_string();
        let hosts = build_hosts(&processes, &apps, Some(&good));
        assert!(
            hosts[0].connected
                && hosts[0].script_directories == vec![FLAT_MAC_SCRIPTS.to_string()]
                && hosts[0].capabilities.singer_assignment
                && !hosts[0].capabilities.retakes
                && !hosts[0].capabilities.computed_pitch
                && !hosts[0].capabilities.voice_parameters.write
                && hosts[0].capabilities.export_snapshot
        );
        let bad = good.replace("\"runtimeReady\":true", "\"runtimeReady\":false");
        assert!(!build_hosts(&processes, &apps, Some(&bad))[0].connected);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn flat_process_path_with_spaces_is_detected() {
        let apps = vec![app(HostKind::Flat, FLAT_APP, None, "1.4.3")];
        let args = format!("{FLAT_EXECUTABLE_PATH} --open song.svp");
        let hosts = build_hosts(&[process(21, &args)], &apps, None);
        assert_eq!(hosts[0].id, "flat:21");
        assert_eq!(hosts[0].process_id, Some(21));
        assert!(hosts[0].running && !hosts[0].connected);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn emits_every_matching_process_and_connects_only_status_pid() {
        let apps = vec![app(HostKind::Flat, FLAT_APP, None, "1.4.3")];
        let processes = vec![
            process(21, FLAT_EXECUTABLE_PATH),
            process(22, FLAT_EXECUTABLE_PATH),
        ];
        let status = r#"{"pid":22,"running":true,"nativeHostReady":true,"bridgeReady":true,"runtimeReady":true,"endpoint":"http://127.0.0.1:17580/mcp"}"#.to_string();
        let hosts = build_hosts(&processes, &apps, Some(&status));
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].id, "flat:21");
        assert_eq!(hosts[1].id, "flat:22");
        assert!(!hosts[0].connected);
        assert!(hosts[1].connected);
    }

    #[test]
    fn capabilities_do_not_depend_on_running_state() {
        let hosts = build_hosts(
            &[],
            &[app(HostKind::OfficialSv2, SV2_APP, Some("id"), "2.2.1")],
            None,
        );
        assert!(!hosts[0].running && !hosts[0].connected && hosts[0].capabilities.notes);
        assert!(hosts[0].capabilities.computed_pitch);
        assert!(hosts[0].capabilities.export_snapshot);
        assert!(serde_json::to_value(&hosts[0]).unwrap()["installed"]
            .as_bool()
            .unwrap());
    }

    #[test]
    fn operation_capabilities_expose_only_real_host_differences() {
        let sv1 = capabilities(HostKind::OfficialSv1);
        assert!(sv1.write_operations.contains(&"transport.seek"));
        assert!(!sv1.read_operations.contains(&"singers"));

        let flat = capabilities(HostKind::Flat);
        assert!(flat.write_operations.contains(&"voice.assign"));
        assert!(!flat.write_operations.contains(&"transport.seek"));
        assert!(!flat.audio_capture);

        let sv2 = capabilities(HostKind::OfficialSv2);
        assert!(sv2.write_operations.contains(&"voice.parameters.update"));
        assert!(!sv2.write_operations.contains(&"voice.assign"));
        assert!(sv2.audio_capture);
    }

    #[test]
    fn windows_flat_status_candidates_are_anthronics_only() {
        let candidates = windows_flat_status_candidates_from_roots(
            Some(std::path::Path::new("C:/ProgramData")),
            Some(std::path::Path::new("C:/Users/R/AppData/Roaming")),
            Some(std::path::Path::new("C:/Users/R/AppData/Local")),
        );
        assert_eq!(candidates.len(), 3);
        assert!(candidates.iter().all(|path| path
            .to_string_lossy()
            .contains("Anthronics/Synthesizer V Studio/settings/mcp-status.json")));
        assert!(!candidates
            .iter()
            .any(|path| path.to_string_lossy().contains("Dreamtonics")));
    }

    #[test]
    fn windows_flat_scripts_prioritize_documents_and_exclude_dreamtonics() {
        let candidates = windows_flat_script_candidates_from_roots(
            Some(std::path::Path::new("C:/Users/R")),
            Some(std::path::Path::new("C:/Users/R/AppData/Roaming")),
            Some(std::path::Path::new("C:/Users/R/AppData/Local")),
        );
        assert_eq!(
            candidates[0],
            PathBuf::from("C:/Users/R/Documents/Anthronics/Synthesizer V Studio/scripts")
        );
        assert!(candidates
            .iter()
            .all(|path| !path.to_string_lossy().contains("Dreamtonics")));
    }

    #[test]
    fn windows_flat_status_skips_stale_candidate_for_later_valid_candidate() {
        let stale = r#"{"pid":71,"running":true,"nativeHostReady":true,"bridgeReady":true,"runtimeReady":true,"endpoint":"http://127.0.0.1:17580/mcp"}"#.to_string();
        let valid = r#"{"pid":72,"running":true,"nativeHostReady":true,"bridgeReady":true,"runtimeReady":true,"endpoint":"http://127.0.0.1:17581/mcp"}"#.to_string();
        assert_eq!(
            first_valid_flat_status(vec![stale, valid.clone()], &[72]),
            Some(valid)
        );
    }
}
