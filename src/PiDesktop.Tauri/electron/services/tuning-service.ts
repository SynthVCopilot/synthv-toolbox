import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { SynthVService } from "./synthv-service.js";

type Data = Record<string, any>;

export interface SourceStyleFeatures { durationSec: number; medianPitchMidi: number; pitchRangeSemitones: number; vibratoRateHz: number; vibratoDepthCents: number; dynamicRangeDb: number; breathinessProxy: number; brightnessHz: number; voicedRatio: number; }
export interface TuningParameters { loudness: number; tension: number; breathiness: number; gender: number; toneShift: number; vibratoStrength: number; }
export interface TuningProfile { voiceName: string; normalizedVoiceName: string; sourceSamples: number; outcomeSamples: number; averageFeatures: SourceStyleFeatures; parameters: TuningParameters; updatedAtUtc: string; }

export const TUNING_COMMANDS = ["list_tuning_profiles", "get_tuning_profile", "learn_tuning_profile", "record_tuning_outcome", "apply_tuning_profile", "run_solo_tuning"] as const;

const FEATURE_KEYS: Array<keyof SourceStyleFeatures> = ["durationSec", "medianPitchMidi", "pitchRangeSemitones", "vibratoRateHz", "vibratoDepthCents", "dynamicRangeDb", "breathinessProxy", "brightnessHz", "voicedRatio"];
export const PARAMETER_BOUNDS: Record<keyof TuningParameters, readonly [number, number]> = { loudness: [-48, 12], tension: [-1, 1], breathiness: [-1, 1], gender: [-1, 1], toneShift: [-1, 1], vibratoStrength: [0, 2] };
const PARAMETER_KEYS = Object.keys(PARAMETER_BOUNDS) as Array<keyof TuningParameters>;
const MAX_PROFILE_WEIGHT_SAMPLES = 32;
const MIN_ACCEPTED_IMPROVEMENT = 0.02;
const MAX_SOLO_CLIP_SECONDS = 30;

export interface SoloAudio {
  capability(): Promise<{ supported: boolean; detail: string }>;
  capture(request: { processId: number; startSeconds: number; endSeconds: number; preRollSeconds: number; postRollSeconds: number; label: string }): Promise<{ outputPath: string }>;
  compare(request: { baselinePath: string; candidatePath: string; maxLagMs: number }): Promise<{ similarityPercent: number; loudnessDeltaDb: number }>;
}
export interface TuningBridge {
  currentProject(): Promise<string>;
  applyTuning(profile: TuningProfile, trackIndex: number, groupIndex: number): Promise<Data>;
}
export interface TuningServiceOptions {
  dataRoot: string;
  sourceStyle(audioPath: string, signal?: AbortSignal): Promise<Data>;
  bridge?: TuningBridge;
  checkpoint(projectPath: string, label: string): Promise<Data>;
  workMode?: () => "edit" | "solo";
  synthv?: Pick<SynthVService, "listProcesses" | "sendShortcut">;
  audio?: SoloAudio;
  pause?: (milliseconds: number) => Promise<void>;
}

export function parametersFromFeatures(features: SourceStyleFeatures): TuningParameters {
  return {
    loudness: clamp((features.dynamicRangeDb - 18) * 0.12, -3, 3),
    tension: clamp((features.brightnessHz - 2000) / 4000 + (features.pitchRangeSemitones - 12) / 48, -0.6, 0.6),
    breathiness: clamp((features.breathinessProxy - 0.18) * 2, -0.5, 0.7),
    gender: 0,
    toneShift: clamp((features.medianPitchMidi - 64) / 64, -0.25, 0.25),
    vibratoStrength: clamp((features.vibratoDepthCents / 100) * (features.vibratoRateHz / 6), 0, 1.5),
  };
}

export function blendParameters(target: TuningParameters, sample: TuningParameters, weight: number): TuningParameters {
  const result = {} as TuningParameters;
  for (const key of PARAMETER_KEYS) result[key] = clamp(blend(target[key], sample[key], weight), ...PARAMETER_BOUNDS[key]);
  return result;
}

export function moveParametersAway(target: TuningParameters, rejected: TuningParameters, weight: number): TuningParameters {
  const opposite = {} as TuningParameters;
  for (const key of PARAMETER_KEYS) opposite[key] = target[key] + (target[key] - rejected[key]);
  return blendParameters(target, opposite, weight);
}

export function featureDistance(reference: SourceStyleFeatures, rendered: SourceStyleFeatures): number {
  const terms = [
    Math.abs(reference.medianPitchMidi - rendered.medianPitchMidi) / 12,
    Math.abs(reference.pitchRangeSemitones - rendered.pitchRangeSemitones) / 24,
    Math.abs(reference.vibratoRateHz - rendered.vibratoRateHz) / 6,
    Math.abs(reference.vibratoDepthCents - rendered.vibratoDepthCents) / 200,
    Math.abs(reference.dynamicRangeDb - rendered.dynamicRangeDb) / 30,
    Math.abs(reference.breathinessProxy - rendered.breathinessProxy) / 0.5,
    Math.abs(reference.brightnessHz - rendered.brightnessHz) / 4000,
    Math.abs(reference.voicedRatio - rendered.voicedRatio),
  ];
  return terms.reduce((sum, term) => sum + term, 0) / terms.length;
}

export function createTuningService(options: TuningServiceOptions) {
  const root = join(resolve(options.dataRoot), "tuning-profiles");
  const pause = options.pause ?? (milliseconds => new Promise<void>(done => setTimeout(done, milliseconds)));
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>) => { const next = queue.then(task, task); queue = next.catch(() => undefined); return next; };
  const pathFor = (normalized: string) => join(root, `${createHash("sha256").update(normalized).digest("hex")}.json`);

  const read = async (path: string): Promise<TuningProfile | undefined> => {
    let contents: string;
    try { contents = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try { return profileFrom(JSON.parse(contents)); }
    catch (error) { throw new Error(`The tuning profile cannot be parsed: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const write = async (path: string, profile: TuningProfile) => {
    await mkdir(root, { recursive: true });
    for (const target of [root, path]) {
      try { if ((await lstat(target)).isSymbolicLink()) throw new Error("The tuning profile directory or file must not be a symbolic link."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const temporary = join(root, `.profile-${randomUUID()}.tmp`);
    try { await writeFile(temporary, JSON.stringify(profile, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  };
  const find = (voiceName: string) => read(pathFor(validVoiceName(voiceName).normalized));
  const get = async (voiceName: string) => {
    const profile = await find(voiceName);
    if (!profile) throw new Error(`No tuning profile exists for voice ${voiceName} yet.`);
    return profile;
  };

  const learn = (voiceName: string, features: SourceStyleFeatures) => serialize(async () => {
    const { display, normalized } = validVoiceName(voiceName);
    validateFeatures(features);
    const path = pathFor(normalized), existing = await read(path), suggested = parametersFromFeatures(features);
    let profile: TuningProfile;
    if (existing) {
      const samples = existing.sourceSamples + 1, weight = 1 / Math.min(samples, MAX_PROFILE_WEIGHT_SAMPLES);
      const averaged = {} as SourceStyleFeatures;
      for (const key of FEATURE_KEYS) averaged[key] = blend(existing.averageFeatures[key], features[key], weight);
      profile = { ...existing, voiceName: display, sourceSamples: samples, averageFeatures: averaged, parameters: blendParameters(existing.parameters, suggested, weight), updatedAtUtc: new Date().toISOString() };
    } else {
      profile = { voiceName: display, normalizedVoiceName: normalized, sourceSamples: 1, outcomeSamples: 0, averageFeatures: { ...features }, parameters: suggested, updatedAtUtc: new Date().toISOString() };
    }
    await write(path, profile);
    return profile;
  });

  const recordOutcome = (voiceName: string, candidate: TuningParameters, improvement: number) => serialize(async () => {
    validateParameters(candidate);
    if (typeof improvement !== "number" || !Number.isFinite(improvement) || improvement < -1 || improvement > 1) throw new Error("The A/B improvement score must be between -1 and 1.");
    const path = pathFor(validVoiceName(voiceName).normalized), existing = await read(path);
    if (!existing) throw new Error(`No tuning profile exists for voice ${voiceName} yet.`);
    const weight = Math.abs(improvement) * 0.25;
    const parameters = improvement >= 0 ? blendParameters(existing.parameters, candidate, weight) : moveParametersAway(existing.parameters, candidate, weight);
    const profile = { ...existing, parameters, outcomeSamples: existing.outcomeSamples + 1, updatedAtUtc: new Date().toISOString() };
    await write(path, profile);
    return profile;
  });

  const list = async (): Promise<TuningProfile[]> => {
    let names: string[];
    try { names = await readdir(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const profiles = await Promise.all(names.filter(name => name.endsWith(".json")).map(name => read(join(root, name)).catch(() => undefined)));
    return profiles.filter((item): item is TuningProfile => item !== undefined).sort((a, b) => a.voiceName < b.voiceName ? -1 : a.voiceName > b.voiceName ? 1 : 0);
  };

  const features = async (audioPath: unknown, signal?: AbortSignal) => {
    if (typeof audioPath !== "string" || !isAbsolute(audioPath)) throw new Error("audioPath must be an absolute path.");
    return sourceStyleFeatures(await options.sourceStyle(audioPath, signal));
  };
  const bridge = () => { if (!options.bridge) throw new Error("SynthV Bridge is unavailable."); return options.bridge; };
  const shortcut = async (processId: number, action: "save" | "undo") => {
    const target = (await options.synthv?.listProcesses())?.find(item => item.processId === processId);
    if (!target?.processIdentity) throw new Error("The selected SynthV process was not found.");
    const result = await options.synthv!.sendShortcut(target.processId, target.processIdentity, action);
    if (!result.succeeded) throw new Error(result.detail || result.summary);
  };

  async function solo(request: Data, signal?: AbortSignal): Promise<Data> {
    if ((options.workMode?.() ?? "edit") !== "solo") throw new Error("Automatic A/B tuning runs only in Solo mode.");
    validateSoloRequest(request);
    const audio = options.audio;
    const capability = await audio?.capability();
    if (!audio || !capability?.supported) throw new Error(capability?.detail ?? "System audio capture is unavailable in this build.");
    if (await realpath(await bridge().currentProject()) !== await realpath(request.projectPath)) throw new Error("The requested project does not match the current Bridge project; Solo writes were stopped.");
    const checkpoint = await options.checkpoint(request.projectPath, `Before Solo tuning ${request.voiceName}`);
    const reference = await features(request.referenceAudioPath, signal);
    const capture = (label: string) => audio.capture({ processId: request.processId, startSeconds: request.startSeconds, endSeconds: request.endSeconds, preRollSeconds: 0.4, postRollSeconds: 0.25, label });
    const profile = (await find(request.voiceName)) ?? await learn(request.voiceName, reference);
    const baseline = await capture("solo-baseline");
    const before = featureDistance(reference, await features(baseline.outputPath, signal));
    const bridgeResult = await bridge().applyTuning(profile, request.trackIndex, request.groupIndex);
    const common = { referenceDistanceBefore: before, baselinePath: baseline.outputPath, checkpointPath: String(checkpoint.snapshotPath), projectPath: request.projectPath, bridgeResult };
    if (!(findNumber(bridgeResult, "changedCount") > 0)) return { accepted: false, changed: false, improvement: 0, referenceDistanceAfter: before, candidatePath: null, rollbackPath: null, rollbackVerified: true, profile, ...common };

    const candidate = await capture("solo-candidate");
    const after = featureDistance(reference, await features(candidate.outputPath, signal));
    const improvement = clamp((before - after) / Math.max(before, 0.001), -1, 1);
    const accepted = improvement >= MIN_ACCEPTED_IMPROVEMENT;
    const updated = await recordOutcome(request.voiceName, profile.parameters, improvement);
    const outcome = { accepted, changed: true, improvement, referenceDistanceAfter: after, candidatePath: candidate.outputPath, profile: updated, ...common };
    if (accepted) { await shortcut(request.processId, "save"); return { ...outcome, rollbackPath: null, rollbackVerified: true }; }

    await shortcut(request.processId, "undo");
    await pause(300);
    const rollback = await capture("solo-rollback");
    const comparison = await audio.compare({ baselinePath: baseline.outputPath, candidatePath: rollback.outputPath, maxLagMs: 250 });
    const rollbackVerified = comparison.similarityPercent >= 98 && Math.abs(comparison.loudnessDeltaDb) <= 0.5;
    if (!rollbackVerified) throw new Error(`The Solo candidate regressed and Undo did not restore the baseline; use checkpoint ${String(checkpoint.snapshotPath)}.`);
    return { ...outcome, rollbackPath: rollback.outputPath, rollbackVerified };
  }

  return {
    async invoke(command: string, args: Data, signal?: AbortSignal): Promise<unknown> {
      if (command === "list_tuning_profiles") return list();
      if (command === "get_tuning_profile") return get(text(args.voiceName, "voiceName"));
      if (command === "learn_tuning_profile") return learn(text(args.voiceName, "voiceName"), await features(args.audioPath, signal));
      if (command === "record_tuning_outcome") return recordOutcome(text(args.voiceName, "voiceName"), parametersFrom(args.candidate), args.improvement);
      if (command === "apply_tuning_profile") {
        const profile = await get(text(args.voiceName, "voiceName"));
        const data = await bridge().applyTuning(profile, positive(args.trackIndex, "trackIndex"), positive(args.groupIndex, "groupIndex"));
        return { kind: "learned-tuning-apply", summary: `Applied the locally learned tuning for voice ${profile.voiceName}.`, data };
      }
      if (command === "run_solo_tuning") { if (!args.request || typeof args.request !== "object") throw new Error("request must be an object."); return solo(args.request, signal); }
      throw new Error(`Unsupported tuning command: ${command}`);
    },
  };
}

function clamp(value: number, minimum: number, maximum: number) { return Math.min(maximum, Math.max(minimum, value)); }
function blend(current: number, sample: number, weight: number) { return current + (sample - current) * clamp(weight, 0, 1); }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`); return value; }
function positive(value: unknown, name: string): number { if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive integer.`); return value as number; }

function validVoiceName(value: unknown) {
  const display = typeof value === "string" ? value.trim() : "";
  if (!display || [...display].length > 200) throw new Error("The voice name must be 1 to 200 characters.");
  return { display, normalized: display.toLowerCase() };
}
function validateFeatures(value: SourceStyleFeatures) {
  if (!FEATURE_KEYS.every(key => finite(value[key])) || value.durationSec <= 0) throw new Error("The reference vocal features contain invalid values.");
}
function validateParameters(value: TuningParameters) {
  for (const key of PARAMETER_KEYS) {
    const [minimum, maximum] = PARAMETER_BOUNDS[key];
    if (!finite(value[key]) || value[key] < minimum || value[key] > maximum) throw new Error("The tuning parameters are outside SynthV's safe range.");
  }
}
function sourceStyleFeatures(value: Data): SourceStyleFeatures {
  const result = {} as SourceStyleFeatures;
  for (const key of FEATURE_KEYS) { if (!finite(value?.[key])) throw new Error(`The reference vocal features are invalid: ${key}.`); result[key] = value[key]; }
  validateFeatures(result);
  return result;
}
function parametersFrom(value: Data): TuningParameters {
  const result = {} as TuningParameters;
  for (const key of PARAMETER_KEYS) result[key] = value?.[key];
  validateParameters(result);
  return result;
}
function profileFrom(value: Data): TuningProfile {
  const name = validVoiceName(value.voiceName);
  if (!Number.isInteger(value.sourceSamples) || !Number.isInteger(value.outcomeSamples) || typeof value.updatedAtUtc !== "string" || typeof value.normalizedVoiceName !== "string") throw new Error("invalid profile fields");
  return { voiceName: name.display, normalizedVoiceName: value.normalizedVoiceName, sourceSamples: value.sourceSamples, outcomeSamples: value.outcomeSamples, averageFeatures: sourceStyleFeatures(value.averageFeatures), parameters: parametersFrom(value.parameters), updatedAtUtc: value.updatedAtUtc };
}
function validateSoloRequest(request: Data) {
  for (const key of ["processId", "trackIndex", "groupIndex"]) positive(request[key], key);
  if (!finite(request.startSeconds) || !finite(request.endSeconds) || request.startSeconds < 0 || request.endSeconds <= request.startSeconds || request.endSeconds - request.startSeconds > MAX_SOLO_CLIP_SECONDS) throw new Error("The Solo A/B clip must be a valid range of at most 30 seconds.");
  text(request.voiceName, "voiceName");
  for (const key of ["referenceAudioPath", "projectPath"]) if (typeof request[key] !== "string" || !isAbsolute(request[key])) throw new Error(`${key} must be an absolute path.`);
}
function findNumber(value: unknown, key: string): number {
  if (Array.isArray(value)) { for (const item of value) { const found = findNumber(item, key); if (found) return found; } return 0; }
  if (value && typeof value === "object") {
    const direct = (value as Data)[key];
    if (typeof direct === "number") return direct;
    for (const item of Object.values(value)) { const found = findNumber(item, key); if (found) return found; }
  }
  return 0;
}
