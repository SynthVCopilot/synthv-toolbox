import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const components = readFileSync(
  join(repositoryRoot, "src", "PiDesktop.Tauri", "src-tauri", "src", "components.rs"),
  "utf8",
);
const downloads = readFileSync(
  join(repositoryRoot, "src", "PiDesktop.Tauri", "src-tauri", "src", "downloads.rs"),
  "utf8",
);
const api = readFileSync(join(repositoryRoot, "src", "PiDesktop.Tauri", "src", "api.ts"), "utf8");
const main = readFileSync(join(repositoryRoot, "src", "PiDesktop.Tauri", "src", "main.ts"), "utf8");
const guide = readFileSync(join(repositoryRoot, "docs", "lyric-and-audio-workflow-guide.zh-CN.md"), "utf8");

assert.match(components, /ureq::AgentBuilder::new\(\)[\s\S]*\.get\(url\)/);
assert.match(components, /create_new\(true\)/);
assert.match(components, /MAX_COMPONENT_DOWNLOAD_BYTES/);
assert.match(components, /MAX_FFMPEG_DOWNLOAD_BYTES/);
assert.match(components, /sync_all\(\)/);
assert.match(components, /fs::rename\(&temporary, target\)/);
assert.match(components, /SANDBOXIE_INSTALLER_URL/);
assert.match(components, /FFMPEG_ARCHIVE_URL/);
assert.match(components, /let source = components_dir\.join\(id\)/);
assert.doesNotMatch(components, /raw\.githubusercontent\.com\/SynthVCopilot\/pi-agent/);
assert.match(components, /MEDIA_FETCHER_MACOS_SHA256/);
assert.doesNotMatch(components, /aria2/i);
assert.doesNotMatch(downloads, /aria2/i);
assert.doesNotMatch(api, /aria2/i);
assert.doesNotMatch(main, /aria2/i);
assert.doesNotMatch(guide, /aria2/i);
assert.match(main, /内置下载器只获取固定版本/);

console.log("Native component download contracts passed.");
