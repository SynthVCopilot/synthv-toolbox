import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src-tauri/src/synthv_control.rs", import.meta.url), "utf8");
assert.match(source, /QueryFullProcessImageNameW/);
assert.match(source, /SbieDll\.dll/);
assert.match(source, /pub is_sv2: bool/);
assert.match(source, /pub sandboxed: Option<bool>/);
assert.match(source, /is_sv2_executable_path/);
assert.match(source, /Some\(found\)/);
console.log("synthv process classification contract passed");
