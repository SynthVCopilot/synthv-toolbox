#![allow(dead_code)]

extern crate self as tauri;

pub mod async_runtime {
    pub use tokio::task::spawn_blocking;
}

pub mod mcp {
    use std::path::PathBuf;

    use serde_json::Value;

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

        pub async fn call_bridge_tool(
            &self,
            _name: &str,
            _arguments: Value,
        ) -> Result<Value, String> {
            Err(
                "Bridge calls are unavailable in the process-control regression harness"
                    .to_string(),
            )
        }
    }

    pub fn extract_mcp_json(_value: &Value) -> Result<Value, String> {
        Err(
            "Bridge responses are unavailable in the process-control regression harness"
                .to_string(),
        )
    }
}

pub mod synthv_unified {
    use serde_json::Value;

    pub fn bridge_session_token(_status: &Value) -> Result<String, String> {
        Err("Bridge sessions are unavailable in the process-control regression harness".to_string())
    }
}

#[cfg(target_os = "macos")]
pub mod synthv {
    use std::process::Command;

    pub fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
        #[cfg(test)]
        if let Some(output) = crate::macos_enumeration::command_output(program.as_ref()) {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "printf '%s' \"$1\"", "fixture"]).arg(output);
            return command;
        }
        Command::new(program)
    }
}

#[path = "../../src/PiDesktop.Tauri/src-tauri/src/synthv_control.rs"]
pub mod synthv_control;

#[cfg(all(test, target_os = "macos"))]
#[path = "macos_enumeration.rs"]
mod macos_enumeration;
