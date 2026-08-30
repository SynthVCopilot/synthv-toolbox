import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rustRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src-tauri", "src");
const webRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src");
const read = (path) => readFileSync(path, "utf8");

const probe = read(join(rustRoot, "sv2_account_probe.rs"));
const profiles = read(join(rustRoot, "sv2_profiles.rs"));
const commands = read(join(rustRoot, "commands.rs"));
const library = read(join(rustRoot, "lib.rs"));
const api = read(join(webRoot, "api.ts"));
const main = read(join(webRoot, "main.ts"));

assert.doesNotMatch(probe, /REPLACEFILE_WRITE_THROUGH/);
assert.match(probe, /cached_identity_for_fingerprint/);
assert.match(probe, /cached_identity_for_root/);
assert.match(profiles, /account_usage_snapshot_for_slot/);
assert.match(profiles, /enrich_account_probes\(paths, &mut state, false, None\)/);
assert.match(commands, /sv2_account_usage_snapshot_for_slot/);
assert.match(library, /commands::sv2_account_usage_snapshot_for_slot/);
assert.match(api, /sv2AccountUsageSnapshotForSlot/);
assert.match(main, /data-profile-refresh-slot/);
assert.match(main, /refreshAccountUsage\(slotId\)/);

console.log("SV2 account refresh contracts passed.");
