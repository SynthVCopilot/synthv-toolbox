import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const webRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src");
const read = (path) => readFileSync(path, "utf8");
const api = read(join(webRoot, "api.ts"));
const types = read(join(webRoot, "types.ts"));
const catalog = read(join(webRoot, "featureCatalog.ts"));
const main = read(join(webRoot, "main.ts"));
const packageJson = JSON.parse(read(join(repositoryRoot, "src", "PiDesktop.Tauri", "package.json")));
const packageLock = JSON.parse(read(join(repositoryRoot, "src", "PiDesktop.Tauri", "package-lock.json")));

const coreCommands = [
  ["ffmpegStatus", "ffmpeg_status"],
  ["probeMedia", "probe_media"],
  ["planAudioPrepare", "plan_audio_prepare"],
  ["startAudioPrepare", "start_audio_prepare"],
  ["analyzeLoudness", "analyze_loudness"],
  ["planLoudnessNormalize", "plan_loudness_normalize"],
  ["startLoudnessNormalize", "start_loudness_normalize"],
  ["audioJobSnapshot", "audio_job_snapshot"],
  ["cancelAudioJob", "cancel_audio_job"],
];
for (const [wrapper, command] of coreCommands) {
  assert.match(api, new RegExp(`${wrapper}\\s*:[\\s\\S]{0,240}call<[^>]+>\\("${command}"`), `${wrapper} must bind ${command}`);
}

assert.match(types, /export interface FfmpegRuntimeStatus/);
assert.match(types, /export interface MediaProbe/);
assert.match(types, /sourceArtifactId\?: string/);
assert.match(types, /sourceMimeType\?: string/);
assert.match(types, /export interface AudioPrepareRequest/);
assert.match(types, /export interface LoudnessNormalizeRequest/);
assert.match(types, /export interface AudioWritePlan/);
assert.match(types, /export interface AudioJobSnapshot/);
assert.match(types, /export interface LoudnessReport/);
assert.match(types, /export interface AudioArtifactInfo/);
assert.match(types, /mediaUrl: string/);
assert.match(types, /mimeType\?: string/);
assert.match(types, /export interface AudioArtifactSaveResult/);

for (const [wrapper, command] of [
  ["audioArtifactInfo", "audio_artifact_info"],
  ["revealAudioArtifact", "reveal_audio_artifact"],
  ["saveAudioArtifactAs", "save_audio_artifact"],
]) {
  assert.match(api, new RegExp(`${wrapper}\\s*:[\\s\\S]{0,260}call<[^>]+>\\("${command}"`), `${wrapper} must bind ${command}`);
}
// Saving is intentionally mediated by the native dialog.  No destination or
// arbitrary source path may be sent from the webview for artifact actions.
assert.match(api, /saveAudioArtifactAs:\s*\(artifactId:\s*string\)\s*=>/);
assert.doesNotMatch(api, /saveAudioArtifactAs\s*:\s*\([^)]*(?:path|destination)/i);
assert.doesNotMatch(api, /copyAudioArtifactPath/);

assert.equal(packageJson.dependencies["@tauri-apps/plugin-dialog"], "2.7.2", "dialog plugin must stay pinned to the Rust-compatible version");
assert.equal(packageLock.packages["node_modules/@tauri-apps/plugin-dialog"]?.version, "2.7.2", "lockfile must preserve the pinned dialog plugin");
assert.match(packageJson.scripts["test:contracts"], /audio-preparation-ui\.mjs/, "CI contract suite must execute this guard");
assert.match(api, /from\s+["']@tauri-apps\/plugin-dialog["']/);
assert.match(api, /pickAudioFile:\s*async\s*\(\):\s*Promise<string \| undefined>/);
assert.match(api, /open\(\{[\s\S]*?multiple:\s*false[\s\S]*?directory:\s*false[\s\S]*?filters:/);
assert.match(api, /Array\.isArray\(selected\)/);
assert.match(api, /typeof selected === ["']string["']/);

assert.match(catalog, /id:\s*"audio-preparation"/);
assert.match(catalog, /id:\s*"import"[\s\S]*?featureIds:\s*\[[^\]]*audio-preparation/);
assert.match(catalog, /id:\s*"audio-preparation"[\s\S]*?componentIds:\s*\["ffmpeg"\]/);

// The UI keeps a plan and its exact request until the user confirms; only the
// plan token then starts the matching job.  The token is never persisted.
assert.match(main, /pendingAudioPlan/);
assert.match(main, /planAudioPrepare/);
assert.match(main, /planLoudnessNormalize/);
assert.match(main, /startAudioPrepare\([^,]+,\s*[^)]*\.token\)/);
assert.match(main, /startLoudnessNormalize\([^,]+,\s*[^)]*\.token\)/);
assert.match(main, /audioJobSnapshot/);
assert.match(main, /cancelAudioJob/);
assert.match(main, /audioPlanRequestGeneration/);
assert.match(main, /audioPlanRequestInFlight/);
assert.match(main, /pendingAudioPlan = undefined;[\s\S]{0,320}audioPrepareForm =/);
assert.doesNotMatch(main, /localStorage\.[\s\S]{0,120}(?:audio|ffmpeg)[\s\S]{0,120}token/i);
assert.doesNotMatch(main, /sessionStorage\.[\s\S]{0,120}(?:audio|ffmpeg)[\s\S]{0,120}token/i);

// Single-file drag/drop and opaque artifact actions are part of the public UI
// contract.  Keep these checks semantic rather than depending on CSS wording.
assert.match(main, /onDragDropEvent\s*\(/);
assert.match(main, /paths\.length\s*!==\s*1/);
assert.match(main, /selectAudioPreparationInput\(paths\[0\]\)/);
assert.match(main, /artifactId/);
assert.match(main, /data-(?:preview|reveal|save)-audio-artifact/);
assert.match(main, /audioProbe\?\.sourceArtifactId === artifactId/);
assert.match(main, /audioJob\?\.artifactId === artifactId/);
assert.match(main, /probe\.sourceArtifactId && probe\.sourceMimeType/);
assert.match(main, /data-audio-preview-artifact="\$\{escapeHtml\(probe\.sourceArtifactId\)\}"/);
assert.match(main, /data-audio-preview-artifact="\$\{escapeHtml\(audioJob\.artifactId\)\}"/);
assert.match(main, /data-audio-preview-kind="source"/);
assert.match(main, /data-audio-preview-kind="result"/);
assert.match(main, /document\.addEventListener\("error",[\s\S]{0,1800}HTMLMediaElement/);
assert.match(main, /target\.closest\("\.audio-preparation"\)/);
assert.match(main, /generation !== audioInputGeneration/);
assert.match(main, /audioSourcePreviewUrl = ""/);
assert.match(main, /audioPreviewUrl = ""/);
assert.match(main, /HTMLMediaElement[\s\S]{0,1800}\}, true\);/);
assert.match(main, /当前 WebView 无法分段读取、文件过大或格式不支持；处理不受影响；结果可打开位置\/另存为/);
assert.match(main, /audioArtifactActionInFlight/);
assert.match(main, /function beginAudioArtifactAction[\s\S]{0,220}audioUiError = ""/);
assert.match(main, /audioCancelInFlight/);
assert.match(main, /audioLoudnessAnalysisInFlight/);
assert.match(main, /audioLoudnessAnalysisGeneration/);
assert.match(main, /if \(!inputPath \|\| audioLoudnessAnalysisInFlight\) return/);
assert.match(main, /controlsLocked = [^;]*audioLoudnessAnalysisInFlight/);
assert.match(main, /analysisGeneration !== audioLoudnessAnalysisGeneration/);
assert.match(main, /if \(audioLoudnessAnalysisInFlight\) \{[\s\S]{0,220}更换输入文件/);
assert.match(main, /function mergeAudioJobSnapshot[\s\S]{0,420}isTerminalAudioJob\(current\)/);
assert.ok(
  (main.match(/mergeAudioJobSnapshot\(audioJob,\s*snapshot\)/g) ?? []).length >= 2,
  "poll and cancel responses must both preserve an already observed terminal state",
);
assert.match(main, /cancelAudioJob\(jobId\)[\s\S]{0,520}scheduleAudioJobPoll\(jobId\)/);
assert.doesNotMatch(main, /copyAudioArtifactPath/);
assert.doesNotMatch(main, /pendingAudioPlan\?\.plan\.outputPath/);

// Keep the HTML constraints aligned with the backend validators so values
// accepted by the browser do not fail only after the confirmation request.
assert.match(main, /id="audio-prep-rate"[^>]*min="8000"[^>]*max="192000"/);
assert.match(main, /id="audio-normalize-lufs"[^>]*min="-70"[^>]*max="-5"/);
assert.match(main, /id="audio-normalize-peak"[^>]*min="-9"[^>]*max="0"/);

const audioSection = main.match(/if \(id === "audio-preparation"\) \{([\s\S]*?)\} else if \(id === "audio-insight"/i)?.[1] ?? "";
assert.match(audioSection, /不会自动导入 SynthV/);
assert.doesNotMatch(audioSection, /runAudioToProject|runBatchWorkflow|runScoreToSynthv|runProjectReference/i);

console.log("Audio preparation UI contracts passed.");
