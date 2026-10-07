import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

const source = stripTypeScriptTypes(readFileSync(new URL("../src/PiDesktop.Tauri/electron/services/component-audio-commands.ts", import.meta.url), "utf8"), { mode: "transform" });
const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const handlers = new Map();
const root = mkdtempSync(join(tmpdir(), "toolbox-audio-"));
const inputPath = join(root, "input.wav");
writeFileSync(inputPath, "input");
const calls = [];
module.registerComponentAudioCommands({ register: (name, handler) => handlers.set(name, handler) }, { dataRoot: root, ffmpegPath: "ffmpeg", run: async (file, args) => { calls.push({ file, args }); if (args[0] === "-version") return { stdout: "ffmpeg test\n", stderr: "" }; if (file.includes("ffprobe")) return { stdout: '{"streams":[{"codec_type":"audio","codec_name":"pcm_s24le","sample_rate":"48000","channels":2}],"format":{"format_name":"wav","duration":"1","bit_rate":"2304000"}}', stderr: "" }; writeFileSync(args.at(-1), "output"); return { stdout: "", stderr: "" }; } });
const status = await handlers.get("ffmpeg_status")({});
assert.equal(status.available, true);
assert.match(status.ffprobePath, /ffprobe/);
assert.deepEqual(await handlers.get("get_ffmpeg_configuration")({}), { directory: null });
const probe = await handlers.get("probe_media")({ path: inputPath });
assert.equal(probe.codec, "pcm_s24le");
assert.equal(probe.sampleRate, 48000);
assert.deepEqual(await module.resolveFfmpegBinaries({ dataRoot: root }), { ffmpeg: "ffmpeg", ffprobe: "ffprobe", source: "system" });
const configuredFfmpegDirectory = join(root, "ffmpeg-bin");
mkdirSync(configuredFfmpegDirectory, { recursive: true });
writeFileSync(join(configuredFfmpegDirectory, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"), "");
writeFileSync(join(configuredFfmpegDirectory, process.platform === "win32" ? "ffprobe.exe" : "ffprobe"), "");
await handlers.get("set_ffmpeg_directory")({ directory: configuredFfmpegDirectory });
assert.deepEqual(await module.resolveFfmpegBinaries({ dataRoot: root }), {
  ffmpeg: join(configuredFfmpegDirectory, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
  ffprobe: join(configuredFfmpegDirectory, process.platform === "win32" ? "ffprobe.exe" : "ffprobe"),
  source: "configured",
});
assert.deepEqual(await module.resolveFfmpegBinaries({ dataRoot: mkdtempSync(join(tmpdir(), "toolbox-ffmpeg-fallback-")), ffmpegPath: "/custom/ffmpeg" }), {
  ffmpeg: "/custom/ffmpeg",
  ffprobe: join("/custom", process.platform === "win32" ? "ffprobe.exe" : "ffprobe"),
  source: "configured",
});
const request = { inputPath, sampleRate: 48000, channels: 1, sampleFormat: "s24" };
const plan = await handlers.get("plan_audio_prepare")({ request });
assert.match(plan.token, /^[0-9a-f-]{36}$/);
const job = await handlers.get("start_audio_prepare")({ request, token: plan.token });
const deadline = Date.now() + 5000;
let snapshot = await handlers.get("audio_job_snapshot")({ id: job.id });
while (snapshot.status === "running" && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 10));
  snapshot = await handlers.get("audio_job_snapshot")({ id: job.id });
}
assert.equal(snapshot.status, "completed");
await assert.rejects(handlers.get("start_audio_prepare")({ request, token: plan.token }), /invalid or expired/);
assert.ok(handlers.has("component_downloads"));
assert.ok(calls.some(call => call.file.includes("ffprobe")));

const waitFor = async (predicate, message) => {
  const end = Date.now() + 5000;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), message);
};
const noRuntimeTaskList = await handlers.get("queue_component_install")({ id: "pi-audio" });
const noRuntimeTask = noRuntimeTaskList[0];
await waitFor(() => noRuntimeTask.status === "failed", "missing runtime must not report a successful install");
assert.match(noRuntimeTask.detail, /runtime is not configured/u);
assert.deepEqual(await handlers.get("component_runtime_status")({}), {
  ready: false, detail: "The local creative Python runtime is not configured.",
});
const unknownTaskList = await handlers.get("queue_component_install")({ id: "unknown-component" });
await waitFor(() => unknownTaskList[0].status === "failed", "unsupported components must fail explicitly");
assert.match(unknownTaskList[0].detail, /No managed installer/u);

let runtimeReady = false;
const ensureCalls = [];
const runtimeHandlers = new Map();
const runtimeDataRoot = mkdtempSync(join(tmpdir(), "toolbox-creative-runtime-"));
module.registerComponentAudioCommands({ register: (name, handler) => runtimeHandlers.set(name, handler) }, {
  dataRoot: runtimeDataRoot,
  creativeRuntime: {
    status: async () => runtimeReady
      ? { ready: true, pythonPath: "/managed/python", missing: [], detail: "Runtime is ready." }
      : { ready: false, missing: ["managed Python runtime"], detail: "Runtime needs installation." },
    ensure: options => {
      let finish;
      const call = { signal: options.signal, finish: () => finish?.() };
      ensureCalls.push(call);
      options.onProgress?.(32, "Installing component dependencies");
      return new Promise((resolve, reject) => {
        finish = () => { runtimeReady = true; resolve("/managed/python"); };
        if (options.signal?.aborted) { reject(new Error("aborted")); return; }
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  },
});
assert.equal((await runtimeHandlers.get("component_runtime_status")({})).ready, false);
const componentIds = ["pi-audio", "cvrs", "vocal-separation"];
for (const [index, componentId] of componentIds.entries()) {
  const list = await runtimeHandlers.get("queue_component_install")({ id: componentId });
  const task = list[0];
  await waitFor(() => ensureCalls.length > index * 2, componentId + " must invoke runtime preparation");
  assert.equal(task.status, "installing");
  assert.equal(task.progress, 32);
  assert.equal(task.detail, "Installing component dependencies");
  const callIndex = ensureCalls.length - 1;
  await runtimeHandlers.get("cancel_component_install")({ taskId: task.id });
  assert.equal(task.status, "cancelled");
  assert.equal(ensureCalls[callIndex].signal.aborted, true);
  await runtimeHandlers.get("retry_component_install")({ taskId: task.id });
  await waitFor(() => ensureCalls.length > callIndex + 1, componentId + " retry must rerun ensure");
  const retry = ensureCalls.at(-1);
  retry.finish();
  await waitFor(() => task.status === "completed", componentId + " retry should complete after ensure succeeds");
  assert.equal(task.pythonPath, "/managed/python");
  assert.equal(task.progress, 100);
  assert.equal(task.runtimeStatus.ready, true);
}
const readyStatus = await runtimeHandlers.get("component_runtime_status")({});
assert.equal(readyStatus.ready, true);
assert.equal(readyStatus.pythonPath, "/managed/python");
console.log("Component and audio command behavior passed.");
