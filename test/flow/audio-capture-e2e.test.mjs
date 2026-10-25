// Drives the four capture commands through the Electron command registry, the real embedded bridge and a fake SynthV host,
// with the native capture executable replaced by a script that speaks its stdio protocol.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeHost } from "../fixtures/synthv-fake-host.mjs";

const desktopRoot = fileURLToPath(new URL("../../src/PiDesktop.Tauri/", import.meta.url));
const load = path => import(pathToFileURL(join(desktopRoot, path)).href);
const { ElectronCommandRegistry } = await load("dist/electron/services/command-registry.js");
const { bridgeCaptureTransport, createAudioCaptureService, sidecarCapture } = await load("dist/electron/services/audio-capture.js");
const { decodeWave } = await load("dist/electron/services/audio-clip-analysis.js");
const { loadConfig } = await load("components/synthv-agent-bridge/dist/src/config.js");
const { createEmbeddedBridge } = await load("components/synthv-agent-bridge/dist/src/embedded.js");
const fakeCapture = fileURLToPath(new URL("../fixtures/fake-audio-capture.mjs", import.meta.url));

const ORIGINAL_PLAYHEAD = 7.5;
const now = () => performance.timeOrigin + performance.now();

test("capture and compare commands run end to end against a fake SynthV and capture executable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "audio-capture-e2e-"));
  const ipcDirectory = join(root, "ipc"), outputDirectory = join(root, "ab-captures"), transportFile = join(root, "transport.json"), log = join(root, "capture-log.jsonl");
  const playback = { status: "stopped", head: ORIGINAL_PLAYHEAD, playFrom: 0, startedAt: null };
  const calls = [];
  const publish = async (stoppedAt = null) => { const temporary = `${transportFile}.tmp`; await writeFile(temporary, JSON.stringify({ playFrom: playback.playFrom, startedAt: playback.startedAt, stoppedAt })); await rename(temporary, transportFile); };
  const playhead = () => playback.status === "playing" ? playback.playFrom + (now() - playback.startedAt) / 1000 : playback.head;
  const host = await startFakeHost({ ipcDirectory, handler: async (action, payload) => {
    if (action !== "playback") return { e: { code: "UNSUPPORTED", message: action } };
    calls.push(payload.timeSeconds === undefined ? payload.operation : `${payload.operation} ${payload.timeSeconds}`);
    if (payload.operation === "seek") { playback.head = payload.timeSeconds; if (playback.status === "playing") { playback.playFrom = payload.timeSeconds; playback.startedAt = now(); await publish(); } }
    if (payload.operation === "play") { playback.status = "playing"; playback.playFrom = playback.head; playback.startedAt = now(); await publish(); }
    if (payload.operation === "stop") { playback.head = playhead(); playback.status = "stopped"; await publish(now()); }
    return { operation: payload.operation, status: playback.status, playheadSeconds: playhead() };
  } });
  const config = loadConfig({ SYNTHV_AGENT_BRIDGE_DIR: ipcDirectory, SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "3000", SYNTHV_AGENT_BRIDGE_POLL_MS: "5", SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "4000", SYNTHV_AGENT_BRIDGE_STATUS_STALE_MS: "5000" }, ipcDirectory);
  const bridge = createEmbeddedBridge({ config, clientLabel: "audio-capture-e2e" });
  const history = [];
  const audioCapture = createAudioCaptureService({
    platform: "win32", systemVersion: "10.0.22631", executablePath: fakeCapture, outputDirectory,
    transport: bridgeCaptureTransport(bridge),
    startCapture: sidecarCapture(process.execPath, [fakeCapture]),
    listTargets: async () => [{ processId: 4242, name: "synthv-studio.exe" }],
  });
  const inertHost = { async load() { return {}; }, async contributions() { return []; }, runtime: { dispose: async () => {} } };
  const registry = new ElectronCommandRegistry(inertHost, { ai: {}, desktop: {}, synthv: {}, componentAudio: { dataRoot: root }, audioCapture, creative: { record: async (kind, parameters, result) => { history.push({ kind, parameters, result }); } } });
  const savedEnv = { ...process.env };
  Object.assign(process.env, { FAKE_AUDIO_CAPTURE_TRANSPORT: transportFile, FAKE_AUDIO_CAPTURE_LOG: log });
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await host.stop(); await bridge.close();
    await rm(root, { recursive: true, force: true });
  });
  const range = { processId: null, startSeconds: 1, endSeconds: 1.5, preRollSeconds: 0.2, postRollSeconds: 0.1 };
  const capture = async (label, env = {}) => {
    for (const key of ["FAKE_AUDIO_CAPTURE_AMPLITUDE", "FAKE_AUDIO_CAPTURE_DISCONTINUITIES", "FAKE_AUDIO_CAPTURE_FAIL_START"]) delete process.env[key];
    Object.assign(process.env, env);
    calls.length = 0;
    return registry.invoke("capture_synthv_clip", { ...range, label });
  };

  await t.test("capability and targets", async () => {
    assert.deepEqual(await registry.invoke("audio_capture_capability"), { supported: true, backend: "wasapi-process-loopback", detail: "Windows process loopback records only the selected SynthV process tree (build 22631).", maxClipSeconds: 30 });
    assert.deepEqual(await registry.invoke("list_synthv_capture_targets"), [{ processId: 4242, name: "synthv-studio.exe" }]);
  });

  let first, second, quieter;
  await t.test("a capture plays the range once, restores the playhead and keeps a mono PCM16 clip with its metadata", async () => {
    first = await capture("take A");
    assert.equal(first.kind, "synthv-clip-capture");
    assert.equal(calls[0], "status");
    assert.equal(calls[1], "seek 0.8");
    assert.equal(calls[2], "play");
    assert.deepEqual(calls.slice(-2), ["stop", `seek ${ORIGINAL_PLAYHEAD}`]);
    assert.equal(playback.status, "stopped");
    assert.equal(playback.head, ORIGINAL_PLAYHEAD);
    const bytes = await readFile(first.outputPath);
    const wave = decodeWave(bytes);
    assert.equal(wave.sampleRate, 48000);
    assert.equal(wave.samples.length, 24000);
    assert.equal(bytes.readUInt16LE(22), 1);
    assert.equal(bytes.readUInt16LE(34), 16);
    assert.equal(first.data.frames, 24000);
    assert.equal(first.data.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(JSON.parse(await readFile(first.data.metadataPath, "utf8")), first.data);
    assert.ok(first.data.metrics.silentSampleRatio < 0.01, "the cropped range lies inside playback");
    assert.deepEqual(JSON.parse((await readFile(log, "utf8")).trim().split("\n").at(-1)).processId, 4242);
    assert.deepEqual(history.at(-1).kind, "synthv-clip-capture");
    assert.equal(history.at(-1).parameters.label, "take A");
  });

  await t.test("two captures of one range compare as near-identical, a quieter take as a subtle change, within the boundary uncertainty", async () => {
    second = await capture("take B");
    quieter = await capture("take C", { FAKE_AUDIO_CAPTURE_AMPLITUDE: "0.25" });
    const same = await registry.invoke("compare_synthv_clips", { baselinePath: first.outputPath, candidatePath: second.outputPath, maxLagMs: 250 });
    assert.equal(same.kind, "synthv-ab-compare");
    assert.equal(same.data.classification, "near-identical");
    assert.ok(Math.abs(same.data.alignedLagMs) <= first.data.boundaryUncertaintyMs + second.data.boundaryUncertaintyMs, `lag ${same.data.alignedLagMs} ms`);
    const changed = await registry.invoke("compare_synthv_clips", { baselinePath: first.outputPath, candidatePath: quieter.outputPath, maxLagMs: 250 });
    assert.equal(changed.data.classification, "subtle-change");
    assert.ok(Math.abs(changed.data.loudnessDeltaDb + 6.02) < 0.2, `loudness delta ${changed.data.loudnessDeltaDb} dB`);
    assert.match(changed.summary, /^A\/B comparison: subtle change, \d+\.\d% similar, aligned offset [+-]\d+\.\d ms\.$/);
    assert.equal(history.at(-1).kind, "synthv-ab-compare");
  });

  await t.test("rejected captures leave no files behind and still restore the playhead", async () => {
    const before = (await readdir(outputDirectory)).sort();
    await assert.rejects(capture("broken", { FAKE_AUDIO_CAPTURE_DISCONTINUITIES: "2" }), /2 discontinuities/);
    assert.equal(playback.head, ORIGINAL_PLAYHEAD);
    await assert.rejects(capture("silent", { FAKE_AUDIO_CAPTURE_AMPLITUDE: "0" }), /No audio was captured from PID 4242/);
    await assert.rejects(capture("no start", { FAKE_AUDIO_CAPTURE_FAIL_START: "1" }), /Process loopback could not start\. \(start, code 0x88890008\)/);
    assert.deepEqual(calls, ["status", "seek 0.8", `seek ${ORIGINAL_PLAYHEAD}`]);
    assert.equal(playback.head, ORIGINAL_PLAYHEAD);
    playback.status = "playing"; playback.startedAt = now(); playback.playFrom = 3;
    await assert.rejects(capture("while playing"), /stopped state/);
    assert.deepEqual(calls, ["status"], "nothing is moved while the user is listening");
    playback.status = "stopped"; playback.head = ORIGINAL_PLAYHEAD;
    assert.deepEqual((await readdir(outputDirectory)).sort(), before);
  });
});
