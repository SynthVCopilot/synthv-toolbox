import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rustRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src-tauri", "src");
const read = (path) => readFileSync(path, "utf8");
const components = read(join(rustRoot, "components.rs"));
const downloads = read(join(rustRoot, "downloads.rs"));
const catalog = read(join(rustRoot, "agent", "catalog.rs"));

assert.match(catalog, /"media-fetcher"/);
assert.match(components, /MEDIA_FETCHER_VERSION: &str = "2026\.08\.19"/);
assert.match(components, /yt-dlp_macos/);
assert.match(components, /yt-dlp\.exe/);
assert.match(components, /0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202/);
assert.match(components, /66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a/);
assert.match(components, /download_with_aria2/);
assert.match(components, /managed_media_fetcher_binary/);
assert.match(downloads, /"media-fetcher" => Some\("媒体导入器"\)/);

console.log("Media fetcher component contracts passed.");
