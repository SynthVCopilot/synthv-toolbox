import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { JSDOM } from "../src/PiDesktop.Tauri/node_modules/jsdom/lib/api.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(repositoryRoot, "src", "PiDesktop.Tauri", "src", "main.ts"), "utf8");

function functionSource(name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `missing ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const harnessSource = `
  const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const icon = () => "";
  let busy = false;
  let removingComponentId;
  let ffmpegDirectory = "C:/managed";
  let ffmpegDirectoryDraft;
  let ffmpegConfigurationLoading = false;
  const app = { downloads: [], components: [
    { id: "media-fetcher", displayName: "媒体导入器", description: "固定版本 yt-dlp", installed: false, downloaded: true, installable: true, removable: true, status: "缓存" },
    { id: "ffmpeg", displayName: "FFmpeg", description: "音视频转码", installed: false, downloaded: true, installable: true, removable: false, status: "缓存" },
    { id: "sandboxie", displayName: "Sandboxie", description: "并发隔离", installed: false, downloaded: true, installable: true, removable: false, status: "安装包" },
  ] };
  ${functionSource("renderComponents")}
  module.exports = {
    render: () => renderComponents(),
    setDraft: (value) => { ffmpegDirectoryDraft = value; },
    setBusy: (value) => { busy = value; },
    setLoading: (value) => { ffmpegConfigurationLoading = value; },
  };
`;
const transformed = stripTypeScriptTypes(harnessSource, { mode: "transform", sourceUrl: "installer-ui-harness.ts" });
const module = { exports: {} };
vm.runInNewContext(transformed, { module, exports: module.exports, console });
const harness = module.exports;

{
  const dom = new JSDOM(`<main>${harness.render()}</main>`);
  const html = dom.window.document.body.innerHTML;
  assert.match(html, /data-install-component="media-fetcher"/);
  assert.match(html, /data-install-component="ffmpeg"/);
  assert.match(html, /data-open-component-download="sandboxie"/);
  assert.doesNotMatch(html, /data-open-component-download="media-fetcher"/);
  assert.doesNotMatch(html, /class="tags"/);
}

{
  harness.setDraft("C:/user-picked-ffmpeg");
  const dom = new JSDOM(`<main>${harness.render()}</main>`);
  assert.equal(dom.window.document.querySelector("#ffmpeg-directory").value, "C:/user-picked-ffmpeg");
  harness.setBusy(true);
  const busyDom = new JSDOM(`<main>${harness.render()}</main>`);
  assert.equal(busyDom.window.document.querySelector("#ffmpeg-directory").disabled, true);
  harness.setBusy(false);
  harness.setLoading(true);
  const loadingDom = new JSDOM(`<main>${harness.render()}</main>`);
  assert.equal(loadingDom.window.document.querySelector("[data-open-ffmpeg-download]").disabled, true);
}

assert.match(source, /if \(!directory\) return;/, "directory dialog cancellation must preserve the draft");
assert.match(source, /generation !== ffmpegConfigurationGeneration/, "stale configuration loads must be ignored");
assert.match(source, /await refresh\(\);\s*refreshAudioRuntimeStatus\(\);/, "successful source changes must refresh availability and runtime state");

console.log("Media installer UI behavior passed.");
