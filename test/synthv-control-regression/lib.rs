#![allow(dead_code)]

extern crate self as tauri;

pub mod async_runtime {
    pub use tokio::task::spawn_blocking;
}

pub mod mcp {
    use std::path::PathBuf;

    pub struct McpManager;

    impl McpManager {
        pub async fn disconnect(&self, _name: &str) {}

        pub async fn connect_bridge(
            &self,
            _node: String,
            _bridge_dir: PathBuf,
        ) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
    }
}

#[cfg(target_os = "macos")]
pub mod synthv {
    use std::process::Command;

    pub fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
        Command::new(program)
    }
}

#[path = "../../src/PiDesktop.Tauri/src-tauri/src/synthv_control.rs"]
pub mod synthv_control;
