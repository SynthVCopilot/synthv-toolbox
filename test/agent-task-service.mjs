import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const sourcePath = new URL("../src/PiDesktop.Tauri/electron/services/agent-task-service.ts", import.meta.url);
const source = stripTypeScriptTypes(await readFile(sourcePath, "utf8"), { mode: "transform" });
const { createAgentTaskService } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const directory = await mkdtemp(join(tmpdir(), "agent-task-service-"));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  const startAt = Date.now();
  const task = await service.invoke({ action: "start", input: "Do work" });
  assert.ok(Date.now() - startAt < 100);
  assert.equal(task.status, "running");
  await assert.rejects(() => service.invoke({ action: "start", input: "ignored", permission: "advanced" }), /unsupported field/);
  await assert.rejects(() => service.invoke({ action: "delete" }), /action is invalid/);
  progress.runId = task.runId;
  await started.promise;
  service.recordProgress(progress);
  assert.equal(service.sessionProgress("conv-1"), progress);
  const current = await service.invoke({ action: "status", taskId: task.taskId });
  assert.deepEqual(current.progress, progress);
  await assert.rejects(() => service.invoke({ action: "continue", conversationId: "conv-1", input: "again" }), /already running/);
  gate.resolve([{ role: "assistant", content: "Need a file path", outcome: { status: "needs_input", summary: "Need a file path", missing: ["file path"], evidence: [], plan: null, budget: {} } }]);
  await tick();
  assert.equal((await service.invoke({ action: "status", taskId: task.taskId })).status, "needs_input");
  assert.deepEqual((await service.invoke({ action: "status", taskId: task.taskId })).missing, ["file path"]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const continuedGate = deferred();
  const continuedStarted = deferred();
  const continuing = createAgentTaskService({ dataRoot: directory, ai: () => ({ ...ai, async send_message() { continuedStarted.resolve(); return continuedGate.promise; } }), effort: () => "mid", id: (() => { let n = 0; return () => `continue-${++n}`; })() });
  const continued = await continuing.invoke({ action: "continue", taskId: task.taskId, conversationId: "conv-1", input: "The file is song.svp" });
  assert.equal(continued.taskId, task.taskId);
  assert.notEqual(continued.runId, task.runId);
  await continuedStarted.promise;
  continuedGate.resolve([{ role: "assistant", content: "Done", outcome: { status: "completed", summary: "Done", missing: [], evidence: [], plan: null, budget: {} } }]);
  await tick();
  assert.equal((await continuing.invoke({ action: "status", taskId: task.taskId })).status, "completed");

  const failing = createAgentTaskService({ dataRoot: directory, ai: () => ({ ...ai, async send_message() { throw new Error("tool failure"); } }), effort: () => "mid", id: () => "fail-id" });
  const failed = await failing.invoke({ action: "start", input: "Fail" });
  await tick();
  assert.equal((await failing.invoke({ action: "status", taskId: failed.taskId })).status, "failed");
  const unknownService = createAgentTaskService({ dataRoot: join(directory, "unknown"), ai: () => ({ ...ai, async new_conversation() { return { id: "conv-unknown" }; }, async send_message() { return [{ role: "assistant", content: "No structured outcome" }]; } }), effort: () => "mid", id: (() => { let n = 0; return () => `unknown-${++n}`; })() });
  const unknown = await unknownService.invoke({ action: "start", input: "Unclear completion" });
  await tick();
  assert.equal((await unknownService.invoke({ action: "status", taskId: unknown.taskId })).status, "unknown");

  const cancelGate = deferred();
  const cancelStarted = deferred();
  let cancelCount = 0;
  const cancelling = createAgentTaskService({ dataRoot: join(directory, "cancel"), ai: () => ({ ...ai, async send_message() { cancelStarted.resolve(); return cancelGate.promise; }, async cancel_agent_run() { cancelCount++; } }), effort: () => "low", id: (() => { let n = 0; return () => `cancel-${++n}`; })() });
  const pending = await cancelling.invoke({ action: "start", input: "Slow" });
  await cancelStarted.promise;
  const cancellingSnapshot = await cancelling.invoke({ action: "cancel", taskId: pending.taskId });
  assert.equal(cancellingSnapshot.status, "cancelling");
  assert.equal(cancelCount, 1);
  cancelGate.resolve([{ role: "assistant", content: "Cancelled", outcome: { status: "cancelled", summary: "Cancelled", missing: [], evidence: [], plan: null, budget: {} } }]);
  await tick();
  assert.equal((await cancelling.invoke({ action: "status", taskId: pending.taskId })).status, "cancelled");

  const beforeRestart = await readFile(join(directory, "cancel", "agent-tasks.json"), "utf8");
  const restart = createAgentTaskService({ dataRoot: join(directory, "cancel"), ai: () => { throw new Error("must not replay"); }, effort: () => "mid" });
  await restart.dispose();
  assert.equal(JSON.parse(await readFile(join(directory, "cancel", "agent-tasks.json"), "utf8"))[0].status, "cancelled");
  assert.equal(sendCount, 1);
  assert.ok(beforeRestart.length > 0);

  const interruptedRoot = join(directory, "interrupted");
  const interruptedStarted = deferred();
  let replayCount = 0;
  const interruptedService = createAgentTaskService({ dataRoot: interruptedRoot, ai: () => ({ ...ai, async send_message() { replayCount++; interruptedStarted.resolve(); return new Promise(() => {}); } }), effort: () => "mid", id: () => "interrupted-id" });
  const active = await interruptedService.invoke({ action: "start", input: "Do not replay" });
  await interruptedStarted.promise;
  const recoveredService = createAgentTaskService({ dataRoot: interruptedRoot, ai: () => { throw new Error("must not replay"); }, effort: () => "mid" });
  await recoveredService.dispose();
  assert.equal((await recoveredService.invoke({ action: "status", taskId: active.taskId })).status, "interrupted");
  assert.equal(replayCount, 1);
  await assert.rejects(() => service.invoke({ action: "status", taskId: "missing" }), /not found/);
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log("Agent task snapshots remain queryable across progress, completion, failure, cancellation, and restart.");
