import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourcePath = new URL("../src/PiDesktop.Tauri/electron/services/agent-task-service.ts", import.meta.url);
const source = stripTypeScriptTypes(await readFile(sourcePath, "utf8"), { mode: "transform" });
const { createAgentTaskService: createService } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const services = [];
function createAgentTaskService(options) { const service = createService(options); services.push(service); return service; }
const directory = await mkdtemp(join(tmpdir(), "agent-task-service-"));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
// File polls pause between reads: on Windows an open reader makes the service's atomic rename fail, and a tight read loop would starve it.
const filePause = () => new Promise((resolve) => setTimeout(resolve, 5));
async function waitForStatus(service, taskId, expected) {
  for (let index = 0; index < 1000; index++) {
    const snapshot = await service.invoke({ action: "status", taskId });
    if (snapshot.status === expected) return snapshot;
    await turn();
  }
  throw new Error(`Timed out waiting for task ${taskId} to become ${expected}.`);
}
async function waitForFileStatus(path, taskId, expected) {
  for (let index = 0; index < 1000; index++) {
    const tasks = JSON.parse(await readFile(path, "utf8"));
    const task = tasks.find((item) => item.taskId === taskId);
    if (task?.status === expected) return task;
    await filePause();
  }
  throw new Error(`Timed out waiting for persisted task ${taskId} to become ${expected}.`);
}
async function waitForFileTasks(path, predicate) {
  for (let index = 0; index < 1000; index++) {
    const tasks = JSON.parse(await readFile(path, "utf8"));
    if (predicate(tasks)) return tasks;
    await filePause();
  }
  throw new Error("Timed out waiting for persisted task list state.");
}
async function waitForTasks(service, predicate) {
  for (let index = 0; index < 1000; index++) {
    const listed = await service.invoke({ action: "list" });
    assert.deepEqual(Object.keys(listed), ["tasks"], "list returns an object so MCP structuredContent stays an object");
    const { tasks } = listed;
    if (predicate(tasks)) return tasks;
    await turn();
  }
  throw new Error("Timed out waiting for task list state.");
}

try {
  const gate = deferred();
  const started = deferred();
  const progress = { sessionId: "conv-1", runId: "run-1", seq: 3, phase: "running_tools", round: 1, text: "Working", plan: { goal: "Complete task", criteria: [], todos: [] }, tools: [{ id: "tool-1", name: "read", status: "running", round: 1, summary: "Reading" }], toolCount: 1, budget: {}, retry: null, pendingInput: null };
  let sendCount = 0;
  const ai = {
    async new_conversation() { return { id: "conv-1" }; },
    async open_conversation(id) { return { id }; },
    async send_message() { sendCount++; started.resolve(); return gate.promise; },
    async cancel_agent_run() {},
  };
  const service = createAgentTaskService({ dataRoot: directory, ai: () => ai, effort: () => "mid", id: (() => { let n = 0; return () => `id-${++n}`; })() });
  const startPromise = service.invoke({ action: "start", input: "Do work" });
  let startTimeout;
  const task = await Promise.race([startPromise, new Promise((_, reject) => { startTimeout = setTimeout(() => reject(new Error("start waited for the agent response")), 1000); })]);
  clearTimeout(startTimeout);
  assert.equal(task.status, "running");
  // Validation failures are client-safe so the MCP server returns them to the model as isError tool results.
  await assert.rejects(() => service.invoke({ action: "start", input: "ignored", permission: "advanced" }), (error) => error.clientSafe === true && /unsupported field for start: permission\. It accepts action, input\./.test(error.message));
  await assert.rejects(() => service.invoke({ action: "list", input: "" }), (error) => error.clientSafe === true && /unsupported field for list: input/.test(error.message));
  await assert.rejects(() => service.invoke({ action: "delete" }), (error) => error.clientSafe === true && /action is invalid/.test(error.message));
  await assert.rejects(() => service.invoke({ action: "status" }), (error) => error.clientSafe === true && /taskId or conversationId is required/.test(error.message));
  await assert.rejects(() => service.invoke({ action: "continue", input: "x" }), (error) => error.clientSafe === true && /Continue requires input and conversationId/.test(error.message));
  progress.runId = task.runId;
  await started.promise;
  service.recordProgress(progress);
  assert.equal(service.sessionProgress("conv-1"), progress);
  const current = await service.invoke({ action: "status", taskId: task.taskId });
  assert.deepEqual(current.progress, progress);
  await assert.rejects(() => service.invoke({ action: "continue", conversationId: "conv-1", input: "again" }), /already running/);
  gate.resolve([{ role: "assistant", content: "Need a file path", outcome: { status: "needs_input", summary: "Need a file path", missing: ["file path"], evidence: [], plan: null, budget: {} } }]);
  assert.deepEqual((await waitForStatus(service, task.taskId, "needs_input")).missing, ["file path"]);
  await waitForFileStatus(join(directory, "agent-tasks.json"), task.taskId, "needs_input");
  const continuedGate = deferred();
  const continuedStarted = deferred();
  ai.send_message = async () => { continuedStarted.resolve(); return continuedGate.promise; };
  const continued = await service.invoke({ action: "continue", taskId: task.taskId, conversationId: "conv-1", input: "The file is song.svp" });
  assert.equal(continued.taskId, task.taskId);
  assert.notEqual(continued.runId, task.runId);
  await continuedStarted.promise;
  continuedGate.resolve([{ role: "assistant", content: "Done", outcome: { status: "completed", summary: "Done", missing: [], evidence: [], plan: null, budget: {} } }]);
  await waitForStatus(service, task.taskId, "completed");
  await waitForFileStatus(join(directory, "agent-tasks.json"), task.taskId, "completed");

  const failing = createAgentTaskService({ dataRoot: directory, ai: () => ({ ...ai, async send_message() { throw new Error("tool failure"); } }), effort: () => "mid", id: () => "fail-id" });
  const failed = await failing.invoke({ action: "start", input: "Fail" });
  await waitForStatus(failing, failed.taskId, "failed");
  await waitForFileStatus(join(directory, "agent-tasks.json"), failed.taskId, "failed");
  const unknownService = createAgentTaskService({ dataRoot: join(directory, "unknown"), ai: () => ({ ...ai, async new_conversation() { return { id: "conv-unknown" }; }, async send_message() { return [{ role: "assistant", content: "No structured outcome" }]; } }), effort: () => "mid", id: (() => { let n = 0; return () => `unknown-${++n}`; })() });
  const unknown = await unknownService.invoke({ action: "start", input: "Unclear completion" });
  await waitForStatus(unknownService, unknown.taskId, "unknown");
  await waitForFileStatus(join(directory, "unknown", "agent-tasks.json"), unknown.taskId, "unknown");

  const cancelGate = deferred();
  const cancelStarted = deferred();
  let cancelCount = 0;
  const cancelling = createAgentTaskService({ dataRoot: join(directory, "cancel"), ai: () => ({ ...ai, async send_message() { cancelStarted.resolve(); return cancelGate.promise; }, async cancel_agent_run() { cancelCount++; } }), cancelChildren: async () => { throw new Error("Cover task could not be cancelled."); }, effort: () => "low", id: (() => { let n = 0; return () => `cancel-${++n}`; })() });
  const pending = await cancelling.invoke({ action: "start", input: "Slow" });
  await cancelStarted.promise;
  const cancellingSnapshot = await cancelling.invoke({ action: "cancel", taskId: pending.taskId });
  assert.equal(cancellingSnapshot.status, "cancelling");
  assert.deepEqual(cancellingSnapshot.cancellationErrors, ["Cover task could not be cancelled."]);
  assert.equal(cancelCount, 1);
  cancelGate.resolve([{ role: "assistant", content: "Cancelled", outcome: { status: "cancelled", summary: "Cancelled", missing: [], evidence: [], plan: null, budget: {} } }]);
  await waitForStatus(cancelling, pending.taskId, "cancelled");

  const persistedPath = join(directory, "cancel", "agent-tasks.json");
  await waitForFileStatus(persistedPath, pending.taskId, "cancelled");
  const beforeRestart = await readFile(persistedPath, "utf8");
  const restart = createAgentTaskService({ dataRoot: join(directory, "cancel"), ai: () => { throw new Error("must not replay"); }, effort: () => "mid" });
  await restart.dispose();
  assert.equal(JSON.parse(await readFile(persistedPath, "utf8"))[0].status, "cancelled");
  assert.equal(sendCount, 1);
  assert.ok(beforeRestart.length > 0);

  const interruptedRoot = join(directory, "interrupted");
  const interruptedStarted = deferred();
  let replayCount = 0;
  const interruptedService = createAgentTaskService({ dataRoot: interruptedRoot, ai: () => ({ ...ai, async send_message() { replayCount++; interruptedStarted.resolve(); return new Promise(() => {}); } }), effort: () => "mid", id: () => "interrupted-id" });
  const active = await interruptedService.invoke({ action: "start", input: "Do not replay" });
  await interruptedStarted.promise;
  const recoveredService = createAgentTaskService({ dataRoot: interruptedRoot, ai: () => ({ async new_conversation() { throw new Error("continue must reuse conversation"); }, async open_conversation(id) { return { id }; }, async send_message() { replayCount++; return [{ role: "assistant", content: "Continued", outcome: { status: "completed", summary: "Continued", missing: [], evidence: [], plan: null, budget: {} } }]; }, async cancel_agent_run() {} }), effort: () => "mid" });
  await recoveredService.dispose();
  assert.equal((await recoveredService.invoke({ action: "status", taskId: active.taskId })).status, "interrupted");
  assert.equal(replayCount, 1);
  await recoveredService.invoke({ action: "continue", taskId: active.taskId, conversationId: active.conversationId, input: "Continue explicitly" });
  await waitForStatus(recoveredService, active.taskId, "completed");
  await waitForFileStatus(join(interruptedRoot, "agent-tasks.json"), active.taskId, "completed");
  assert.equal(replayCount, 2);

  let startupSends = 0;
  let startupCancelCalls = 0;
  const startupRoot = join(directory, "startup-cancel");
  const startupService = createAgentTaskService({ dataRoot: startupRoot, ai: () => ({ async new_conversation() { return { id: "startup-conversation" }; }, async open_conversation(id) { return { id }; }, async send_message() { startupSends++; return []; }, async cancel_agent_run() { startupCancelCalls++; } }), cancelChildren: async () => {}, effort: () => "low" });
  await startupService.dispose();
  const startupResult = await startupService.invoke({ action: "start", input: "Cancel during startup" });
  await startupService.invoke({ action: "cancel", taskId: startupResult.taskId });
  await waitForStatus(startupService, startupResult.taskId, "cancelled");
  await waitForFileStatus(join(startupRoot, "agent-tasks.json"), startupResult.taskId, "cancelled");
  assert.equal(startupSends, 0);
  assert.equal(startupCancelCalls, 1);

  const trimRoot = join(directory, "trim");
  const trimGate = deferred();
  const trimStarted = deferred();
  let conversationNumber = 0;
  const trimService = createAgentTaskService({ dataRoot: trimRoot, ai: () => ({ async new_conversation() { return { id: `trim-${++conversationNumber}` }; }, async open_conversation(id) { return { id }; }, async send_message(conversationId) {
    if (conversationId === "trim-1") { trimStarted.resolve(); return trimGate.promise; }
    return [{ role: "assistant", content: "Done", outcome: { status: "completed", summary: "Done", missing: [], evidence: [], plan: null, budget: {} } }];
  }, async cancel_agent_run() {} }), effort: () => "low" });
  const oldestActive = await trimService.invoke({ action: "start", input: "Keep this active task" });
  await trimStarted.promise;
  await Promise.all(Array.from({ length: 103 }, (_, index) => trimService.invoke({ action: "start", input: `Complete ${index}` })));
  const retained = await waitForTasks(trimService, (items) => items.length === 100 && items.some((item) => item.taskId === oldestActive.taskId) && items.filter((item) => item.taskId !== oldestActive.taskId).every((item) => item.status === "completed"));
  assert.equal(retained.length, 100);
  const retainedFile = await waitForFileTasks(join(trimRoot, "agent-tasks.json"), (items) => items.length === 100 && items.some((item) => item.taskId === oldestActive.taskId && item.status === "running") && items.filter((item) => item.taskId !== oldestActive.taskId).every((item) => item.status === "completed"));
  assert.equal(retainedFile.length, 100);
  assert.ok(retainedFile.some((item) => item.taskId === oldestActive.taskId && item.status === "running"));
  for (let index = 0; index < 120; index++) trimService.recordProgress({ ...progress, sessionId: `progress-${index}` });
  assert.equal(trimService.sessionProgress("progress-0"), undefined);
  assert.equal(trimService.sessionProgress("progress-119").sessionId, "progress-119");
  await trimService.dispose();
  await assert.rejects(() => service.invoke({ action: "status", taskId: "missing" }), /not found/);
} finally {
  await Promise.all(services.map(service => service.dispose()));
  await rm(directory, { recursive: true, force: true });
}

console.log("Agent task snapshots remain queryable across progress, completion, failure, cancellation, and restart.");

test("provider errors retain their summary, plan and usage across task restart", async (t) => {
  const taskRoot = await mkdtemp(join(tmpdir(), "agent-task-error-"));
  t.after(() => rm(taskRoot, { recursive: true, force: true }));
  const outcome = { status: "error", summary: "Provider overloaded", missing: [], evidence: [], plan: { goal: "Review the song", doneCriteria: ["Review complete"], todos: [{ id: "review", title: "Review", status: "in_progress" }] }, budget: { level: "mid", maxTurns: 5, maxTokens: 1000, turns: 2, tokens: 500, uncachedInputTokens: 400, cacheReadTokens: 300 } };
  const service = createService({ dataRoot: taskRoot, ai: () => ({ async new_conversation() { return { id: "conv-error" }; }, async send_message() { return [{ role: "assistant", content: "", outcome }]; } }), effort: () => "mid" });
  t.after(() => service.dispose());
  const task = await service.invoke({ action: "start", input: "Run" });
  const result = await waitForStatus(service, task.taskId, "error");
  assert.equal(result.error, "Provider overloaded");
  assert.deepEqual(result.outcome.plan, outcome.plan);
  assert.deepEqual(result.outcome.budget, outcome.budget);
  await waitForFileStatus(join(taskRoot, "agent-tasks.json"), task.taskId, "error");
  const reopened = createService({ dataRoot: taskRoot, ai: () => { throw new Error("must not replay"); }, effort: () => "mid" });
  t.after(() => reopened.dispose());
  const persisted = await reopened.invoke({ action: "status", taskId: task.taskId });
  assert.equal(persisted.error, "Provider overloaded");
  assert.deepEqual(persisted.outcome, outcome);
});
