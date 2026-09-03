import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "src/PiDesktop.Tauri/src-tauri/src/synthv_hosts.rs"), "utf8");

assert.match(source, /pub enum HostKind/);
assert.match(source, /OfficialSv1/);
assert.match(source, /OfficialSv2/);
assert.match(source, /pub enum ConnectionKind/);
assert.match(source, /pub struct HostCapabilities/);
assert.match(source, /pub id: String/);
for (const field of ["project", "sequence", "transport", "tracks", "parts", "notes", "singer_list", "singer_assignment", "retakes", "computed_pitch", "export_snapshot", "audio_capture"]) {
  assert.match(source, new RegExp(`pub ${field}: bool`));
}
assert.match(source, /pub voice_parameters: CapabilityAccess/);
assert.match(source, /Synthesizer V Studio Pro\.app/);
assert.match(source, /synthv-studio/);
assert.match(source, /Contents\/Resources\/Synthesizer V Studio\/Contents\/MacOS\/Synthesizer V Flat/);
assert.match(source, /starts_with\(FLAT_EXECUTABLE_PATH\)/);
assert.match(source, /com\.dreamtonics\.svstudio2\.pro/);
assert.match(source, /org\.anthronics\.svflat\.macos/);
assert.doesNotMatch(source, /com\.dreamtonics\.synthesizervstudio/);
assert.match(source, /Library\/Application Support\/Dreamtonics\/Synthesizer V Studio\/scripts/);
assert.match(source, /HostKind::Flat => Vec::new\(\)/);
assert.match(source, /HostKind::Flat => "Synthesizer V Flat"/);
assert.match(source, /value\.get\("CFBundleExecutable"\)/);
assert.match(source, /127\.0\.0\.1/);
assert.match(source, /mcp-status/); // Keep the status-file contract visible to the implementation audit.
assert.match(source, /pub fn discover/);
assert.doesNotMatch(source, /connect\s*\(/);
assert.doesNotMatch(source, /write_all|remove_file|set_permissions/);

console.log("unified host discovery contract: ok");
