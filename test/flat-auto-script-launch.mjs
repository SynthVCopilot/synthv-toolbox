import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rust = join(root, "src", "PiDesktop.Tauri", "src-tauri", "src");
const unified = readFileSync(join(rust, "synthv_unified.rs"), "utf8");
const hosts = readFileSync(join(rust, "synthv_hosts.rs"), "utf8");

assert.match(unified, /project_path: Option<String>/);
assert.match(unified, /"projectPath"/);
assert.match(unified, /validate_flat_project_path/);
assert.match(unified, /path\.is_absolute\(\)/);
assert.match(unified, /fs::canonicalize/);
assert.match(unified, /metadata\.file_type\(\)\.is_file\(\)/);
assert.match(unified, /metadata\.file_type\(\)\.is_symlink\(\)/);
assert.match(unified, /projectPath 仅支持 hostId=flat/);
assert.match(unified, /flat_process_ids/);
assert.match(unified, /launch_flat\(&host, project_path\.as_deref\(\)\)/);
assert.match(unified, /wait_for_flat_launch/);
assert.match(unified, /BridgeShortcutAction::Refresh/);
assert.match(unified, /synthv_control::start_bridge\(process_id\)/);
assert.match(unified, /install_legacy_bridge[\s\S]*Result<bool, String>/);
assert.match(unified, /无法连接所选 SynthV 宿主：\{error\}/);
assert.doesNotMatch(unified, /已安装或更新；请让宿主重新扫描扩展后再次连接/);

assert.match(hosts, /pub fn launch_flat/);
assert.match(hosts, /std::process::Command::new\(executable\)/);
assert.match(hosts, /command\.arg\(project_path\)/);
assert.match(hosts, /stdin\(Stdio::null\(\)\)/);
assert.match(hosts, /\["Synthesizer V Flat\.exe", "synthesizer-v-flat\.exe"\]/);
assert.match(hosts, /Documents\/Anthronics\/Synthesizer V Studio\/scripts/);
assert.doesNotMatch(hosts, /Command::new\("(?:sh|cmd|powershell)"\)/);

console.log("Flat automatic launch and script preparation contracts passed.");
