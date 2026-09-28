import assert from "node:assert/strict";
import test from "node:test";
import { AgentApprovalBroker } from "../src/PiDesktop.Tauri/dist/electron/services/agent-approvals.js";
import { ElectronCommandRegistry } from "../src/PiDesktop.Tauri/dist/electron/services/command-registry.js";

const noopDeliver = () => {};

function item(overrides = {}) {
  return {
    conversationId: "conv-1",
    runId: "run-1",
    toolCallId: "call-1",
    tool: "sv_command",
    action: "edit_notes",
    category: "projectWrite",
    preview: JSON.stringify({ action: "edit_notes", params: { groupId: "g1" } }),
    params: { groupId: "g1" },
    ...overrides,
  };
}

test("submit emits the pending snapshot once, and decide(approve) executes and resolves as executed", async () => {
  const emissions = [];
  const executed = [];
  const broker = new AgentApprovalBroker(
    (snapshot) => emissions.push(snapshot),
    { execute: async (submittedItem) => { executed.push(submittedItem); return { text: "ok", isError: false }; }, deliver: noopDeliver },
  );
  const approval = broker.submit(item());
  assert.equal(emissions.length, 1);
  assert.equal(emissions[0].pending.length, 1);
  assert.equal(emissions[0].pending[0].id, approval.id);
  assert.equal(approval.risk, "high");
  assert.deepEqual(broker.list().map((a) => a.id), [approval.id]);

  const waitPromise = broker.wait(approval.id, "conv-1");
  broker.decide(approval.id, true);
  assert.equal(emissions.length, 2, "decide emits the pending snapshot exactly once more, immediately, before execute() resolves");
  assert.deepEqual(emissions[1].pending, [], "the approval is removed from the pending list as soon as it is decided");

  const resolution = await waitPromise;
  assert.equal(resolution.outcome, "executed");
  assert.equal(resolution.ok, true);
  assert.equal(resolution.summary, "ok");
  assert.equal(resolution.runId, "run-1");
  assert.equal(executed.length, 1);
  assert.equal(executed[0].action, "edit_notes");
  assert.deepEqual(executed[0].params, { groupId: "g1" });
});

test("decide(deny) resolves as denied without executing, and a second decide throws", async () => {
  const broker = new AgentApprovalBroker(() => {}, { execute: async () => ({ text: "", isError: true }), deliver: noopDeliver });
  const approval = broker.submit(item());
  const waitPromise = broker.wait(approval.id, "conv-1");
  broker.decide(approval.id, false);
  const resolution = await waitPromise;
  assert.equal(resolution.outcome, "denied");
  assert.equal(resolution.ok, false);
  assert.throws(() => broker.decide(approval.id, true), /no longer pending/);
});

test("decide on an unknown id throws", () => {
  const broker = new AgentApprovalBroker(() => {}, { execute: async () => ({ text: "", isError: true }), deliver: noopDeliver });
  assert.throws(() => broker.decide("does-not-exist", true), /no longer pending/);
});

test("a failing execute() still resolves as an executed failure, never an unhandled rejection", async () => {
  const delivered = [];
  const broker = new AgentApprovalBroker(() => {}, { execute: async () => { throw new Error("bridge closed"); }, deliver: (resolution) => delivered.push(resolution) });
  const approval = broker.submit(item());
  const waitPromise = broker.wait(approval.id, "conv-1");
  broker.decide(approval.id, true);
  const resolution = await waitPromise;
  assert.equal(resolution.outcome, "executed");
  assert.equal(resolution.ok, false);
  assert.match(resolution.summary, /bridge closed/);
  assert.equal(delivered.length, 0, "a waiter already received the resolution, so deliver() must not duplicate it");
});

test("wait() ignores an id from another conversation instead of inventing a resolution", async () => {
  const broker = new AgentApprovalBroker(() => {}, { execute: async () => ({ text: "ok", isError: false }), deliver: noopDeliver });
  const approval = broker.submit(item({ conversationId: "conv-1" }));
  const foreignWait = await broker.wait(approval.id, "conv-2");
  assert.equal(foreignWait, undefined);
  const unknownWait = await broker.wait("does-not-exist", "conv-1");
  assert.equal(unknownWait, undefined);
  broker.dispose();
});

test("deliver() is skipped for a resolution an active waiter already received", async () => {
  const delivered = [];
  const broker = new AgentApprovalBroker(() => {}, { execute: async () => ({ text: "ok", isError: false }), deliver: (resolution) => delivered.push(resolution) });
  const approval = broker.submit(item());
  const waitPromise = broker.wait(approval.id, "conv-1");
  broker.decide(approval.id, true);
  await waitPromise;
  assert.deepEqual(delivered, []);
});

test("deliver() still runs when nothing is actively waiting", async () => {
  const delivered = [];
  const broker = new AgentApprovalBroker(() => {}, { execute: async () => ({ text: "ok", isError: false }), deliver: (resolution) => delivered.push(resolution) });
  const approval = broker.submit(item());
  broker.decide(approval.id, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, approval.id);
});

test("a wait that times out first removes its own waiter, so a later resolution still reaches deliver()", async () => {
  const delivered = [];
  const broker = new AgentApprovalBroker(() => {}, { execute: async () => ({ text: "ok", isError: false }), deliver: (resolution) => delivered.push(resolution) });
  const approval = broker.submit(item());
  const controller = new AbortController();
  const timedOutWait = broker.wait(approval.id, "conv-1", controller.signal);
  controller.abort();
  assert.equal(await timedOutWait, undefined, "the caller that stopped waiting gets undefined, not a stale promise");
  broker.decide(approval.id, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 1, "the resolution was not lost: no live waiter remained, so deliver() ran");
  assert.equal(delivered[0].id, approval.id);
});

test("wait() issued while the approved call is executing still resolves once execute() settles", async () => {
  let releaseExecute;
  const broker = new AgentApprovalBroker(() => {}, {
    execute: async () => new Promise((resolve) => { releaseExecute = () => resolve({ text: "done", isError: false }); }),
    deliver: () => {},
  });
  const approval = broker.submit(item());
  broker.decide(approval.id, true);
  assert.deepEqual(broker.list(), [], "the card disappears immediately on decide, before execute() settles");
  assert.deepEqual(broker.activeIds("conv-1"), [approval.id], "still active: the bridge call has not settled yet");
  const waitDuringExecution = broker.wait(approval.id, "conv-1");
  releaseExecute();
  const resolution = await waitDuringExecution;
  assert.equal(resolution.outcome, "executed");
  assert.equal(resolution.ok, true);
  assert.equal(resolution.summary, "done");
  assert.deepEqual(broker.activeIds("conv-1"), []);
});

test("dispose cancels every pending approval, across conversations", async () => {
  const broker = new AgentApprovalBroker(() => {}, { execute: async () => ({ text: "", isError: true }), deliver: noopDeliver });
  const a = broker.submit(item({ conversationId: "conv-1" }));
  const b = broker.submit(item({ conversationId: "conv-2" }));
  const waitA = broker.wait(a.id, "conv-1");
  const waitB = broker.wait(b.id, "conv-2");
  broker.dispose();
  assert.equal((await waitA).outcome, "cancelled");
  assert.equal((await waitB).outcome, "cancelled");
  assert.deepEqual(broker.list(), []);
});

test("cancelConversation resolves only that conversation's pending approvals as cancelled", async () => {
  const broker = new AgentApprovalBroker(() => {}, { execute: async () => ({ text: "", isError: true }), deliver: noopDeliver });
  const a = broker.submit(item({ conversationId: "conv-1" }));
  const b = broker.submit(item({ conversationId: "conv-2" }));
  const waitA = broker.wait(a.id, "conv-1");
  const waitB = broker.wait(b.id, "conv-2");
  broker.cancelConversation("conv-1");
  assert.deepEqual(broker.list().map((entry) => entry.id), [b.id]);
  assert.equal((await waitA).outcome, "cancelled");
  broker.dispose();
  assert.equal((await waitB).outcome, "cancelled");
  assert.deepEqual(broker.list(), []);
});

test("the preview is capped at 800 characters", () => {
  const broker = new AgentApprovalBroker(() => {}, { execute: async () => ({ text: "", isError: true }), deliver: noopDeliver });
  const approval = broker.submit(item({ preview: JSON.stringify({ action: "edit_notes", params: { blob: "x".repeat(2000) } }) }));
  assert.ok(approval.preview.length <= 800, `preview length was ${approval.preview.length}`);
  broker.dispose();
});

test("an expiry timer resolves the approval as expired", async () => {
  const broker = new AgentApprovalBroker(() => {}, { timeoutMs: 10, execute: async () => ({ text: "", isError: true }), deliver: noopDeliver });
  const approval = broker.submit(item());
  const resolution = await broker.wait(approval.id, "conv-1");
  assert.equal(resolution.outcome, "expired");
  assert.deepEqual(broker.list(), []);
});

test("registry commands delegate to the broker", async () => {
  const calls = [];
  const approvals = {
    snapshot() { calls.push(["snapshot"]); return { pending: [{ id: "a1" }], recent: [] }; },
    decide(id, approve) { calls.push(["decide", id, approve]); },
  };
  const host = { contributions: async () => [] };
  const inert = {};
  const registry = new ElectronCommandRegistry(host, { ai: inert, creative: inert, desktop: inert, synthv: inert, approvals, componentAudio: { dataRoot: process.cwd() } });
  const listed = await registry.invoke("agent_approvals");
  assert.deepEqual(listed, { pending: [{ id: "a1" }], recent: [] });
  const decided = await registry.invoke("decide_agent_approval", { id: "a1", approve: true });
  assert.equal(decided, null);
  assert.deepEqual(calls, [["snapshot"], ["decide", "a1", true]]);
});

console.log("Agent approval broker resolves asynchronously and the registry delegates to it.");
