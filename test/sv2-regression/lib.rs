#![allow(dead_code)]

#[path = "../../src/PiDesktop.Tauri/src-tauri/src/sv2_voice_catalog.rs"]
mod sv2_voice_catalog;

#[path = "../../src/PiDesktop.Tauri/src-tauri/src/sv2_concurrent.rs"]
pub mod sv2_concurrent;
#[path = "../../src/PiDesktop.Tauri/src-tauri/src/sv2_sync.rs"]
mod sv2_sync;
#[path = "../../src/PiDesktop.Tauri/src-tauri/src/sv2_session_guard.rs"]
mod sv2_session_guard;
#[path = "../../src/PiDesktop.Tauri/src-tauri/src/sv2_account_probe.rs"]
mod sv2_account_probe;
#[path = "../../src/PiDesktop.Tauri/src-tauri/src/sv2_profiles.rs"]
mod sv2_profiles;
#[path = "../../src/PiDesktop.Tauri/src-tauri/src/svp_launch_router.rs"]
mod svp_launch_router;

mod synthv {
    use std::{path::PathBuf, process::Command};

    use serde::Serialize;

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "lowercase")]
    pub enum BridgeProfile {
        Sv2,
        Sv1,
        Flat,
        Unsupported,
    }

    #[derive(Debug, Clone)]
    pub struct SynthVInstallation {
        pub display_name: String,
        pub install_path: Option<String>,
        pub executable_path: Option<String>,
        pub scripts_path: Option<String>,
        pub source: String,
        pub bridge_profile: BridgeProfile,
    }

    pub struct OperationResult {
        pub succeeded: bool,
        pub summary: String,
        pub detail: String,
    }

    pub fn succeeded(summary: impl Into<String>, detail: impl Into<String>) -> OperationResult {
        OperationResult { succeeded: true, summary: summary.into(), detail: detail.into() }
    }

    pub fn failed(summary: impl Into<String>, detail: impl Into<String>) -> OperationResult {
        OperationResult { succeeded: false, summary: summary.into(), detail: detail.into() }
    }

    pub fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
        #[allow(unused_mut)]
        let mut command = Command::new(program);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
    }

    pub fn find_sv2_executable() -> Option<PathBuf> {
        None
    }

    pub fn scan_installations() -> Vec<SynthVInstallation> {
        Vec::new()
    }
}
