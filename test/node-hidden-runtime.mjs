import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const agentRuntime = read("src/PiDesktop.Tauri/src-tauri/src/agent_runtime.rs");
const workflows = read("src/PiDesktop.Tauri/src-tauri/src/bridge_workflows.rs");
const unified = read("src/PiDesktop.Tauri/src-tauri/src/synthv_unified.rs");
const mcpClient = read("src/PiDesktop.Tauri/src-tauri/src/mcp/client.rs");

assert.match(agentRuntime, /as_std_mut\(\)\s*\.creation_flags\(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW\)/);
assert.match(workflows, /quiet_command\(node\)\s*\.arg\(script\)/);
assert.match(unified, /crate::synthv::quiet_command\(node\)\s*\.arg\(bridge_dir\.join/);
assert.match(mcpClient, /as_std_mut\(\)\s*\.creation_flags\(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW\)/);
console.log("bundled Node background commands use CREATE_NO_WINDOW");
