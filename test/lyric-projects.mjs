import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rustRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src-tauri", "src");
const webRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src");
const read = (path) => readFileSync(path, "utf8");

const projects = read(join(rustRoot, "lyric_projects.rs"));
const commands = read(join(rustRoot, "commands.rs"));
const library = read(join(rustRoot, "lib.rs"));
const types = read(join(webRoot, "types.ts"));
const api = read(join(webRoot, "api.ts"));
const main = read(join(webRoot, "main.ts"));

assert.match(projects, /data_root\(\)\.join\("lyric-projects"\)/);
assert.match(projects, /Uuid::parse_str/);
assert.match(projects, /create_new\(true\)/);
assert.match(projects, /file\.sync_all\(\)/);
assert.match(projects, /schema_version/);
assert.match(projects, /build_lyric_template/);
assert.match(commands, /list_lyric_projects/);
assert.match(commands, /create_lyric_project/);
assert.match(commands, /save_lyric_project/);
assert.match(commands, /load_lyric_project/);
assert.match(library, /commands::save_lyric_project/);
assert.match(types, /interface LyricProject/);
assert.match(api, /createLyricProject/);
assert.match(main, /data-save-lyric-project/);
assert.match(main, /data-load-lyric-project/);
assert.match(main, /lyricProjectHasUnsavedChanges/);

console.log("Lyric project contracts passed.");
