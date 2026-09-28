import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeHost } from "./fixtures/synthv-fake-host.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const bridgeDirectory = join(root, "src/PiDesktop.Tauri/components/synthv-agent-bridge");
const { loadConfig } = await import(pathToFileURL(join(bridgeDirectory, "dist/src/config.js")).href);
const { createEmbeddedBridge } = await import(pathToFileURL(join(bridgeDirectory, "dist/src/embedded.js")).href);
const { createSynthVToolsExtension, createSynthVDeliveryRegistry } = await import(pathToFileURL(join(root, "src/PiDesktop.Tauri/dist/electron/services/synthv-agent-tools.js")).href);
const { AgentApprovalBroker } = await import(pathToFileURL(join(root, "src/PiDesktop.Tauri/dist/electron/services/agent-approvals.js")).href);

const noopDeliver = () => {};
const idleRunState = () => ({ active: false, runId: "run-idle" });

function executeViaBridge(bridge) {
  return async (item) => bridge.tools.find((tool) => tool.name === item.tool).call(item.params);
}

// A minimal, faithful stand-in for Pi's ExtensionApi: captures registered tools and before_agent_start
// handlers, and records sendMessage("steer") calls instead of driving a real run.
function createFakeExtensionApi() {
  const tools = new Map();
  const handlers = { before_agent_start: [] };
  const steered = [];
  return {
    tools,
    steered,
    registerTool(definition) { tools.set(definition.name, definition); },
    on(event, handler) { (handlers[event] ??= []).push(handler); },
    sendMessage(message, options) { steered.push({ message, options }); },
    fireBeforeAgentStart(event) { return handlers.before_agent_start.map((handler) => handler(event)).find(Boolean); },
  };
}

/** Default fakes for the options every createSynthVToolsExtension call now requires. */
function extensionOptions(overrides = {}) {
  return {
    guards: { completion() {} },
    runState: idleRunState,
    registry: createSynthVDeliveryRegistry(),
    ...overrides,
  };
}

async function withTempBridge(run) {
  const directory = await mkdtemp(join(tmpdir(), "synthv-agent-tools-test-"));
  const config = loadConfig({
    SYNTHV_AGENT_BRIDGE_DIR: directory,
    SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "2000",
    SYNTHV_AGENT_BRIDGE_POLL_MS: "5",
    SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "3000",
    SYNTHV_AGENT_BRIDGE_STATUS_STALE_MS: "5000",
  }, directory);
  try {
    await run(directory, config);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Solo mode dispatches sv_status directly against the real bridge and fake host, with no approval", async () => {
  await withTempBridge(async (directory, config) => {
    const seenActions = [];
    const host = await startFakeHost({ ipcDirectory: directory, handler: async (action) => { seenActions.push(action); return { pong: true }; } });
    const bridge = createEmbeddedBridge({ config, clientLabel: "test" });
    const approvals = new AgentApprovalBroker(() => {}, { execute: executeViaBridge(bridge), deliver: noopDeliver });
    const api = createFakeExtensionApi();
    const options = extensionOptions();
    try {
      createSynthVToolsExtension({ bridge, approvals, workMode: () => "solo", sessionId: "conv-solo", ...options }).factory(api);
      const svStatus = api.tools.get("sv_status");
      const result = await svStatus.execute("call-1", { operation: "ping" }, undefined, () => {});
      assert.equal(result.details?.progress, false, "sv_status results never count as progress");
      assert.deepEqual(seenActions, ["ping"]);
      assert.deepEqual(approvals.list(), [], "solo mode never submits an approval");
    } finally {
      await host.stop();
      await bridge.close();
    }
  });
});

test("Edit mode never gates an ordinary sv_ui call: set_selection is uiChange but not high-risk, so it dispatches directly", async () => {
  await withTempBridge(async (directory, config) => {
    const seenActions = [];
    const host = await startFakeHost({ ipcDirectory: directory, handler: async (action) => { seenActions.push(action); return { ok: true }; } });
    const bridge = createEmbeddedBridge({ config, clientLabel: "test" });
    const approvals = new AgentApprovalBroker(() => {}, { execute: executeViaBridge(bridge), deliver: noopDeliver });
    const api = createFakeExtensionApi();
    try {
      const classification = bridge.classify("sv_ui", { action: "set_selection", args: { operation: "clear", kind: "all" } });
      assert.equal(classification.category, "uiChange");
      assert.equal(classification.risk, "normal", "sv_ui is never high-risk, so Edit mode must not gate it");
      createSynthVToolsExtension({ bridge, approvals, workMode: () => "edit", sessionId: "conv-ui", ...extensionOptions() }).factory(api);
      const svUi = api.tools.get("sv_ui");
      const result = await svUi.execute("call-ui", { action: "set_selection", args: { operation: "clear", kind: "all" } }, undefined, () => {});
      assert.deepEqual(seenActions, ["set_selection"], "the call reached the host directly, with no approval gate");
      assert.deepEqual(approvals.list(), []);
      assert.doesNotMatch(result.content[0].text, /approval_pending/);
    } finally {
      await host.stop();
      await bridge.close();
    }
  });
});

test("an ungated call already aborted throws RUN_CANCELLED and never reaches the host", async () => {
  await withTempBridge(async (directory, config) => {
    const seenActions = [];
    const host = await startFakeHost({ ipcDirectory: directory, handler: async (action) => { seenActions.push(action); return {}; } });
    const bridge = createEmbeddedBridge({ config, clientLabel: "test" });
    const approvals = new AgentApprovalBroker(() => {}, { execute: executeViaBridge(bridge), deliver: noopDeliver });
    const api = createFakeExtensionApi();
    try {
      createSynthVToolsExtension({ bridge, approvals, workMode: () => "solo", sessionId: "conv-abort", ...extensionOptions() }).factory(api);
      const svQuery = api.tools.get("sv_query");
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        () => svQuery.execute("call-abort", { action: "get_project_info" }, controller.signal, () => {}),
        (error) => { assert.match(error.message, /RUN_CANCELLED/); return true; },
      );
      assert.deepEqual(seenActions, [], "an already-aborted call is never sent to the host");
    } finally {
      await host.stop();
      await bridge.close();
    }
  });
});

test("a gated call cancelled before it is sent (runId cleared) throws RUN_CANCELLED without submitting an approval", async () => {
  await withTempBridge(async (directory, config) => {
    const host = await startFakeHost({ ipcDirectory: directory, handler: async () => ({}) });
    const bridge = createEmbeddedBridge({ config, clientLabel: "test" });
    const approvals = new AgentApprovalBroker(() => {}, { execute: executeViaBridge(bridge), deliver: noopDeliver });
    const api = createFakeExtensionApi();
    try {
      createSynthVToolsExtension({ bridge, approvals, workMode: () => "edit", sessionId: "conv-no-run", ...extensionOptions({ runState: () => ({ active: true, runId: null }) }) }).factory(api);
      const svStatus = api.tools.get("sv_status");
      await assert.rejects(
        () => svStatus.execute("call-no-run", { operation: "reload" }, undefined, () => {}),
        (error) => { assert.match(error.message, /RUN_CANCELLED/); return true; },
      );
      assert.deepEqual(approvals.list(), [], "a cancelled run never submits an approval");
    } finally {
      await host.stop();
      await bridge.close();
    }
  });
});

test("an ungated call's facade error carries the bridge's own bounded JSON, not a generic message", async () => {
  await withTempBridge(async (directory, config) => {
    const bridge = createEmbeddedBridge({ config, clientLabel: "test" });
    // No fake host: the read call fails fast with the bridge's own BRIDGE_NOT_CONNECTED envelope.
    const approvals = new AgentApprovalBroker(() => {}, { execute: executeViaBridge(bridge), deliver: noopDeliver });
    const api = createFakeExtensionApi();
    try {
      createSynthVToolsExtension({ bridge, approvals, workMode: () => "solo", sessionId: "conv-facade-error", ...extensionOptions() }).factory(api);
      const svQuery = api.tools.get("sv_query");
      await assert.rejects(
        () => svQuery.execute("call-facade", { action: "get_project_info" }, undefined, () => {}),
        (error) => {
          const parsed = JSON.parse(error.message);
          assert.equal(parsed.error.code, "BRIDGE_NOT_CONNECTED");
          return true;
        },
      );
    } finally {
      await bridge.close();
    }
  });
});

test("the before_agent_start SynthV section is byte-identical across rounds", async () => {
  await withTempBridge(async (directory, config) => {
    const host = await startFakeHost({ ipcDirectory: directory, handler: async () => ({}) });
    const bridge = createEmbeddedBridge({ config, clientLabel: "test" });
    const approvals = new AgentApprovalBroker(() => {}, { execute: executeViaBridge(bridge), deliver: noopDeliver });
    const api = createFakeExtensionApi();
    try {
      createSynthVToolsExtension({ bridge, approvals, workMode: () => "solo", sessionId: "conv-prompt", ...extensionOptions() }).factory(api);
      const first = api.fireBeforeAgentStart({ systemPrompt: "round one base" });
      const second = api.fireBeforeAgentStart({ systemPrompt: "round two base" });
      const firstSection = first.systemPrompt.slice(first.systemPrompt.indexOf("## SynthV"));
      const secondSection = second.systemPrompt.slice(second.systemPrompt.indexOf("## SynthV"));
      assert.equal(firstSection, secondSection, "the appended SynthV section is static and byte-identical on every round");
    } finally {
      await host.stop();
      await bridge.close();
    }
  });
});

test("Edit mode gates a high-risk sv_status reload: approval_pending, then decide(true) executes exactly one request", async () => {
  await withTempBridge(async (directory, config) => {
    const seenActions = [];
    const host = await startFakeHost({ ipcDirectory: directory, handler: async (action) => { seenActions.push(action); return { reloaded: true }; } });
    const bridge = createEmbeddedBridge({ config, clientLabel: "test" });
    const approvals = new AgentApprovalBroker(() => {}, { execute: executeViaBridge(bridge), deliver: noopDeliver });
    const api = createFakeExtensionApi();
    const options = extensionOptions({ runState: () => ({ active: true, runId: "run-1" }) });
    try {
      assert.equal(bridge.classify("sv_status", { operation: "reload" }).risk, "high", "sv_status reload must be classified high-risk for this test to be meaningful");
      createSynthVToolsExtension({ bridge, approvals, workMode: () => "edit", sessionId: "conv-1", ...options }).factory(api);
      const svStatus = api.tools.get("sv_status");

      const pending = await svStatus.execute("call-1", { operation: "reload" }, undefined, () => {});
      assert.equal(pending.details.activity.status, "awaiting_approval");
      assert.equal(pending.details.progress, false);
      const parsed = JSON.parse(pending.content[0].text);
      assert.equal(parsed.outcome, "approval_pending");
      assert.ok(parsed.approvalId);
      assert.deepEqual(seenActions, [], "nothing is sent to the host while pending");

      const pendingList = approvals.list();
      assert.equal(pendingList.length, 1);
      assert.equal(pendingList[0].tool, "sv_status");
      assert.equal(pendingList[0].category, "executorControl");
      assert.equal(pendingList[0].runId, "run-1");

      const waitPromise = approvals.wait(parsed.approvalId, "conv-1");
      approvals.decide(parsed.approvalId, true);
      const resolution = await waitPromise;
      assert.equal(resolution.outcome, "executed");
      assert.equal(resolution.ok, true);
      assert.deepEqual(seenActions, ["reload_bridge"], "exactly one request reached the fake host, after approval");
      assert.deepEqual(approvals.list(), []);
    } finally {
      await host.stop();
      await bridge.close();
    }
  });
});

test("Edit mode: a denied approval never reaches the host, and the resolution is queued for the next run when idle", async () => {
  await withTempBridge(async (directory, config) => {
    const seenActions = [];
    const host = await startFakeHost({ ipcDirectory: directory, handler: async (action) => { seenActions.push(action); return {}; } });
    const bridge = createEmbeddedBridge({ config, clientLabel: "test" });
    const registry = createSynthVDeliveryRegistry();
    const approvals = new AgentApprovalBroker(() => {}, { execute: executeViaBridge(bridge), deliver: (resolution) => registry.deliver(resolution) });
    const api = createFakeExtensionApi();
    try {
      const runState = () => ({ active: false, runId: "run-2" });
      createSynthVToolsExtension({ bridge, approvals, workMode: () => "edit", sessionId: "conv-2", ...extensionOptions({ runState, registry }) }).factory(api);
      const svStatus = api.tools.get("sv_status");
      const pending = await svStatus.execute("call-2", { operation: "reload" }, undefined, () => {});
      const { approvalId } = JSON.parse(pending.content[0].text);

      approvals.decide(approvalId, false);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(seenActions, [], "a denied approval is never sent to the host");
      assert.equal(api.steered.length, 0, "idle session: no steering message, the resolution is queued instead");

      const beforeStart = api.fireBeforeAgentStart({ systemPrompt: "base" });
      assert.match(beforeStart.systemPrompt, /## SynthV/);
      assert.ok(beforeStart.message, "the queued denial is delivered as the first-round context message");
      assert.match(beforeStart.message.content, /APPROVAL_DENIED/);
      assert.equal(beforeStart.message.display, false);

      const secondStart = api.fireBeforeAgentStart({ systemPrompt: "base" });
      assert.equal(secondStart.message, undefined, "the queue is drained after the first before_agent_start");
    } finally {
      await host.stop();
      await bridge.close();
    }
  });
});

test("Edit mode: while a run is active, the resolution steers instead of queuing, as a real Pi custom message", async () => {
  await withTempBridge(async (directory, config) => {
    const host = await startFakeHost({ ipcDirectory: directory, handler: async () => ({}) });
    const bridge = createEmbeddedBridge({ config, clientLabel: "test" });
    const registry = createSynthVDeliveryRegistry();
    const approvals = new AgentApprovalBroker(() => {}, { execute: executeViaBridge(bridge), deliver: (resolution) => registry.deliver(resolution) });
    const api = createFakeExtensionApi();
    try {
      const runState = () => ({ active: true, runId: "run-1" });
      createSynthVToolsExtension({ bridge, approvals, workMode: () => "edit", sessionId: "conv-3", ...extensionOptions({ runState, registry }) }).factory(api);
      const svStatus = api.tools.get("sv_status");
      const pending = await svStatus.execute("call-3", { operation: "reload" }, undefined, () => {});
      const { approvalId } = JSON.parse(pending.content[0].text);

      // Deliberately not calling approvals.wait() here: an active waiter would suppress deliver(),
      // which is exactly the duplicate-delivery guard this test must not trip while observing steering.
      approvals.decide(approvalId, true);
      await new Promise((resolve) => { const check = () => (api.steered.length > 0 ? resolve() : setTimeout(check, 5)); check(); });
      assert.equal(api.steered.length, 1);
      assert.equal(api.steered[0].options.deliverAs, "steer");
      assert.equal(api.steered[0].message.customType, "synthv-approvals");
      assert.equal(api.steered[0].message.display, false);
      assert.match(api.steered[0].message.content, /approved and executed/);
    } finally {
      await host.stop();
      await bridge.close();
    }
  });
});

test("sv_await_approval waits for pending approvals of this conversation and reports progress only on an executed success", async () => {
  await withTempBridge(async (directory, config) => {
    const host = await startFakeHost({ ipcDirectory: directory, handler: async () => ({}) });
    const bridge = createEmbeddedBridge({ config, clientLabel: "test" });
    const approvals = new AgentApprovalBroker(() => {}, { execute: executeViaBridge(bridge), deliver: noopDeliver });
    const api = createFakeExtensionApi();
    try {
      createSynthVToolsExtension({ bridge, approvals, workMode: () => "edit", sessionId: "conv-4", ...extensionOptions({ runState: () => ({ active: true, runId: "run-4" }) }) }).factory(api);
      const svStatus = api.tools.get("sv_status");
      const pending = await svStatus.execute("call-4", { operation: "reload" }, undefined, () => {});
      const { approvalId } = JSON.parse(pending.content[0].text);

      const awaitApproval = api.tools.get("sv_await_approval");
      const waitResultPromise = awaitApproval.execute("call-5", {}, undefined, () => {});
      approvals.decide(approvalId, true);
      const waitResult = await waitResultPromise;
      assert.notEqual(waitResult.details?.progress, false, "an executed-success resolution counts as progress");
      const { resolutions } = JSON.parse(waitResult.content[0].text);
      assert.equal(resolutions.length, 1);
      assert.equal(resolutions[0].outcome, "executed");
      assert.equal(resolutions[0].ok, true);
      assert.equal(api.steered.length, 0, "sv_await_approval already delivered the resolution as its own tool result, so deliver() must not duplicate it");
    } finally {
      await host.stop();
      await bridge.close();
    }
  });
});

test("an approval that resolves and steers before sv_await_approval is called is not delivered a second time through the tool result", async () => {
  await withTempBridge(async (directory, config) => {
    const host = await startFakeHost({ ipcDirectory: directory, handler: async () => ({}) });
    const bridge = createEmbeddedBridge({ config, clientLabel: "test" });
    const registry = createSynthVDeliveryRegistry();
    const approvals = new AgentApprovalBroker(() => {}, { execute: executeViaBridge(bridge), deliver: (resolution) => registry.deliver(resolution) });
    const api = createFakeExtensionApi();
    try {
      const runState = () => ({ active: true, runId: "run-6" });
      createSynthVToolsExtension({ bridge, approvals, workMode: () => "edit", sessionId: "conv-7", ...extensionOptions({ runState, registry }) }).factory(api);
      const svStatus = api.tools.get("sv_status");
      const pending = await svStatus.execute("call-9", { operation: "reload" }, undefined, () => {});
      const { approvalId } = JSON.parse(pending.content[0].text);

      // The model is doing independent work, not awaiting: approve resolves and steers on its own.
      approvals.decide(approvalId, true);
      await new Promise((resolve) => { const check = () => (api.steered.length > 0 ? resolve() : setTimeout(check, 5)); check(); });
      assert.equal(api.steered.length, 1, "delivered once via steering");

      // The model only now calls sv_await_approval for the same id, expecting an answer if one is still owed.
      const awaitApproval = api.tools.get("sv_await_approval");
      const result = await awaitApproval.execute("call-10", { approvalIds: [approvalId], timeoutSec: 1 }, undefined, () => {});
      const { resolutions } = JSON.parse(result.content[0].text);
      assert.deepEqual(resolutions, [], "already steered to the model; the await tool must not hand it the same resolution again");
      assert.equal(api.steered.length, 1, "still exactly one delivery of this resolution");
    } finally {
      await host.stop();
      await bridge.close();
    }
  });
});

test("sv_await_approval reports a still-pending approval, not a fabricated cancellation, when nothing resolves in time", async () => {
  await withTempBridge(async (directory, config) => {
    const host = await startFakeHost({ ipcDirectory: directory, handler: async () => ({}) });
    const bridge = createEmbeddedBridge({ config, clientLabel: "test" });
    const approvals = new AgentApprovalBroker(() => {}, { timeoutMs: 60_000, execute: executeViaBridge(bridge), deliver: noopDeliver });
    const api = createFakeExtensionApi();
    try {
      createSynthVToolsExtension({ bridge, approvals, workMode: () => "edit", sessionId: "conv-5", ...extensionOptions({ runState: () => ({ active: true, runId: "run-5" }) }) }).factory(api);
      const svStatus = api.tools.get("sv_status");
      await svStatus.execute("call-6", { operation: "reload" }, undefined, () => {});

      const awaitApproval = api.tools.get("sv_await_approval");
      const result = await awaitApproval.execute("call-7", { timeoutSec: 1 }, undefined, () => {});
      assert.equal(result.details?.progress, false);
      const { resolutions } = JSON.parse(result.content[0].text);
      assert.equal(resolutions.length, 1);
      assert.equal(resolutions[0].resolution, "pending", "a timeout reports the approval as still pending, since it can still be decided later");
      assert.ok(resolutions[0].expiresAtUtc);
      assert.equal(approvals.list().length, 1, "the approval itself is untouched by the timeout");
    } finally {
      approvals.dispose();
      await host.stop();
      await bridge.close();
    }
  });
});

test("the completion guard still blocks while an approved call is executing, not just while it is pending", async () => {
  await withTempBridge(async (directory, config) => {
    let releaseHost;
    const host = await startFakeHost({ ipcDirectory: directory, handler: async () => new Promise((resolve) => { releaseHost = () => resolve({}); }) });
    const bridge = createEmbeddedBridge({ config, clientLabel: "test" });
    const approvals = new AgentApprovalBroker(() => {}, { execute: executeViaBridge(bridge), deliver: noopDeliver });
    const api = createFakeExtensionApi();
    let completionCheck;
    try {
      createSynthVToolsExtension({
        bridge, approvals, workMode: () => "edit", sessionId: "conv-8",
        ...extensionOptions({ guards: { completion: (check) => { completionCheck = check; } }, runState: () => ({ active: true, runId: "run-7" }) }),
      }).factory(api);
      const svStatus = api.tools.get("sv_status");
      const pending = await svStatus.execute("call-11", { operation: "reload" }, undefined, () => {});
      const { approvalId } = JSON.parse(pending.content[0].text);
      assert.match(completionCheck(), /1 SynthV approvals are still pending/);

      approvals.decide(approvalId, true);
      assert.deepEqual(approvals.list(), [], "the card is gone, but the write has not settled yet");
      assert.match(completionCheck(), /still pending/, "complete_task must still be blocked while the approved write executes");

      await new Promise((resolve) => { const check = () => (releaseHost ? resolve() : setTimeout(check, 5)); check(); });
      releaseHost();
      await new Promise((resolve) => { const check = () => (completionCheck() === null ? resolve() : setTimeout(check, 5)); check(); });
      assert.equal(completionCheck(), null, "clear once execution actually settles");
    } finally {
      await host.stop();
      await bridge.close();
    }
  });
});

test("disconnected bridge fails a gated call fast with BRIDGE_NOT_CONNECTED, without submitting an approval", async () => {
  await withTempBridge(async (directory, config) => {
    // No fake host is started: the status file never exists, so the bridge is never connected.
    const bridge = createEmbeddedBridge({ config, clientLabel: "test" });
    const approvals = new AgentApprovalBroker(() => {}, { execute: executeViaBridge(bridge), deliver: noopDeliver });
    const api = createFakeExtensionApi();
    try {
      createSynthVToolsExtension({ bridge, approvals, workMode: () => "edit", sessionId: "conv-6", ...extensionOptions() }).factory(api);
      const svStatus = api.tools.get("sv_status");
      await assert.rejects(
        () => svStatus.execute("call-8", { operation: "reload" }, undefined, () => {}),
        (error) => { assert.match(error.message, /BRIDGE_NOT_CONNECTED/); return true; },
      );
      assert.deepEqual(approvals.list(), [], "nothing is submitted for a call that cannot run");
    } finally {
      await bridge.close();
    }
  });
});

console.log("SynthV agent tools gate high-risk calls in Edit mode and route resolutions via steer/queue.");
