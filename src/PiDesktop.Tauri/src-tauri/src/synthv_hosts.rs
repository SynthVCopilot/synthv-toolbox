use serde::Serialize;
use std::path::{Path, PathBuf};

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

const SV1_APP: &str = "/Applications/Synthesizer V Studio Pro.app";
const SV2_APP: &str = "/Applications/Synthesizer V Studio 2 Pro.app";
const FLAT_APP: &str = "/Applications/Synthesizer V Flat.app";
const SYNTHV_EXECUTABLE: &str = "synthv-studio";
const FLAT_EXECUTABLE_PATH: &str = "/Applications/Synthesizer V Flat.app/Contents/Resources/Synthesizer V Studio/Contents/MacOS/Synthesizer V Flat";

fn capabilities(kind: HostKind) -> HostCapabilities {
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
        retakes: matches!(kind, HostKind::OfficialSv2 | HostKind::Flat),
        computed_pitch: matches!(kind, HostKind::OfficialSv2),
        export_snapshot: true,
        audio_capture: true,
    }
}

pub fn discover() -> Result<Vec<StandardSynthVHost>, String> {
    #[cfg(target_os = "macos")]
    {
        let processes = read_processes()?;
        let applications = discover_applications(&processes);
        let flat_status = std::fs::read_to_string(flat_status_path()).ok();
        return Ok(build_hosts(
            &processes,
            &applications,
            flat_status.as_deref(),
        ));
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(Vec::new())
    }
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
            process.args.starts_with(FLAT_EXECUTABLE_PATH)
                && command_has_exact_executable(process.args.as_str(), "Synthesizer V Flat")
        }
        HostKind::OfficialSv1 | HostKind::OfficialSv2 => application.is_some_and(|app| {
            process
                .args
                .starts_with(app.path.to_string_lossy().as_ref())
                && command_has_exact_executable(process.args.as_str(), SYNTHV_EXECUTABLE)
        }),
    }
}

fn command_has_exact_executable(args: &str, executable: &str) -> bool {
    args.split_whitespace().any(|value| {
        Path::new(value)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == executable)
    }) || args.ends_with(executable)
}

fn build_hosts(
    processes: &[ProcessRecord],
    applications: &[ApplicationRecord],
    flat_status: Option<&str>,
) -> Vec<StandardSynthVHost> {
    [
        (HostKind::OfficialSv1, "Synthesizer V Studio Pro"),
        (HostKind::Flat, "Synthesizer V Flat"),
        (HostKind::OfficialSv2, "Synthesizer V Studio 2 Pro"),
    ]
    .into_iter()
    .filter_map(|(kind, display_name)| {
        let application = applications.iter().find(|app| app.kind == kind);
        let process = processes
            .iter()
            .find(|process| matches_process(kind, process, application));
        if application.is_none() && process.is_none() {
            return None;
        }
        let running = process.is_some();
        let process_id = process.map(|process| process.pid);
        let endpoint = (kind == HostKind::Flat)
            .then(|| valid_flat_status(flat_status.unwrap_or(""), process_id))
            .flatten();
        let connected = kind == HostKind::Flat && endpoint.is_some();
        let script_directories = match kind {
            HostKind::OfficialSv1 => vec![
                "/Library/Application Support/Dreamtonics/Synthesizer V Studio/scripts".to_string(),
            ],
            HostKind::OfficialSv2 => vec![
                "~/Library/Application Support/Dreamtonics/Synthesizer V Studio 2/scripts"
                    .to_string(),
            ],
            HostKind::Flat => Vec::new(),
        };
        Some(StandardSynthVHost {
            id: match kind {
                HostKind::OfficialSv1 => "official-sv1",
                HostKind::Flat => "flat",
                HostKind::OfficialSv2 => "official-sv2",
            }
            .to_string(),
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
            installed: application.is_some(),
            running,
            connected,
            capabilities: capabilities(kind),
        })
    })
    .collect()
}

fn valid_flat_status(status: &str, expected_pid: Option<u32>) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(status).ok()?;
    if value.get("pid")?.as_u64()? as u32 != expected_pid? {
        return None;
    }
    for key in ["running", "nativeHostReady", "bridgeReady", "runtimeReady"] {
        if value.get(key)?.as_bool()? != true {
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
        assert_eq!(hosts[2].process_id, Some(13));
    }
    #[test]
    fn flat_has_no_scripts_and_requires_complete_ready_status() {
        let apps = vec![app(
            HostKind::Flat,
            FLAT_APP,
            Some("org.anthronics.svflat.macos"),
            "1.4.3",
        )];
        let processes = vec![process(20, FLAT_EXECUTABLE_PATH)];
        let good = format!(
            r#"{{"pid":20,"running":true,"nativeHostReady":true,"bridgeReady":true,"runtimeReady":true,"endpoint":"http://127.0.0.1:17580/mcp"}}"#
        );
        let hosts = build_hosts(&processes, &apps, Some(&good));
        assert!(
            hosts[1].connected
                && hosts[1].script_directories.is_empty()
                && hosts[1].capabilities.singer_assignment
                && !hosts[1].capabilities.retakes
                && !hosts[1].capabilities.computed_pitch
                && !hosts[1].capabilities.voice_parameters.write
                && hosts[1].capabilities.export_snapshot
        );
        let bad = good.replace("\"runtimeReady\":true", "\"runtimeReady\":false");
        assert!(!build_hosts(&processes, &apps, Some(&bad))[1].connected);
    }

    #[test]
    fn flat_process_path_with_spaces_is_detected() {
        let apps = vec![app(HostKind::Flat, FLAT_APP, None, "1.4.3")];
        let args = format!("{FLAT_EXECUTABLE_PATH} --open song.svp");
        let hosts = build_hosts(&[process(21, &args)], &apps, None);
        assert_eq!(hosts[0].id, "flat");
        assert_eq!(hosts[0].process_id, Some(21));
        assert!(hosts[0].running && !hosts[0].connected);
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
}
