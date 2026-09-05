import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rustRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src-tauri", "src");
const read = (name) => readFileSync(join(rustRoot, name), "utf8");

const concurrent = read("sv2_concurrent.rs");
const profiles = read("sv2_profiles.rs");
const sync = read("sv2_sync.rs");

assert.match(concurrent, /Uuid::new_v4\(\).*instance_id/s);
assert.match(concurrent, /instance_box_name/);
assert.match(concurrent, /create_overlay_slot_junction/);
assert.match(concurrent, /OpenFilePath/);
assert.match(concurrent, /vault\.join\("slots"\)\.join\(slot_id\)/);
assert.doesNotMatch(profiles, /ensure_shared_voice_databases\(paths, &manifest\)/);
assert.match(profiles, /Sv2SessionEnvironment::Normal,\s*&data_root/s);
assert.match(profiles, /switch_slot_windows/);
assert.match(profiles, /create_canonical_junction/);
assert.match(sync, /"settings\/settings\.xml"/);
assert.match(sync, /"scripts"/);

console.log("Concurrent slot storage contracts passed.");
