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
  let start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `missing ${name}`);
  if (source.slice(start - 6, start) === "async ") start -= 6;
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

function createHarness(api = {}) {
  const dom = new JSDOM('<main><input id="ffmpeg-directory" /></main>');
  const harnessSource = `
  const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const icon = () => "";
  let busy = false;
  let removingComponentId;
  let ffmpegDirectory = "C:/managed";
  let ffmpegDirectoryDraft;
  let ffmpegConfigurationLoading = false;
  let ffmpegConfigurationGeneration = 0;
  let page = "components";
  let error = "";
  let notice = "";
  let refreshes = 0;
  let runtimeRefreshes = 0;
  const formatError = (reason) => String(reason);
  const setFeedback = (result) => { error = result.succeeded ? "" : result.summary; };
  const refresh = async () => { refreshes++; app.components[1].installed = true; };
  const refreshAudioRuntimeStatus = () => { runtimeRefreshes++; };
  const app = { downloads: [], components: [
    { id: "media-fetcher", displayName: "媒体导入器", description: "固定版本 yt-dlp", installed: false, downloaded: true, installable: true, removable: true, status: "缓存" },
    { id: "ffmpeg", displayName: "FFmpeg", description: "音视频转码", installed: false, downloaded: true, installable: true, removable: false, status: "缓存" },
    { id: "sandboxie", displayName: "Sandboxie", description: "并发隔离", installed: false, downloaded: true, installable: true, removable: false, status: "安装包" },
  ] };
  ${functionSource("renderComponents")}
  ${functionSource("loadFfmpegConfiguration")}
  ${functionSource("saveFfmpegDirectory")}
  ${functionSource("selectFfmpegDirectory")}
  const render = () => { document.querySelector("main").innerHTML = renderComponents(); };
  module.exports = {
    render: () => renderComponents(),
    load: loadFfmpegConfiguration,
    save: saveFfmpegDirectory,
    pick: selectFfmpegDirectory,
    state: () => ({ saved: ffmpegDirectory, draft: ffmpegDirectoryDraft, loading: ffmpegConfigurationLoading, refreshes, runtimeRefreshes, error }),
    setDraft: (value) => { ffmpegDirectoryDraft = value; },
    setBusy: (value) => { busy = value; },
    setLoading: (value) => { ffmpegConfigurationLoading = value; },
  };
`;
const transformed = stripTypeScriptTypes(harnessSource, { mode: "transform", sourceUrl: "installer-ui-harness.ts" });
const module = { exports: {} };
vm.runInNewContext(transformed, { module, exports: module.exports, console, api, document: dom.window.document });
return module.exports;
}

{
  const harness = createHarness();
  const dom = new JSDOM(`<main>${harness.render()}</main>`);
  const html = dom.window.document.body.innerHTML;
  assert.match(html, /data-install-component="media-fetcher"/);
  assert.match(html, /data-install-component="ffmpeg"/);
  assert.match(html, /data-open-component-download="sandboxie"/);
  assert.doesNotMatch(html, /data-open-component-download="media-fetcher"/);
  assert.doesNotMatch(html, /class="tags"/);
}

{
  const harness = createHarness();
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

{
  const api = { pickDirectory: async () => undefined };
  const harness = createHarness(api);
  harness.setDraft("C:/keep-draft");
  await harness.pick();
  assert.equal(harness.state().draft, "C:/keep-draft");
  api.pickDirectory = async () => "C:/picked";
  await harness.pick();
  assert.equal(harness.state().draft, "C:/picked");
}

{
  const api = { setFfmpegDirectory: async () => ({ succeeded: false, summary: "Missing ffprobe" }) };
  const harness = createHarness(api);
  harness.setDraft("C:/invalid");
  await harness.save("C:/invalid");
  assert.equal(harness.state().saved, "C:/managed");
  assert.equal(harness.state().draft, "C:/invalid");
  assert.equal(harness.state().refreshes, 0);
  assert.equal(harness.state().error, "Missing ffprobe");
  api.setFfmpegDirectory = async () => { throw new Error("Validation failed"); };
  await assert.rejects(harness.save("C:/invalid"), /Validation failed/);
  assert.equal(harness.state().draft, "C:/invalid");
}

{
  let saved;
  const harness = createHarness({
    setFfmpegDirectory: async (directory) => { saved = directory; return { succeeded: true }; },
    getFfmpegConfiguration: async () => ({ directory: saved === null ? null : "C:/canonical/bin" }),
  });
  harness.setDraft("C:/chosen/../bin");
  await harness.save("C:/chosen/../bin");
  assert.equal(harness.state().saved, "C:/canonical/bin");
  assert.equal(harness.state().draft, undefined);
  assert.equal(harness.state().refreshes, 1);
  assert.equal(harness.state().runtimeRefreshes, 1);
  const dom = new JSDOM(harness.render());
  assert.equal(dom.window.document.querySelector('[data-install-component="ffmpeg"]'), null);
  await harness.save(null);
  assert.equal(saved, null);
  assert.equal(harness.state().saved, null);
  assert.equal(harness.state().refreshes, 2);
}

{
  const resolvers = [];
  const harness = createHarness({ getFfmpegConfiguration: () => new Promise((resolve) => resolvers.push(resolve)) });
  const older = harness.load();
  const newer = harness.load();
  resolvers[1]({ directory: "C:/latest" });
  await newer;
  harness.setDraft("C:/unsaved");
  resolvers[0]({ directory: "C:/stale" });
  await older;
  assert.equal(harness.state().saved, "C:/latest");
  assert.equal(harness.state().draft, "C:/unsaved");
  assert.equal(harness.state().loading, false);
}

console.log("Media installer UI behavior passed.");
