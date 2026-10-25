import assert from "node:assert/strict";
import test from "node:test";
import { compiled } from "../_lib/load.mjs";
import { assertProperty, fc } from "../_lib/props.mjs";

const { amplitudeDb, clipMetrics, compareWaves, cropWave, decodeWave, encodeWave, estimateLag } = await compiled("services/audio-clip-analysis.js");
const { captureCapability, parseCaptureTargets, resolveCaptureTarget, validateCaptureRequest, MAX_CLIP_SECONDS, MAX_GUARD_SECONDS } = await compiled("services/audio-capture.js");

function riff(format, channels, sampleRate, bits, frames, extraChunk) {
  const data = Buffer.alloc(frames.length * channels * (bits / 8));
  frames.forEach((frame, index) => frame.forEach((value, channel) => {
    const offset = (index * channels + channel) * (bits / 8);
    if (format === 3) data.writeFloatLE(value, offset); else data.writeInt16LE(value, offset);
  }));
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(format, 8); fmt.writeUInt16LE(channels, 10); fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * bits / 8, 16); fmt.writeUInt16LE(channels * bits / 8, 20); fmt.writeUInt16LE(bits, 22);
  const chunks = [fmt, ...(extraChunk ? [extraChunk] : []), Buffer.concat([Buffer.from("data"), Buffer.from(Uint32Array.of(data.length).buffer), data])];
  const body = Buffer.concat(chunks);
  return Buffer.concat([Buffer.from("RIFF"), Buffer.from(Uint32Array.of(4 + body.length).buffer), Buffer.from("WAVE"), body]);
}
const wave = (samples, sampleRate = 48000) => ({ sampleRate, samples: Float32Array.from(samples) });
/** Seeded one-pole low-passed noise: band-limited like rendered audio, without the period ambiguity of a pure tone. */
function bandLimited(seed, length, alpha) {
  let state = seed >>> 0, value = 0;
  const random = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32 * 2 - 1; };
  return Float32Array.from({ length }, () => (value += alpha * (random() - value)));
}

test("multichannel PCM16 and float32 WAV files decode to the channel mean, past unknown and odd-sized chunks", () => {
  const odd = Buffer.concat([Buffer.from("LIST"), Buffer.from(Uint32Array.of(3).buffer), Buffer.from([1, 2, 3, 0])]);
  const pcm = decodeWave(riff(1, 2, 44100, 16, [[16384, -16384], [32767, 32767], [-32768, 0]], odd));
  assert.equal(pcm.sampleRate, 44100);
  assert.deepEqual([...pcm.samples].map(value => Number(value.toFixed(5))), [0, 0.99997, -0.5]);
  const float = decodeWave(riff(3, 2, 48000, 32, [[0.5, 0.25], [1.5, 1.5], [-1, -0.5]]));
  assert.deepEqual([...float.samples], [0.375, 1, -0.75]);
});

test("a mono PCM16 encode decodes back within two quantization steps", () => {
  const source = wave(Array.from({ length: 2000 }, (_, index) => Math.sin(index / 7) * 0.9));
  const bytes = encodeWave(source);
  assert.equal(bytes.length, 44 + 4000);
  const decoded = decodeWave(bytes);
  for (let index = 0; index < source.samples.length; index += 1) assert.ok(Math.abs(decoded.samples[index] - source.samples[index]) <= 2 / 32767);
});

test("files that are not comparable WAV audio are rejected with the reason", () => {
  assert.throws(() => decodeWave(Buffer.alloc(64)), /not a RIFF\/WAVE/);
  assert.throws(() => decodeWave(riff(1, 1, 48000, 24, [[1]])), /Only PCM16 and IEEE float32/);
  const truncated = riff(1, 1, 48000, 16, [[1], [2]]);
  assert.throws(() => decodeWave(truncated.subarray(0, truncated.length - 2)), /runs past the end/);
  assert.throws(() => decodeWave(riff(1, 1, 4000, 16, [[1]])), /sample rate is unsupported/);
});

test("metrics on full-scale and silent signals hit their bounds", () => {
  const square = clipMetrics(wave(Array.from({ length: 480 }, (_, index) => (index % 2 ? 1 : -1))));
  assert.equal(square.peakDbfs, 0);
  assert.equal(square.rmsDbfs, 0);
  assert.equal(square.clippedSampleRatio, 1);
  assert.equal(square.durationSeconds, 0.01);
  assert.equal(Math.round(square.highFrequencyProxyDb * 1000) / 1000, Math.round(amplitudeDb(2) * 1000) / 1000);
  const silence = clipMetrics(wave(new Array(480).fill(0)));
  assert.equal(silence.silentSampleRatio, 1);
  assert.equal(silence.peakDbfs, -180);
});

test("cropping takes the exact frames asked for, or reports how short the capture is", () => {
  const source = wave(Array.from({ length: 48000 }, (_, index) => index / 48000));
  const cropped = cropWave(source, 0.25, 0.5);
  assert.equal(cropped.samples.length, 24000);
  assert.equal(cropped.samples[0], source.samples[12000]);
  assert.throws(() => cropWave(source, 0.75, 0.5), /needs 1\.250 s but holds 1\.000 s/);
});

test("a delayed, quieter or inverted candidate is aligned and classified", () => {
  const tone = Array.from({ length: 8000 }, (_, index) => Math.sin(index * 0.071) * 0.6 + (index % 997 < 10 ? 0.3 : 0));
  assert.ok(Math.abs(estimateLag(Float32Array.from(tone), Float32Array.from([...new Array(173).fill(0), ...tone]), 500) - 173) <= 2);
  const a = [...bandLimited(7, 8000, 0.1)];
  const delayed = [...new Array(173).fill(0), ...a];
  const shifted = compareWaves(wave(a), wave(delayed), 50);
  assert.equal(shifted.alignedLagMs, 173 / 48);
  assert.equal(shifted.classification, "near-identical");
  const quieter = compareWaves(wave(a), wave(a.map(value => value / 2)), 50);
  assert.equal(quieter.classification, "subtle-change");
  assert.ok(Math.abs(quieter.loudnessDeltaDb + 6.0206) < 1e-3);
  const inverted = compareWaves(wave(a), wave(a.map(value => -value)), 0);
  assert.equal(inverted.classification, "large-change-or-misalignment");
  assert.equal(inverted.similarityPercent, 0);
  assert.throws(() => compareWaves(wave(a), wave(a, 44100), 50), /different sample rates/);
  assert.throws(() => compareWaves(wave(a), wave(a), 1001), /between 0 and 1000 ms/);
  assert.throws(() => compareWaves(wave(a.slice(0, 479)), wave(a), 50), /too short/);
});

test("law: the alignment offset never exceeds the requested bound or a quarter of the shorter clip", () => {
  const clip = fc.float32Array({ min: -1, max: 1, noNaN: true, minLength: 1200, maxLength: 3000 });
  assertProperty(fc.tuple(clip, clip, fc.double({ min: 0, max: 1000, noNaN: true })), ([a, b, maxLagMs]) => {
    const result = compareWaves({ sampleRate: 8000, samples: a }, { sampleRate: 8000, samples: b }, maxLagMs);
    const lagFrames = Math.abs(Math.round(result.alignedLagMs * 8));
    assert.ok(lagFrames <= Math.round(maxLagMs * 8) && lagFrames <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 4)));
    assert.ok(Math.round(result.overlapSeconds * 8000) <= Math.min(a.length, b.length));
    assert.ok(result.correlation >= -1 && result.correlation <= 1 && result.similarityPercent >= 0 && result.similarityPercent <= 100);
  }, { endOnFailure: true }); // Shrinking thousand-sample arrays takes minutes; the printed seed replays the case.
});

const bandLimitedClip = fc.record({ seed: fc.integer(), length: fc.integer({ min: 8000, max: 16000 }), alpha: fc.double({ min: 0.08, max: 0.12, noNaN: true }) }).map(({ seed, length, alpha }) => bandLimited(seed, length, alpha));

test("law: a band-limited clip compared with itself is reported as identical at zero offset", () => {
  assertProperty(fc.tuple(bandLimitedClip, fc.double({ min: 0, max: 1000, noNaN: true })), ([samples, maxLagMs]) => {
    const result = compareWaves({ sampleRate: 16000, samples }, { sampleRate: 16000, samples }, maxLagMs);
    assert.equal(result.alignedLagMs, 0);
    assert.equal(result.overlapSeconds, samples.length / 16000);
    assert.equal(result.loudnessDeltaDb, 0);
    assert.equal(result.classification, "near-identical");
  });
});

test("law: a band-limited clip delayed or advanced within the bound is realigned exactly", () => {
  assertProperty(fc.tuple(bandLimitedClip, fc.double({ min: 0, max: 1000, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true })), ([samples, maxLagMs, fraction]) => {
    const delay = Math.round(fraction * Math.min(Math.round(maxLagMs * 16), Math.floor(samples.length / 5)));
    const candidate = delay >= 0 ? Float32Array.from([...new Float32Array(delay), ...samples]) : samples.slice(-delay);
    const result = compareWaves({ sampleRate: 16000, samples }, { sampleRate: 16000, samples: candidate }, maxLagMs);
    assert.ok(Math.round(result.alignedLagMs * 16) === delay, `found ${result.alignedLagMs} ms for a ${delay}-frame delay`);
    assert.equal(result.classification, "near-identical");
  });
});

test("capture capability follows the OS builds that have process-scoped capture, and the shipped executable", () => {
  const supported = (platform, version, present = true) => captureCapability(platform, version, present).supported;
  assert.equal(supported("win32", "10.0.20347"), false);
  assert.equal(supported("win32", "10.0.20348"), true);
  assert.equal(supported("win32", "10.0"), false);
  assert.equal(supported("darwin", "14.1.2"), false);
  assert.equal(supported("darwin", "14.2"), true);
  assert.equal(supported("darwin", "26.0.1"), true);
  assert.equal(supported("linux", "6.8.0"), false);
  assert.deepEqual(captureCapability("win32", "10.0.22631", false), { supported: false, backend: "unavailable", detail: "This build does not include the audio capture component.", maxClipSeconds: 30 });
  assert.equal(captureCapability("darwin", "14.5.0", true).backend, "core-audio-process-tap");
  assert.match(captureCapability("win32", "10.0.19045", true).detail, /build 19045 has no process loopback; build 20348/);
});

test("capture requests are validated with the defaults and limits of the clip workflow", () => {
  assert.deepEqual(validateCaptureRequest({ startSeconds: 0.1, endSeconds: 2 }), { processId: null, startSeconds: 0.1, endSeconds: 2, preRollSeconds: 0.4, postRollSeconds: 0.25, label: "", playFromSeconds: 0, actualPreRollSeconds: 0.1, playUntilSeconds: 2.25, durationSeconds: 1.9 });
  assert.equal(validateCaptureRequest({ startSeconds: 0, endSeconds: 1, label: "调".repeat(40) }).label.length, 40);
  for (const [request, message] of [
    [{ startSeconds: 2, endSeconds: 2 }, /end must be after a non-negative start/],
    [{ startSeconds: -1, endSeconds: 2 }, /non-negative start/],
    [{ startSeconds: 0, endSeconds: 30.01 }, /at most 30 seconds/],
    [{ startSeconds: 0, endSeconds: 1, preRollSeconds: 2.5 }, /between 0 and 2 seconds/],
    [{ startSeconds: 0, endSeconds: 1, label: "x".repeat(41) }, /limited to 40 characters/],
    [{ startSeconds: Number.NaN, endSeconds: 1 }, /startSeconds must be a finite number/],
    [{ startSeconds: 0, endSeconds: 1, processId: 1.5 }, /positive integer/],
  ]) assert.throws(() => validateCaptureRequest(request), message);
});

test("law: a valid request plays a window that starts at or before the clip, never before zero, and stays within the clip and guard limits", () => {
  const request = fc.record({ startSeconds: fc.double({ min: 0, max: 600, noNaN: true }), duration: fc.double({ min: 0.001, max: MAX_CLIP_SECONDS, noNaN: true }), preRollSeconds: fc.double({ min: 0, max: MAX_GUARD_SECONDS, noNaN: true }), postRollSeconds: fc.double({ min: 0, max: MAX_GUARD_SECONDS, noNaN: true }) });
  assertProperty(request, ({ startSeconds, duration, preRollSeconds, postRollSeconds }) => {
    const endSeconds = startSeconds + duration;
    if (endSeconds <= startSeconds || endSeconds - startSeconds > MAX_CLIP_SECONDS) return;
    const plan = validateCaptureRequest({ startSeconds, endSeconds, preRollSeconds, postRollSeconds });
    assert.ok(plan.playFromSeconds >= 0 && plan.playFromSeconds <= startSeconds);
    assert.ok(plan.actualPreRollSeconds >= 0 && plan.actualPreRollSeconds <= preRollSeconds + 1e-9);
    assert.ok(plan.playUntilSeconds >= endSeconds && plan.playUntilSeconds - plan.playFromSeconds <= MAX_CLIP_SECONDS + 2 * MAX_GUARD_SECONDS + 1e-9);
  });
});

test("SynthV standalone processes are found by executable name on Windows and macOS, and one must be chosen when several run", () => {
  const tasklist = ['"System","4","Services","0","144 K"', '"Synthesizer V Studio 2 Pro.exe","9120","Console","1","812,004 K"', '"node.exe","300","Console","1","50,000 K"', '"synthv-studio.exe","812","Console","1","1,024 K"', '"synthv-agent-bridge.exe","77","Console","1","1 K"'].join("\r\n");
  assert.deepEqual(parseCaptureTargets("win32", tasklist), [{ processId: 812, name: "synthv-studio.exe" }, { processId: 9120, name: "Synthesizer V Studio 2 Pro.exe" }]);
  const ps = ["  1 /sbin/launchd", "4021 /Applications/Synthesizer V Studio 2 Pro.app/Contents/MacOS/synthv-studio", " 77 /usr/local/bin/node /tmp/synthv-studio-helper.js", "5150 /Applications/Synthesizer V Flat.app/Contents/MacOS/Synthesizer V Flat"].join("\n");
  assert.deepEqual(parseCaptureTargets("darwin", ps), [{ processId: 4021, name: "synthv-studio" }, { processId: 5150, name: "Synthesizer V Flat" }]);
  const targets = parseCaptureTargets("win32", tasklist);
  assert.throws(() => resolveCaptureTarget(targets, null), /Several SynthV instances are running; choose a PID: 812 \(synthv-studio\.exe\), 9120/);
  assert.equal(resolveCaptureTarget(targets, 9120).name, "Synthesizer V Studio 2 Pro.exe");
  assert.throws(() => resolveCaptureTarget(targets, 1), /No SynthV standalone process with PID 1/);
  assert.throws(() => resolveCaptureTarget([], null), /No running SynthV standalone process/);
});
