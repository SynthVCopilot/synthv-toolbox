import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const webRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src");
const read = (name) => readFileSync(join(webRoot, name), "utf8");
const main = read("main.ts");
const api = read("api.ts");

const downloadedBranch = main.indexOf('component.downloaded && component.id === "sandboxie"');
const managedDownloadedBranch = main.indexOf('component.downloaded && component.installable');
assert.ok(downloadedBranch >= 0 && managedDownloadedBranch > downloadedBranch, "downloaded managed components must have an install action after the Sandboxie package action");
assert.match(main, /if \(!directory\) return;/, "directory dialog cancellation must leave the current selection unchanged");
assert.match(main, /data-clear-ffmpeg-directory/);
assert.match(main, /data-open-ffmpeg-download/);
assert.match(api, /get_ffmpeg_configuration/);
assert.match(api, /set_ffmpeg_directory/);
assert.match(api, /open_ffmpeg_download_page/);

console.log("Media installer UI contracts passed.");
