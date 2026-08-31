import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rustRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src-tauri", "src");
const webRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src");
const read = (path) => readFileSync(path, "utf8");

const profiles = read(join(rustRoot, "sv2_profiles.rs"));
const main = read(join(webRoot, "main.ts"));
const readme = read(join(repositoryRoot, "README.md"));

assert.match(profiles, /cfg\(target_os = "macos"\)/);
assert.match(profiles, /join\("Library\/Application Support"\)/);
assert.match(profiles, /join\("Dreamtonics"\)/);
assert.match(profiles, /fs2::FileExt/);
assert.match(profiles, /\/usr\/sbin\/lsof/);
assert.match(profiles, /macos_paths_stay_under_the_current_users_application_support/);
assert.match(main, /app\.platform === "macos"/);
assert.match(main, /supportsWindowsSv2Extensions/);
assert.match(main, /macOS v1 不会强制结束进程，也不会启动并发实例/);
assert.match(readme, /Windows 和 macOS 都提供可选的 SV2 本地数据槽位/);

console.log("macOS SV2 slot contracts passed.");
