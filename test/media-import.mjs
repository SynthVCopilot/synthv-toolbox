import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rustRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src-tauri", "src");
const webRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src");
const read = (path) => readFileSync(path, "utf8");
const media = read(join(rustRoot, "media_import.rs"));
const commands = read(join(rustRoot, "commands.rs"));
const library = read(join(rustRoot, "lib.rs"));
const agent = read(join(rustRoot, "audio_capture.rs"));
const features = read(join(webRoot, "featureCatalog.ts"));
const main = read(join(webRoot, "main.ts"));

assert.match(media, /bilibili\.com/);
assert.match(media, /youtube\.com/);
assert.match(media, /b23\.tv/);
assert.match(media, /--ignore-config/);
assert.match(media, /--no-playlist/);
assert.match(media, /--no-remote-components/);
assert.match(media, /--audio-format/);
assert.match(media, /rights_confirmed/);
assert.match(media, /manifest\.json/);
assert.match(media, /sha256_file/);
assert.match(commands, /preview_media_source/);
assert.match(commands, /import_media_audio/);
assert.match(library, /commands::import_media_audio/);
assert.match(agent, /import_media_audio/);
assert.match(features, /id: "media-import"/);
assert.match(main, /id="media-import-form"/);

console.log("Media import contracts passed.");
