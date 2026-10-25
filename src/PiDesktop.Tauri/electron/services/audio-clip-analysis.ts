export interface MonoWave { sampleRate: number; samples: Float32Array; }

export interface ClipMetrics {
  durationSeconds: number;
  peakDbfs: number;
  rmsDbfs: number;
  clippedSampleRatio: number;
  silentSampleRatio: number;
  highFrequencyProxyDb: number;
}

export type ComparisonClass = "near-identical" | "subtle-change" | "material-change" | "large-change-or-misalignment";

export interface WaveComparison {
  sampleRate: number;
  alignedLagMs: number;
  overlapSeconds: number;
  correlation: number;
  deltaRmsDb: number;
  loudnessDeltaDb: number;
  peakDeltaDb: number;
  clippingDeltaPercent: number;
  highFrequencyDeltaDb: number;
  similarityPercent: number;
  classification: ComparisonClass;
  baseline: ClipMetrics;
  candidate: ClipMetrics;
}

export const MAX_WAV_BYTES = 128 * 1024 * 1024;
export const MAX_LAG_MS = 1000;
const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const MIN_COMPARE_FRAMES = 480;
const LAG_COARSE_STEP = 8;
const LAG_WINDOW_FRAMES = 5 * 48_000;

export function decodeWave(bytes: Uint8Array): MonoWave {
  if (bytes.byteLength > MAX_WAV_BYTES) throw new Error("The WAV exceeds the 128 MiB comparison limit.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (bytes.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("The input is not a RIFF/WAVE file.");
  let format: { tag: number; channels: number; sampleRate: number; bits: number } | undefined;
  let data: { start: number; end: number } | undefined;
  for (let cursor = 12; cursor + 8 <= bytes.byteLength;) {
    const id = tag(cursor), size = view.getUint32(cursor + 4, true), start = cursor + 8, end = start + size;
    if (end > bytes.byteLength) throw new Error("A WAV chunk runs past the end of the file.");
    if (id === "fmt ") {
      if (size < 16) throw new Error("The WAV fmt chunk is too short.");
      format = { tag: view.getUint16(start, true), channels: view.getUint16(start + 2, true), sampleRate: view.getUint32(start + 4, true), bits: view.getUint16(start + 14, true) };
    } else if (id === "data") data = { start, end };
    cursor = end + (size & 1);
  }
  if (!format) throw new Error("The WAV has no fmt chunk.");
  if (!data) throw new Error("The WAV has no data chunk.");
  if (format.channels === 0 || format.channels > 32 || format.sampleRate < 8_000 || format.sampleRate > 384_000) throw new Error("The WAV channel count or sample rate is unsupported.");
  const pcm = format.tag === WAVE_FORMAT_PCM && format.bits === 16, float = format.tag === WAVE_FORMAT_IEEE_FLOAT && format.bits === 32;
  if (!pcm && !float) throw new Error("Only PCM16 and IEEE float32 WAV files can be compared.");
  const bytesPerSample = pcm ? 2 : 4, frameBytes = format.channels * bytesPerSample;
  const frames = Math.floor((data.end - data.start) / frameBytes);
  if (frames === 0) throw new Error("The WAV has no audio frames.");
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < format.channels; channel += 1) {
      const offset = data.start + frame * frameBytes + channel * bytesPerSample;
      sum += pcm ? view.getInt16(offset, true) / 32768 : view.getFloat32(offset, true);
    }
    samples[frame] = Math.min(1, Math.max(-1, sum / format.channels));
  }
  return { sampleRate: format.sampleRate, samples };
}

export function encodeWave(wave: MonoWave): Buffer {
  const dataSize = wave.samples.length * 2;
  if (dataSize > 0xffff_ffff - 36) throw new Error("The WAV data exceeds the RIFF size limit.");
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(36 + dataSize, 4); bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(WAVE_FORMAT_PCM, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(wave.sampleRate, 24); bytes.writeUInt32LE(wave.sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii"); bytes.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < wave.samples.length; index += 1) {
    const scaled = Math.min(1, Math.max(-1, wave.samples[index])) * 32767;
    bytes.writeInt16LE(Math.sign(scaled) * Math.round(Math.abs(scaled)), 44 + index * 2);
  }
  return bytes;
}

export function cropWave(wave: MonoWave, startSeconds: number, durationSeconds: number): MonoWave {
  const start = Math.max(0, Math.round(startSeconds * wave.sampleRate));
  const end = start + Math.max(1, Math.round(durationSeconds * wave.sampleRate));
  if (end > wave.samples.length) throw new Error(`The capture is too short: it needs ${(end / wave.sampleRate).toFixed(3)} s but holds ${(wave.samples.length / wave.sampleRate).toFixed(3)} s.`);
  return { sampleRate: wave.sampleRate, samples: wave.samples.slice(start, end) };
}

export function amplitudeDb(value: number): number { return 20 * Math.log10(Math.max(value, 1e-9)); }

export function clipMetrics(wave: MonoWave): ClipMetrics {
  const samples = wave.samples, count = samples.length;
  let clipped = 0, silent = 0, differenceEnergy = 0;
  for (let index = 0; index < count; index += 1) {
    const magnitude = Math.abs(samples[index]);
    if (magnitude >= 0.999) clipped += 1;
    if (magnitude <= 0.0001) silent += 1;
    if (index > 0) { const difference = samples[index] - samples[index - 1]; differenceEnergy += difference * difference; }
  }
  return {
    durationSeconds: count / wave.sampleRate,
    peakDbfs: amplitudeDb(peak(samples)),
    rmsDbfs: amplitudeDb(rms(samples)),
    clippedSampleRatio: clipped / count,
    silentSampleRatio: silent / count,
    highFrequencyProxyDb: amplitudeDb(count > 1 ? Math.sqrt(differenceEnergy / (count - 1)) : 0),
  };
}

export function estimateLag(a: Float32Array, b: Float32Array, maxLag: number): number {
  const limit = Math.min(Math.abs(Math.trunc(maxLag)), Math.max(1, Math.floor(Math.min(a.length, b.length) / 4)));
  // 0 - limit rather than -limit, so a zero bound reports +0 instead of -0.
  const lowest = 0 - limit;
  let coarse = 0, best = Number.NEGATIVE_INFINITY;
  for (let lag = lowest; lag <= limit; lag += LAG_COARSE_STEP) {
    const score = lagCorrelation(a, b, lag, limit, 16);
    if (score > best) { best = score; coarse = lag; }
  }
  let found = coarse;
  best = Number.NEGATIVE_INFINITY;
  for (let lag = Math.max(coarse - LAG_COARSE_STEP, lowest); lag <= Math.min(coarse + LAG_COARSE_STEP, limit); lag += 1) {
    const score = lagCorrelation(a, b, lag, limit, 2);
    if (score > best) { best = score; found = lag; }
  }
  return found;
}

export function alignedOverlap(aLength: number, bLength: number, lag: number): { aStart: number; bStart: number; overlap: number } {
  const aStart = lag >= 0 ? 0 : -lag, bStart = lag >= 0 ? lag : 0;
  return { aStart, bStart, overlap: Math.max(0, Math.min(aLength - aStart, bLength - bStart)) };
}

export function compareWaves(baseline: MonoWave, candidate: MonoWave, maxLagMs: number): WaveComparison {
  if (!Number.isFinite(maxLagMs) || maxLagMs < 0 || maxLagMs > MAX_LAG_MS) throw new Error("The maximum alignment offset must be between 0 and 1000 ms.");
  if (baseline.sampleRate !== candidate.sampleRate) throw new Error("A and B have different sample rates; capture both clips with the same backend.");
  if (baseline.samples.length < MIN_COMPARE_FRAMES || candidate.samples.length < MIN_COMPARE_FRAMES) throw new Error("A or B is too short; at least 10 ms of audio is needed.");
  const sampleRate = baseline.sampleRate;
  const lag = estimateLag(baseline.samples, candidate.samples, Math.round(maxLagMs / 1000 * sampleRate));
  const { aStart, bStart, overlap } = alignedOverlap(baseline.samples.length, candidate.samples.length, lag);
  if (overlap < Math.floor(sampleRate / 10)) throw new Error("A and B overlap by less than 100 ms after alignment.");
  const a = baseline.samples.subarray(aStart, aStart + overlap), b = candidate.samples.subarray(bStart, bStart + overlap);
  const correlation = pearson(a, b, 0, overlap, 1);
  const baselineMetrics = clipMetrics(baseline), candidateMetrics = clipMetrics(candidate);
  const loudnessDeltaDb = amplitudeDb(rms(b)) - amplitudeDb(rms(a));
  return {
    sampleRate,
    alignedLagMs: lag * 1000 / sampleRate,
    overlapSeconds: overlap / sampleRate,
    correlation,
    deltaRmsDb: amplitudeDb(rmsDifference(a, b)),
    loudnessDeltaDb,
    peakDeltaDb: amplitudeDb(peak(b)) - amplitudeDb(peak(a)),
    clippingDeltaPercent: (candidateMetrics.clippedSampleRatio - baselineMetrics.clippedSampleRatio) * 100,
    highFrequencyDeltaDb: candidateMetrics.highFrequencyProxyDb - baselineMetrics.highFrequencyProxyDb,
    similarityPercent: Math.min(100, Math.max(0, (correlation + 1) * 50)),
    classification: classify(correlation, loudnessDeltaDb),
    baseline: baselineMetrics,
    candidate: candidateMetrics,
  };
}

function classify(correlation: number, loudnessDeltaDb: number): ComparisonClass {
  if (correlation >= 0.999 && Math.abs(loudnessDeltaDb) < 0.1) return "near-identical";
  if (correlation >= 0.98) return "subtle-change";
  if (correlation >= 0.8) return "material-change";
  return "large-change-or-misalignment";
}

function lagCorrelation(a: Float32Array, b: Float32Array, lag: number, margin: number, step: number): number {
  const end = Math.min(a.length, b.length) - margin;
  if (end <= margin + 16) return Number.NEGATIVE_INFINITY;
  return pearson(a, b, margin, margin + Math.min(end - margin, LAG_WINDOW_FRAMES), step, lag);
}

function pearson(a: Float32Array, b: Float32Array, from: number, to: number, step: number, lag = 0): number {
  let sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0, count = 0;
  for (let index = from; index < to; index += step) {
    const left = a[index], right = b[index + lag];
    sumA += left; sumB += right; sumAA += left * left; sumBB += right * right; sumAB += left * right; count += 1;
  }
  if (count === 0) return 0;
  const numerator = sumAB - sumA * sumB / count;
  const denominator = Math.sqrt(Math.max(0, sumAA - sumA * sumA / count) * Math.max(0, sumBB - sumB * sumB / count));
  return denominator <= 1e-12 ? 0 : Math.min(1, Math.max(-1, numerator / denominator));
}

function peak(samples: Float32Array): number { let value = 0; for (const sample of samples) value = Math.max(value, Math.abs(sample)); return value; }
function rms(samples: Float32Array): number { if (!samples.length) return 0; let sum = 0; for (const sample of samples) sum += sample * sample; return Math.sqrt(sum / samples.length); }
function rmsDifference(a: Float32Array, b: Float32Array): number { let sum = 0; for (let index = 0; index < a.length; index += 1) { const difference = a[index] - b[index]; sum += difference * difference; } return Math.sqrt(sum / Math.max(1, a.length)); }
