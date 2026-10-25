import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { clipMetrics, compareWaves, cropWave, decodeWave, encodeWave, MAX_WAV_BYTES, type ClipMetrics, type WaveComparison } from "./audio-clip-analysis.js";
import type { EmbeddedBridge } from "./synthv-bridge.js";

export const MAX_CLIP_SECONDS = 30;
export const MAX_GUARD_SECONDS = 2;
const MAX_LABEL_CHARACTERS = 40;
const WINDOWS_PROCESS_LOOPBACK_BUILD = 20_348;
const PLAYBACK_POLL_MS = 45;
const STOP_SETTLE_MS = 80;
const READY_TIMEOUT_MS = 15_000;
const FINISH_TIMEOUT_MS = 10_000;
const WINDOWS_TARGETS = ["synthv-studio.exe", "synthesizer v studio 2 pro.exe", "synthesizer v studio pro.exe", "synthesizer v studio.exe"];
const MAC_TARGETS = ["synthv-studio", "synthesizer v flat", "synthesizer v studio 2 pro", "synthesizer v studio pro", "synthesizer v studio"];

export interface AudioCaptureCapability { supported: boolean; backend: string; detail: string; maxClipSeconds: number; }
export interface AudioCaptureTarget { processId: number; name: string; }
export interface CaptureClipRequest { processId?: number | null; startSeconds: number; endSeconds: number; preRollSeconds?: number; postRollSeconds?: number; label?: string; }
export interface CapturePlan { processId: number | null; startSeconds: number; endSeconds: number; preRollSeconds: number; postRollSeconds: number; label: string; playFromSeconds: number; actualPreRollSeconds: number; playUntilSeconds: number; durationSeconds: number; }
export interface CapturedClip {
  outputPath: string; metadataPath: string; processId: number; processName: string; sessionToken: string | null;
  requestedStartSeconds: number; requestedEndSeconds: number; actualPreRollSeconds: number;
  sampleRate: number; channels: 1; bitsPerSample: 16; frames: number; discontinuities: number; boundaryUncertaintyMs: number;
  sha256: string; metrics: ClipMetrics;
}
export interface CompareClipsRequest { baselinePath: string; candidatePath: string; maxLagMs?: number; }
export interface AbComparison extends WaveComparison { baselinePath: string; candidatePath: string; }

export interface CaptureTransport {
  sessionToken(): Promise<string | null>;
  playback(operation: "status" | "seek" | "play" | "stop", timeSeconds?: number): Promise<{ status: string; playheadSeconds: number | null }>;
}
export interface NativeCaptureResult { sampleRate: number; channels: number; frames: number; discontinuities: number; }
// armedAt is performance.now() when frames started flowing, the reference the crop is placed against.
export interface NativeCaptureSession { readonly armedAt: number; finish(): Promise<NativeCaptureResult>; }
export type NativeCaptureStarter = (processId: number, outputPath: string) => Promise<NativeCaptureSession>;

export interface AudioCaptureService {
  capability(): Promise<AudioCaptureCapability>;
  listTargets(): Promise<AudioCaptureTarget[]>;
  capture(request: CaptureClipRequest): Promise<CapturedClip>;
  compare(request: CompareClipsRequest): Promise<AbComparison>;
}
export interface AudioCaptureServiceOptions {
  platform: string;
  systemVersion: string;
  executablePath: string;
  outputDirectory: string;
  transport: CaptureTransport;
  startCapture?: NativeCaptureStarter;
  listTargets?: () => Promise<AudioCaptureTarget[]>;
}

export function captureExecutablePath(componentsRoot: string, platform = process.platform): string {
  return join(componentsRoot, "audio-capture", "bin", platform === "win32" ? "audio-capture.exe" : "audio-capture");
}

export function captureCapability(platform: string, systemVersion: string, executablePresent: boolean): AudioCaptureCapability {
  const result = (supported: boolean, backend: string, detail: string) => ({ supported, backend, detail, maxClipSeconds: MAX_CLIP_SECONDS });
  const unavailable = (detail: string) => result(false, "unavailable", detail);
  const version = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(systemVersion.trim());
  let backend: AudioCaptureCapability;
  if (platform === "win32") {
    const build = version?.[3] === undefined ? undefined : Number(version[3]);
    if (build === undefined) return unavailable("The Windows build number could not be read, so process loopback stays off rather than capture unreliably.");
    if (build < WINDOWS_PROCESS_LOOPBACK_BUILD) return unavailable(`Windows build ${build} has no process loopback; build ${WINDOWS_PROCESS_LOOPBACK_BUILD} or later is required.`);
    backend = result(true, "wasapi-process-loopback", `Windows process loopback records only the selected SynthV process tree (build ${build}).`);
  } else if (platform === "darwin") {
    if (!version) return unavailable("The macOS version could not be read, so process audio capture stays off.");
    const major = Number(version[1]), minor = Number(version[2]);
    if (major < 14 || (major === 14 && minor < 2)) return unavailable(`macOS ${major}.${minor} has no Core Audio process taps; macOS 14.2 or later is required.`);
    backend = result(true, "core-audio-process-tap", "A Core Audio process tap records only the selected SynthV process. macOS asks for System Audio Recording permission the first time.");
  } else {
    return unavailable("Process audio capture is available on Windows and macOS only.");
  }
  return executablePresent ? backend : unavailable("This build does not include the audio capture component.");
}

export function validateCaptureRequest(input: Record<string, unknown>): CapturePlan {
  const seconds = (key: string, fallback?: number) => {
    const value = input[key] ?? fallback;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number.`);
    return value;
  };
  const startSeconds = seconds("startSeconds"), endSeconds = seconds("endSeconds");
  const preRollSeconds = seconds("preRollSeconds", 0.4), postRollSeconds = seconds("postRollSeconds", 0.25);
  const processId = input.processId ?? null;
  if (processId !== null && (typeof processId !== "number" || !Number.isSafeInteger(processId) || processId <= 0)) throw new Error("processId must be a positive integer.");
  const label = input.label ?? "";
  if (typeof label !== "string") throw new Error("label must be a string.");
  if (startSeconds < 0 || endSeconds <= startSeconds) throw new Error("The clip end must be after a non-negative start.");
  if (endSeconds - startSeconds > MAX_CLIP_SECONDS) throw new Error(`Clips are at most ${MAX_CLIP_SECONDS} seconds long.`);
  if (preRollSeconds < 0 || preRollSeconds > MAX_GUARD_SECONDS || postRollSeconds < 0 || postRollSeconds > MAX_GUARD_SECONDS) throw new Error(`Pre-roll and post-roll must be between 0 and ${MAX_GUARD_SECONDS} seconds.`);
  if ([...label].length > MAX_LABEL_CHARACTERS) throw new Error(`The clip label is limited to ${MAX_LABEL_CHARACTERS} characters.`);
  const playFromSeconds = Math.max(0, startSeconds - preRollSeconds);
  return { processId, startSeconds, endSeconds, preRollSeconds, postRollSeconds, label, playFromSeconds, actualPreRollSeconds: startSeconds - playFromSeconds, playUntilSeconds: endSeconds + postRollSeconds, durationSeconds: endSeconds - startSeconds };
}

export function resolveCaptureTarget(targets: AudioCaptureTarget[], processId: number | null): AudioCaptureTarget {
  if (processId !== null) {
    const target = targets.find(item => item.processId === processId);
    if (!target) throw new Error(`No SynthV standalone process with PID ${processId} is running.`);
    return target;
  }
  if (targets.length === 0) throw new Error("No running SynthV standalone process was found.");
  if (targets.length > 1) throw new Error(`Several SynthV instances are running; choose a PID: ${targets.map(item => `${item.processId} (${item.name})`).join(", ")}`);
  return targets[0];
}

export function parseCaptureTargets(platform: string, output: string): AudioCaptureTarget[] {
  const names = platform === "win32" ? WINDOWS_TARGETS : MAC_TARGETS;
  const targets = output.split(/\r?\n/).flatMap(line => {
    const match = platform === "win32" ? /^"([^"]+)","(\d+)"/.exec(line.trim()) : /^(\d+)\s+(.+)$/.exec(line.trim());
    if (!match) return [];
    const [name, pid] = platform === "win32" ? [match[1], match[2]] : [match[2].slice(match[2].lastIndexOf("/") + 1), match[1]];
    return names.includes(name.toLowerCase()) ? [{ processId: Number(pid), name }] : [];
  });
  return targets.sort((left, right) => left.processId - right.processId);
}

export async function systemCaptureTargets(platform = process.platform): Promise<AudioCaptureTarget[]> {
  if (platform !== "win32" && platform !== "darwin") return [];
  const [file, args] = platform === "win32" ? ["tasklist.exe", ["/FO", "CSV", "/NH"]] : ["ps", ["-axo", "pid=,comm="]];
  const output = await new Promise<string>((done, reject) => {
    const child = spawn(file, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? done(stdout) : reject(new Error(stderr.trim() || `${file} exited with ${code}.`)));
  });
  return parseCaptureTargets(platform, output);
}

export function bridgeCaptureTransport(bridge: Pick<EmbeddedBridge, "tools" | "status">): CaptureTransport {
  return {
    async sessionToken() {
      const status = await bridge.status();
      if (!status.connected) throw new Error(String(status.reason ?? "Connect SynthV Bridge before capturing a clip."));
      return typeof status.status?.sessionToken === "string" ? status.status.sessionToken : null;
    },
    async playback(operation, timeSeconds) {
      const tool = bridge.tools.find(item => item.name === "sv_ui");
      if (!tool) throw new Error("The connected SynthV Bridge has no playback control.");
      const reply = await tool.call({ action: "playback", args: timeSeconds === undefined ? { operation } : { operation, timeSeconds } });
      let value: unknown;
      try { value = JSON.parse(reply.text); } catch { throw new Error(reply.text); }
      const record = value as { outcome?: string; error?: { code?: string; message?: string } };
      if (reply.isError || record.outcome === "failed") throw new Error(`${record.error?.code ?? "BRIDGE_ERROR"}: ${record.error?.message ?? reply.text}`);
      const status = findValue(value, "status", "string"), playhead = findValue(value, "playheadSeconds", "number");
      return { status: typeof status === "string" ? status : "unknown", playheadSeconds: typeof playhead === "number" ? playhead : null };
    },
  };
}

export function sidecarCapture(command: string, prefixArgs: string[] = []): NativeCaptureStarter {
  return (processId, outputPath) => new Promise((resolveStart, rejectStart) => {
    const child = spawn(command, [...prefixArgs, "--pid", String(processId), "--output", outputPath], { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let armedAt: number | undefined, finished: NativeCaptureResult | undefined, failure: string | undefined, stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdin.on("error", () => undefined);
    const exited = new Promise<void>(done => { child.once("close", () => done()); child.once("error", () => done()); });
    const startTimer = setTimeout(() => { failure = "The audio capture component did not start in time."; child.kill(); }, READY_TIMEOUT_MS);
    createInterface({ input: child.stdout }).on("line", line => {
      let event: Record<string, unknown>;
      try { event = JSON.parse(line); } catch { return; }
      if (event.event === "ready" && armedAt === undefined) {
        armedAt = performance.now(); clearTimeout(startTimer);
        resolveStart({ armedAt, finish });
      } else if (event.event === "finished") {
        finished = { sampleRate: Number(event.sampleRate), channels: Number(event.channels), frames: Number(event.frames), discontinuities: Number(event.discontinuities) };
      } else if (event.event === "error") {
        failure = `${String(event.message ?? "Audio capture failed.")} (${String(event.stage ?? "capture")}, code ${statusCode(event.code)})`;
      }
    });
    const reason = () => failure ?? (stderr.trim() || `The audio capture component exited with code ${child.exitCode}.`);
    child.once("error", error => { failure = `The audio capture component could not run: ${error.message}`; });
    void exited.then(() => { clearTimeout(startTimer); if (armedAt === undefined) rejectStart(new Error(reason())); });
    async function finish(): Promise<NativeCaptureResult> {
      child.stdin.end("stop\n");
      const timer = setTimeout(() => { failure ??= "The audio capture component did not finish in time."; child.kill(); }, FINISH_TIMEOUT_MS);
      await exited; clearTimeout(timer);
      if (!finished || child.exitCode !== 0) throw new Error(reason());
      return finished;
    }
  });
}

export function createAudioCaptureService(options: AudioCaptureServiceOptions): AudioCaptureService {
  const transport = options.transport, startCapture = options.startCapture ?? sidecarCapture(options.executablePath), listTargets = options.listTargets ?? (() => systemCaptureTargets());
  const capability = async () => captureCapability(options.platform, options.systemVersion, await access(options.executablePath, constants.X_OK).then(() => true, () => false));
  return {
    capability,
    listTargets,
    async capture(request) {
      const plan = validateCaptureRequest(request as unknown as Record<string, unknown>);
      const available = await capability();
      if (!available.supported) throw new Error(available.detail);
      const target = resolveCaptureTarget(await listTargets(), plan.processId);
      const sessionToken = await transport.sessionToken();
      const before = await transport.playback("status");
      if (before.status !== "stopped") throw new Error("SynthV is playing. Clip capture starts only from the stopped state so it never interrupts listening.");
      if (before.playheadSeconds === null) throw new Error("SynthV Bridge did not report the current playhead.");
      const originalPlayhead = before.playheadSeconds;
      const directory = resolve(options.outputDirectory);
      await mkdir(directory, { recursive: true });
      const stem = captureStem(plan.label, new Date(), randomUUID());
      const rawPath = join(directory, `${stem}.raw.wav`), outputPath = join(directory, `${stem}.wav`), metadataPath = join(directory, `${stem}.json`);
      const discard = (...paths: string[]) => Promise.all(paths.map(path => rm(path, { force: true }))).then(() => undefined);
      const settle = <T>(promise: Promise<T>) => promise.then(value => ({ value }), (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }));

      await transport.playback("seek", plan.playFromSeconds);
      let session: NativeCaptureSession;
      try { session = await startCapture(target.processId, rawPath); }
      catch (error) { await settle(transport.playback("seek", originalPlayhead)); await discard(rawPath); throw error; }

      const playCalled = performance.now();
      const played = await settle(transport.playback("play"));
      const playReturned = performance.now();
      if ("error" in played) {
        await settle(session.finish()); await settle(transport.playback("stop")); await settle(transport.playback("seek", originalPlayhead)); await discard(rawPath);
        throw played.error;
      }
      const roundTripMs = playReturned - playCalled;
      const playbackError = await waitForPlayhead(transport, plan);
      const stopped = await settle(transport.playback("stop"));
      await delay(STOP_SETTLE_MS);
      const native = await settle(session.finish());
      const restored = await settle(transport.playback("seek", originalPlayhead));
      const failure = playbackError ?? ("error" in stopped ? stopped.error : undefined) ?? ("error" in restored ? restored.error : undefined);
      if (failure || "error" in native) { await discard(rawPath); throw failure ?? ("error" in native ? native.error : undefined); }
      if (native.value.discontinuities > 0) { await discard(rawPath); throw new Error(`The capture saw ${native.value.discontinuities} discontinuities, so the clip was rejected rather than skew an A/B result.`); }
      const after = await settle(transport.sessionToken());
      if ("error" in after) { await discard(rawPath); throw after.error; }
      if (sessionToken !== null && after.value !== null && after.value !== sessionToken) { await discard(rawPath); throw new Error("The SynthV Bridge session changed during capture, so the clip no longer matches its project."); }

      const cropStart = Math.max(0, (playCalled + roundTripMs / 2 - session.armedAt) / 1000) + plan.actualPreRollSeconds;
      let encoded: Buffer, cropped: ReturnType<typeof cropWave>;
      try {
        cropped = cropWave(decodeWave(await readFile(rawPath)), cropStart, plan.durationSeconds);
        encoded = encodeWave(cropped);
      } finally { await discard(rawPath); }
      const metrics = clipMetrics(cropped);
      if (metrics.silentSampleRatio === 1) throw new Error(`No audio was captured from PID ${target.processId}. Check that the range contains rendered audio, that SynthV Bridge runs in this instance, and that system audio recording is allowed.`);
      await writeFile(outputPath, encoded, { flag: "wx" });
      const clip: CapturedClip = {
        outputPath, metadataPath, processId: target.processId, processName: target.name, sessionToken,
        requestedStartSeconds: plan.startSeconds, requestedEndSeconds: plan.endSeconds, actualPreRollSeconds: plan.actualPreRollSeconds,
        sampleRate: cropped.sampleRate, channels: 1, bitsPerSample: 16, frames: cropped.samples.length, discontinuities: 0,
        boundaryUncertaintyMs: roundTripMs / 2 + 10, sha256: createHash("sha256").update(encoded).digest("hex"), metrics,
      };
      try { await writeFile(metadataPath, JSON.stringify(clip, null, 2), { encoding: "utf8", flag: "wx" }); }
      catch (error) { await discard(outputPath, metadataPath); throw error; }
      return clip;
    },
    async compare(request) {
      const maxLagMs = request.maxLagMs ?? 250;
      if (typeof maxLagMs !== "number") throw new Error("maxLagMs must be a number.");
      const [baselinePath, baseline] = await readClip(request.baselinePath, "A");
      const [candidatePath, candidate] = await readClip(request.candidatePath, "B");
      return { baselinePath, candidatePath, ...compareWaves(baseline, candidate, maxLagMs) };
    },
  };
}

export type HistoryRecorder = (kind: string, parameters: Record<string, unknown>, result: Record<string, unknown>) => Promise<unknown>;
type WorkflowResult = { kind: string; summary: string; outputPath?: string; data: Record<string, unknown> };
const CLASS_LABELS: Record<string, string> = { "near-identical": "near-identical", "subtle-change": "subtle change", "material-change": "material change", "large-change-or-misalignment": "large change or unconfirmed alignment" };

export function registerAudioCaptureCommands(registry: { register(command: string, handler: (args: Record<string, unknown>) => Promise<unknown>): void }, service: AudioCaptureService, record: HistoryRecorder): void {
  const recorded = async (parameters: Record<string, unknown>, result: WorkflowResult) => {
    try { await record(result.kind, parameters, result); }
    catch (error) { result.data.historyWarning = error instanceof Error ? error.message : String(error); }
    return result;
  };
  registry.register("audio_capture_capability", async () => service.capability());
  registry.register("list_synthv_capture_targets", async () => service.listTargets());
  registry.register("capture_synthv_clip", async args => {
    const clip = await service.capture(args as unknown as CaptureClipRequest);
    return recorded(args, { kind: "synthv-clip-capture", summary: `Captured a ${clip.metrics.durationSeconds.toFixed(2)} s clip; its boundaries are accurate to about ${clip.boundaryUncertaintyMs.toFixed(0)} ms.`, outputPath: clip.outputPath, data: { ...clip } });
  });
  registry.register("compare_synthv_clips", async args => {
    const comparison = await service.compare(args as unknown as CompareClipsRequest);
    const offset = `${comparison.alignedLagMs >= 0 ? "+" : ""}${comparison.alignedLagMs.toFixed(1)}`;
    return recorded(args, { kind: "synthv-ab-compare", summary: `A/B comparison: ${CLASS_LABELS[comparison.classification]}, ${comparison.similarityPercent.toFixed(1)}% similar, aligned offset ${offset} ms.`, data: { ...comparison } });
  });
}

async function waitForPlayhead(transport: CaptureTransport, plan: CapturePlan): Promise<Error | undefined> {
  const deadline = performance.now() + (Math.max(plan.playUntilSeconds - plan.playFromSeconds, 0.1) + 15) * 1000;
  for (;;) {
    if (performance.now() >= deadline) return new Error("Timed out waiting for SynthV to play to the end of the clip.");
    await delay(PLAYBACK_POLL_MS);
    let state: Awaited<ReturnType<CaptureTransport["playback"]>>;
    try { state = await transport.playback("status"); } catch (error) { return error instanceof Error ? error : new Error(String(error)); }
    const playhead = state.playheadSeconds ?? plan.playFromSeconds;
    if (playhead + 0.002 >= plan.playUntilSeconds) return undefined;
    if (state.status === "stopped") return new Error(`SynthV stopped before the end of the clip (playhead ${playhead.toFixed(3)} s).`);
  }
}

async function readClip(value: unknown, label: string): Promise<[string, ReturnType<typeof decodeWave>]> {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Clip ${label} needs a WAV path.`);
  const path = resolve(value.trim());
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`Clip ${label} was not found: ${path}`);
  if (extname(path).toLowerCase() !== ".wav") throw new Error(`Clip ${label} must be a WAV file.`);
  if (info.size > MAX_WAV_BYTES) throw new Error(`Clip ${label} exceeds the 128 MiB comparison limit.`);
  return [path, decodeWave(await readFile(path))];
}

function captureStem(label: string, now: Date, unique: string): string {
  const safe = [...label.trim()].slice(0, MAX_LABEL_CHARACTERS).map(character => /[\p{L}\p{N}_-]/u.test(character) ? character : "_").join("");
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${safe || "clip"}-${unique.replaceAll("-", "").slice(0, 8)}`;
}

function findValue(value: unknown, key: string, type: "string" | "number"): unknown {
  if (Array.isArray(value)) { for (const item of value) { const found = findValue(item, key, type); if (found !== undefined) return found; } return undefined; }
  if (value === null || typeof value !== "object") return undefined;
  const own = (value as Record<string, unknown>)[key];
  if (typeof own === type) return own;
  for (const child of Object.values(value)) { const found = findValue(child, key, type); if (found !== undefined) return found; }
  return undefined;
}

function statusCode(code: unknown): string {
  const value = Number(code);
  return Number.isInteger(value) && value < 0 ? `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}` : String(code);
}

