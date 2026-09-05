import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopRoot = join(repositoryRoot, "src", "PiDesktop.Tauri");
const mainPath = join(desktopRoot, "src", "main.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function collectAudioImplementation(source) {
  const wantedVariables = new Set([
    "audioProbe", "audioPrepareForm", "audioNormalizeForm", "pendingAudioPlan", "audioJob",
    "audioJobPollTimer", "audioJobPollGeneration", "audioInputGeneration", "audioPlanRequestGeneration",
    "audioPlanRequestInFlight", "audioStartInFlight", "audioLoudnessAnalysisInFlight",
    "audioLoudnessAnalysisGeneration", "audioUiError", "audioUiNotice", "audioPreviewUrl",
    "audioSourcePreviewUrl",
  ]);
  const wantedFunctions = new Set([
    "formatError", "isTerminalAudioJob", "mergeAudioJobSnapshot", "clearAudioJobPoll",
    "scheduleAudioJobPoll", "requestAudioPlan", "startPlannedAudioJob", "selectAudioPreparationInput",
  ]);
  assert.doesNotMatch(source, /^(?:<<<<<<<|=======|>>>>>>>)/m, "main.ts must be conflict-free before behavior tests run");

  // This is deliberately a small structural lexer, not a regexp source test:
  // it follows nested braces while skipping strings and comments, then Node
  // strips TypeScript before the extracted code is evaluated in a VM.
  const skipQuoted = (offset, quote) => {
    for (let index = offset + 1; index < source.length; index += 1) {
      if (source[index] === "\\") { index += 1; continue; }
      if (source[index] === quote) return index + 1;
    }
    throw new Error("unterminated string while extracting audio behavior");
  };
  const endOfStatement = (offset) => {
    let depth = 0;
    for (let index = offset; index < source.length; index += 1) {
      const character = source[index];
      if (character === "'" || character === '"' || character === "`") { index = skipQuoted(index, character) - 1; continue; }
      if (character === "/" && source[index + 1] === "/") { index = source.indexOf("\n", index + 2); if (index < 0) return source.length; continue; }
      if (character === "/" && source[index + 1] === "*") { index = source.indexOf("*/", index + 2); if (index < 0) throw new Error("unterminated comment"); index += 1; continue; }
      if (character === "{" || character === "(" || character === "[") depth += 1;
      if (character === "}" || character === ")" || character === "]") depth -= 1;
      if (character === ";" && depth === 0) return index + 1;
    }
    throw new Error("unterminated audio state statement");
  };
  const endOfBlock = (openBrace) => {
    let depth = 0;
    for (let index = openBrace; index < source.length; index += 1) {
      const character = source[index];
      if (character === "'" || character === '"' || character === "`") { index = skipQuoted(index, character) - 1; continue; }
      if (character === "/" && source[index + 1] === "/") { index = source.indexOf("\n", index + 2); if (index < 0) break; continue; }
      if (character === "/" && source[index + 1] === "*") { index = source.indexOf("*/", index + 2); if (index < 0) throw new Error("unterminated comment"); index += 1; continue; }
      if (character === "{") depth += 1;
      if (character === "}" && --depth === 0) return index + 1;
    }
    throw new Error("unterminated audio function");
  };
  const statement = (name) => {
    const start = source.indexOf(`let ${name}`);
    assert.notEqual(start, -1, `missing audio state ${name}`);
    return source.slice(start, endOfStatement(start));
  };
  const functionBody = (name) => {
    const start = source.indexOf(`function ${name}`);
    assert.notEqual(start, -1, `missing audio function ${name}`);
    const openBrace = source.indexOf("{", start);
    return source.slice(start, endOfBlock(openBrace));
  };
  return {
    variables: [...wantedVariables].map(statement).join("\n"),
    functions: [...wantedFunctions].map(functionBody).join("\n"),
  };
}

function createHarness(audioApi) {
  const source = readFileSync(mainPath, "utf8");
  const extracted = collectAudioImplementation(source);
  const harnessSource = `// @ts-nocheck
module.exports = (function (__audioApi, __window) {
  const audioApi = __audioApi;
  const window = __window;
  const page = "toolbox";
  const activeWorkflow = "audio-preparation";
  const render = () => {};
  ${extracted.variables}
  ${extracted.functions}
  return {
    isTerminalAudioJob, mergeAudioJobSnapshot, scheduleAudioJobPoll, requestAudioPlan, startPlannedAudioJob, selectAudioPreparationInput,
    state: () => ({ audioProbe, audioPrepareForm, audioNormalizeForm, pendingAudioPlan, audioJob,
      audioJobPollTimer, audioJobPollGeneration, audioInputGeneration, audioPlanRequestGeneration,
      audioPlanRequestInFlight, audioStartInFlight, audioLoudnessAnalysisInFlight, audioUiError, audioUiNotice }),
    setForms: (prepare, normalize = prepare) => { audioPrepareForm = prepare; audioNormalizeForm = normalize; },
    setAudioJob: (value) => { audioJob = value; },
    setLoudnessAnalysisInFlight: (value) => { audioLoudnessAnalysisInFlight = value; },
  };
})(__audioApi, __window);`;
  const output = stripTypeScriptTypes(harnessSource, { mode: "transform", sourceUrl: "audio-behavior-harness.ts" });
  const timers = [];
  const window = {
    setTimeout(callback) { timers.push(callback); return timers.length - 1; },
    clearTimeout(timer) { timers[timer] = undefined; },
  };
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, __audioApi: audioApi, __window: window, console });
  return {
    ...module.exports,
    fireNextTimer() { const callback = timers.find(Boolean); assert.ok(callback, "expected a pending audio poll"); callback(); },
    cleanup() {},
  };
}

{
  const plans = [deferred(), deferred()];
  const calls = [];
  const harness = createHarness({
    planAudioPrepare(request) { calls.push(request); return plans[calls.length - 1].promise; },
    planLoudnessNormalize() { throw new Error("unexpected normalize plan"); },
  });
  try {
    harness.setForms({ inputPath: "C:/audio/source.flac", sampleFormat: "s24" });
    harness.requestAudioPlan("prepare");
    assert.equal(harness.state().audioPlanRequestInFlight, true);
    assert.equal(harness.state().audioUiNotice, "正在生成安全写入计划…");
    assert.equal(JSON.stringify(calls), JSON.stringify([{ inputPath: "C:/audio/source.flac", sampleFormat: "s24" }]));
    harness.setForms({ inputPath: "C:/audio/new-source.flac", sampleFormat: "f32" });
    harness.requestAudioPlan("prepare");
    plans[0].resolve({ token: "stale-token", outputPath: "C:/audio/stale.wav" });
    await settle();
    assert.equal(harness.state().audioPlanRequestInFlight, true, "an older plan response must not finish the newer request");
    assert.equal(harness.state().pendingAudioPlan, undefined, "an older token must never become confirmable");
    plans[1].resolve({ token: "one-use-token", outputPath: "C:/audio/source.wav" });
    await settle();
    assert.equal(harness.state().audioPlanRequestInFlight, false);
    assert.equal(harness.state().pendingAudioPlan.plan.token, "one-use-token");
    assert.equal(JSON.stringify(harness.state().pendingAudioPlan.request), JSON.stringify(calls[1]));
  } finally { harness.cleanup(); }
}

{
  const probes = [];
  const harness = createHarness({ probeMedia(path) { const probe = deferred(); probes.push({ path, probe }); return probe.promise; } });
  try {
    harness.setForms({ inputPath: "C:/audio/original.wav", sampleFormat: "s24" });
    harness.setLoudnessAnalysisInFlight(true);
    harness.selectAudioPreparationInput("C:/audio/rejected.wav");
    assert.equal(harness.state().audioPrepareForm.inputPath, "C:/audio/original.wav");
    assert.match(harness.state().audioUiError, /完成后才能更换输入文件/);
    assert.equal(probes.length, 0, "blocked selection must not probe another file");

    harness.setLoudnessAnalysisInFlight(false);
    harness.selectAudioPreparationInput("C:/audio/first.wav");
    harness.selectAudioPreparationInput("C:/audio/second.wav");
    probes[0].probe.resolve({ codec: "stale" });
    await settle();
    assert.equal(harness.state().audioProbe, undefined, "stale probe must not overwrite the newer selection");
    probes[1].probe.resolve({ codec: "current" });
    await settle();
    assert.equal(harness.state().audioProbe.codec, "current");
  } finally { harness.cleanup(); }
}

{
  const plan = deferred();
  const start = deferred();
  const starts = [];
  const harness = createHarness({
    planAudioPrepare() { return plan.promise; },
    startAudioPrepare(request, token) { starts.push({ request, token }); return start.promise; },
  });
  try {
    harness.setForms({ inputPath: "C:/audio/original.flac", sampleFormat: "s24" });
    harness.requestAudioPlan("prepare");
    plan.resolve({ token: "one-use-token", outputPath: "C:/audio/original.wav" });
    await settle();
    assert.equal(harness.state().pendingAudioPlan.plan.token, "one-use-token");
    harness.setForms({ inputPath: "C:/audio/changed.flac", sampleFormat: "f32" });
    harness.startPlannedAudioJob();
    harness.startPlannedAudioJob();
    assert.equal(starts.length, 1, "a consumed plan must not start a second backend job");
    assert.equal(JSON.stringify(starts[0]), JSON.stringify({
      request: { inputPath: "C:/audio/original.flac", sampleFormat: "s24" }, token: "one-use-token",
    }));
    assert.equal(harness.state().pendingAudioPlan, undefined, "the one-use plan must disappear before start resolves");
    assert.equal(harness.state().audioStartInFlight, true);
    start.resolve({ id: "job-terminal", status: "completed", operation: "prepare" });
    await settle();
    assert.equal(harness.state().audioJob.status, "completed");
    assert.equal(harness.state().audioStartInFlight, false);
    assert.equal(harness.state().audioUiNotice, "音频任务已完成。");
  } finally { harness.cleanup(); }
}

{
  const snapshot = deferred();
  const harness = createHarness({ audioJobSnapshot() { return snapshot.promise; } });
  try {
    const cancelled = { id: "job-1", status: "cancelled" };
    assert.equal(harness.mergeAudioJobSnapshot(cancelled, { id: "job-1", status: "running" }), cancelled);
    harness.setAudioJob({ id: "job-1", status: "running" });
    harness.scheduleAudioJobPoll("job-1");
    harness.fireNextTimer();
    await settle();
    harness.setAudioJob(cancelled); // cancellation wins while the poll request is in flight
    snapshot.resolve({ id: "job-1", status: "running" });
    await settle();
    assert.equal(harness.state().audioJob, cancelled, "late poll must not resurrect a terminal cancellation");
  } finally { harness.cleanup(); }
}

console.log("Audio preparation behavior tests passed.");
