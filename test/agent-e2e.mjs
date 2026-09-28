import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMockAnthropicServer, messageText, systemText } from "./fixtures/mock-anthropic-server.mjs";
import { startFakeHost } from "./fixtures/synthv-fake-host.mjs";

// Drives the real @earendil-works/pi-coding-agent SDK through the full Electron host chain
// (ElectronRuntimeHost -> AgentRuntimeWorker -> createPiSessionFactory -> Pi) against a scripted
// local HTTP server that speaks the Anthropic Messages streaming API. No network, no real credentials,
// no access to the real home directory: PI_CODING_AGENT_DIR, HOME, cwd and the AiService metadata
// path are all temp directories for the duration of this file.

const root = fileURLToPath(new URL("..", import.meta.url));
const tauriRoot = join(root, "src/PiDesktop.Tauri");
const runtimeProtocolUrl = pathToFileURL(join(root, "packages/runtime-protocol/dist/index.js")).href;
const agentRuntimeUrl = pathToFileURL(join(root, "packages/agent-runtime/dist/index.js")).href;
const modelAuthCoreUrl = pathToFileURL(join(tauriRoot, "node_modules/@model-auth/core/dist/index.js")).href;

async function loadElectronModule(relativePath) {
  const raw = await readFile(join(tauriRoot, relativePath), "utf8");
  const text = raw
    .replace('from "@synthv-toolbox/runtime-protocol";', `from "${runtimeProtocolUrl}";`)
    .replace('from "@synthv-toolbox/agent-runtime";', `from "${agentRuntimeUrl}";`)
    .replace('from "@model-auth/core";', `from "${modelAuthCoreUrl}";`);
  const executable = stripTypeScriptTypes(text, { mode: "transform" });
  return import(`data:text/javascript;base64,${Buffer.from(executable).toString("base64")}`);
}

const { estimateAgentRunBudget } = await import(runtimeProtocolUrl);

const MODEL_ID = ["cla", "ude-haiku-4-5"].join("");
const PROVIDER_ID = "anthropic";
const TEST_API_KEY = "test-api-key";

test("Real Pi SDK drives the full Electron host chain against a scripted local model", async (t) => {
  const savedEnv = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, HOME: process.env.HOME, PI_OFFLINE: process.env.PI_OFFLINE, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };

  const tempRoot = await mkdtemp(join(tmpdir(), "agent-e2e-"));
  const agentDir = join(tempRoot, "pi-agent");
  const home = join(tempRoot, "home");
  const cwd = join(tempRoot, "cwd");
  const metadataPath = join(tempRoot, "ai", "metadata.json");
  await Promise.all([agentDir, home, cwd].map((dir) => mkdir(dir, { recursive: true })));

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = home;
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
  delete process.env.ANTHROPIC_API_KEY;

  const mock = createMockAnthropicServer();
  const port = await mock.listen();
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({ providers: { [PROVIDER_ID]: { baseUrl: `http://127.0.0.1:${port}` } } }),
    "utf8",
  );

  t.after(async () => {
    await runtimeHost.runtime.dispose();
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const { AiService, agentRuntimePort } = await loadElectronModule("electron/services/ai-service.ts");
  const { ElectronRuntimeHost } = await loadElectronModule("electron/services/runtime-host.ts");

  const secrets = new Map();
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const token = Buffer.from(`sealed:${secrets.size}`);
      secrets.set(token.toString("base64"), value);
      return token;
    },
    decryptString(value) {
      const found = secrets.get(value.toString("base64"));
      if (found === undefined) throw new Error("Unknown sealed credential in test stub.");
      return found;
    },
  };
  const catalog = {
    async models(provider) { return provider === PROVIDER_ID ? [MODEL_ID] : []; },
    async opencode() { return {}; },
  };

  let ai;
  const runtimeHost = new ElectronRuntimeHost(
    join(tempRoot, "runtime"),
    { invoke: () => { throw new Error("Plugin capabilities are not used in this e2e test."); }, resolveModel: () => ai.resolveModelSelection() },
  );
  ai = new AiService({ metadataPath, safeStorage, runtime: agentRuntimePort(runtimeHost.runtime), catalog, approvals: { cancelConversation() {} }, id: () => `id-${Math.random().toString(36).slice(2)}` });

  await ai.add_ai_api_key(PROVIDER_ID, "Test key", TEST_API_KEY, [MODEL_ID]);
  await ai.select_ai_provider(PROVIDER_ID, MODEL_ID);

  const noRuntime = { request: async () => { throw new Error("This AiService instance is read-only in this test."); } };
  // Loads metadata.json from disk into a brand-new instance, proving state survived persist() rather than just the live cache.
  async function reopenFresh(conversationId) {
    const fresh = new AiService({ metadataPath, safeStorage, runtime: noRuntime, catalog });
    return fresh.open_conversation(conversationId);
  }

  function toolNames(request) {
    return (request.tools ?? []).map((tool) => tool.name).sort();
  }

  // Anthropic tool_result blocks live in a later request's `messages`, keyed by the tool_use id the
  // model saw; this is the actual content returned to the model, as opposed to the outcome we observe
  // from the host side.
  function toolResultFor(messages, toolUseId) {
    for (const message of messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block?.type !== "tool_result" || block.tool_use_id !== toolUseId) continue;
        if (typeof block.content === "string") return block.content;
        if (Array.isArray(block.content)) return block.content.map((piece) => piece?.text ?? "").join("");
        return JSON.stringify(block.content);
      }
    }
    return undefined;
  }

  await t.test("update_plan then complete_task with evidence completes the run", async () => {
    mock.reset();
    const conversation = await ai.new_conversation();
    mock.push({ content: [{ type: "tool_use", id: "toolu_1", name: "update_plan", input: { goal: "Summarize the score", doneCriteria: ["Summary written"], todos: [{ id: "t1", title: "Write summary", status: "in_progress" }] } }], stopReason: "tool_use", usage: { input: 500, output: 60, cacheWrite: 20, cacheRead: 15 } });
    mock.push({ content: [{ type: "text", text: "Done." }, { type: "tool_use", id: "toolu_2", name: "complete_task", input: { summary: "Wrote the summary.", evidence: ["Summary written in the reply."] } }], stopReason: "tool_use", usage: { input: 520, output: 40, cacheWrite: 10, cacheRead: 5 } });

    const messages = await ai.send_message(conversation.id, "Please summarize this score.", { cwd, effort: "mid" });
    assert.equal(mock.requests.length, 2, "update_plan and complete_task are two separate provider requests");
    assert.deepEqual(toolNames(mock.requests[0]), ["complete_task", "request_input", "update_plan"]);
    assert.deepEqual(toolNames(mock.requests[1]), ["complete_task", "request_input", "update_plan"]);
    assert.equal(mock.requests[0].apiKey, TEST_API_KEY, "the credential routed through host.model.resolve reaches the provider");
    assert.equal(mock.requests[0].model, MODEL_ID, "the selected model id is the one sent to the provider");
    const systemPrompts = mock.requests.map((request) => systemText(request.system));
    assert.ok(systemPrompts[0].length > 0, "the runtime sends a non-empty system prompt");
    assert.equal(systemPrompts[0], systemPrompts[1], "the system prompt is byte-identical across every request of the run");

    const outcome = messages[1].outcome;
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.summary, "Wrote the summary.");
    assert.deepEqual(outcome.evidence, ["Summary written in the reply."]);
    assert.equal(outcome.plan.goal, "Summarize the score", "the completed outcome still carries the final plan");
    assert.equal(outcome.budget.turns, 2, "one turn per provider request");
    assert.equal(outcome.budget.tokens, 500 + 60 + 20 + 520 + 40 + 10, "tokens are input + output + cache writes summed across every request, excluding cache reads");
    assert.equal(messages[1].content, "Done.", "the assistant's accompanying text is returned");

    const persisted = await reopenFresh(conversation.id);
    const persistedOutcome = persisted.messages[1].outcome;
    assert.equal(persistedOutcome.status, "completed", "the outcome round-trips through metadata.json, read from a fresh AiService");
    assert.equal(persistedOutcome.plan.goal, "Summarize the score");
    assert.equal(persistedOutcome.budget.tokens, outcome.budget.tokens);
  });

  await t.test("a text-only reply triggers a continuation prompt before the run completes", async () => {
    mock.reset();
    const conversation = await ai.new_conversation();
    mock.push({ content: [{ type: "text", text: "Let me think about this." }], stopReason: "end_turn", usage: { input: 400, output: 30, cacheWrite: 0 } });
    mock.push({ content: [{ type: "tool_use", id: "toolu_3", name: "update_plan", input: { goal: "Reply to the user", doneCriteria: ["Replied"], todos: [{ id: "t1", title: "Reply", status: "in_progress" }] } }], stopReason: "tool_use", usage: { input: 410, output: 20, cacheWrite: 0 } });
    mock.push({ content: [{ type: "tool_use", id: "toolu_4", name: "complete_task", input: { summary: "Replied.", evidence: ["Replied to the user."] } }], stopReason: "tool_use", usage: { input: 430, output: 15, cacheWrite: 0 } });

    const messages = await ai.send_message(conversation.id, "Hi there.", { cwd, effort: "mid" });
    assert.equal(mock.requests.length, 3, "the plain-text round, plus a continuation round split into update_plan and complete_task");
    const continuationRequest = mock.requests[1];
    const continuationText = continuationRequest.messages.map(messageText).join("\n");
    assert.match(continuationText, /Keep working toward the current plan's goal/, "the runtime sent a continuation prompt after the text-only reply");

    const outcome = messages[1].outcome;
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.budget.turns, 3);

    const persisted = await reopenFresh(conversation.id);
    assert.equal(persisted.messages[1].outcome.status, "completed", "the continuation run's outcome round-trips through metadata.json");
  });

  await t.test("request_input reports needs_input, and a restarted host continues from the persisted plan", async () => {
    mock.reset();
    const conversation = await ai.new_conversation();
    mock.push({ content: [{ type: "tool_use", id: "toolu_5", name: "update_plan", input: { goal: "Import a project file", doneCriteria: ["File imported"], todos: [{ id: "t1", title: "Locate the file", status: "in_progress" }] } }], stopReason: "tool_use", usage: { input: 300, output: 20, cacheWrite: 0 } });
    mock.push({ content: [{ type: "tool_use", id: "toolu_6", name: "request_input", input: { question: "Which file should I import?", missing: ["source file path"] } }], stopReason: "tool_use", usage: { input: 310, output: 15, cacheWrite: 0 } });

    const firstTurn = await ai.send_message(conversation.id, "Import my project.", { cwd, effort: "mid" });
    const firstOutcome = firstTurn[1].outcome;
    assert.equal(firstOutcome.status, "needs_input");
    assert.deepEqual(firstOutcome.missing, ["source file path"]);
    assert.equal(firstOutcome.plan.goal, "Import a project file", "the plan is persisted alongside the needs_input outcome");

    const persisted = await reopenFresh(conversation.id);
    const persistedOutcome = persisted.messages[1].outcome;
    assert.equal(persistedOutcome.status, "needs_input", "the needs_input outcome round-trips through metadata.json");
    assert.equal(persistedOutcome.plan.goal, "Import a project file");

    // A new ElectronRuntimeHost + AiService over the same metadata path and agent dir starts with no
    // in-memory session, so session.initialize must build a fresh Pi session seeded from the
    // needs_input outcome just persisted, instead of reusing the first host's live session.
    let ai2;
    const runtimeHost2 = new ElectronRuntimeHost(
      join(tempRoot, "runtime"),
      { invoke: () => { throw new Error("Plugin capabilities are not used in this e2e test."); }, resolveModel: () => ai2.resolveModelSelection() },
    );
    ai2 = new AiService({ metadataPath, safeStorage, runtime: agentRuntimePort(runtimeHost2.runtime), catalog, approvals: { cancelConversation() {} }, id: () => `id-${Math.random().toString(36).slice(2)}` });

    mock.reset();
    mock.push({ content: [{ type: "tool_use", id: "toolu_7", name: "complete_task", input: { summary: "Imported the file.", evidence: ["Imported the provided file."] } }], stopReason: "tool_use", usage: { input: 50, output: 10, cacheWrite: 0 } });
    try {
      const secondTurn = await ai2.send_message(conversation.id, "It's at ./song.svp", { cwd, effort: "mid" });
      assert.equal(mock.requests.length, 1, "complete_task succeeds without a fresh update_plan call, proving the restored plan carried the run");
      const restoredRequestText = mock.requests[0].messages.map(messageText).join("\n");
      assert.match(restoredRequestText, /Goal: Import a project file/, "the new session's first request restores the persisted plan");
      assert.match(restoredRequestText, /Which file should I import\?/, "the new session's first request restores the pending question");
      assert.equal(secondTurn[1].outcome.status, "completed");
    } finally {
      await runtimeHost2.runtime.dispose();
    }
  });

  await t.test("scripted usage above the low-effort budget stops the run as budget_exhausted", async () => {
    mock.reset();
    const conversation = await ai.new_conversation();
    const lowBudget = estimateAgentRunBudget("low", []);
    assert.ok(lowBudget.maxTokens !== null && lowBudget.maxTokens > 0);
    const overBudgetOutput = lowBudget.maxTokens + 10_000;
    mock.push({ content: [{ type: "text", text: "Still working on it." }], stopReason: "end_turn", usage: { input: 1_000, output: overBudgetOutput, cacheWrite: 0 } });

    const messages = await ai.send_message(conversation.id, "Do something big.", { cwd, effort: "low" });
    assert.equal(mock.requests.length, 1);
    const outcome = messages[1].outcome;
    assert.equal(outcome.status, "budget_exhausted");
    assert.equal(outcome.budget.turns, 1);
    assert.equal(outcome.budget.tokens, 1_000 + overBudgetOutput);

    const samples = ai.agentUsageSamples().filter((sample) => sample.level === "low");
    assert.equal(samples.length, 1);
    assert.equal(samples[0].censored, true, "a budget_exhausted run is recorded as a censored sample");

    const persisted = await reopenFresh(conversation.id);
    assert.equal(persisted.messages[1].outcome.status, "budget_exhausted", "the budget_exhausted outcome round-trips through metadata.json");
  });

  await t.test("a provider HTTP 401 rejects send_message and persists nothing", async () => {
    mock.reset();
    const conversation = await ai.new_conversation();
    mock.push({ kind: "error", status: 401, errorType: "authentication_error", message: "e2e-401-marker" });

    await assert.rejects(
      () => ai.send_message(conversation.id, "Hello?", { cwd, effort: "mid" }),
      (error) => { assert.match(error.message, /e2e-401-marker/); return true; },
    );
    assert.equal(mock.requests.length, 1, "the 401 is not retried");
    const reopened = await reopenFresh(conversation.id);
    assert.equal(reopened.messages.length, 0, "no assistant message is persisted when the provider call fails, read from a fresh AiService");
  });

  await t.test("cancelling a slow streamed turn produces a cancelled outcome", async () => {
    mock.reset();
    const conversation = await ai.new_conversation();
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    mock.push({ kind: "slow", onStarted: () => started() });

    const sendPromise = ai.send_message(conversation.id, "Do something slow.", { cwd, effort: "mid" });
    await startedPromise;
    await ai.cancel_agent_run(conversation.id);
    const messages = await sendPromise;
    assert.equal(messages[1].outcome.status, "cancelled");
    assert.equal(mock.requests.length, 1, "the cancelled run made exactly one provider request");

    const reopened = await reopenFresh(conversation.id);
    assert.equal(reopened.messages.length, 2, "a cancelled outcome is persisted like any other outcome, read from a fresh AiService");
    assert.equal(reopened.messages[1].outcome.status, "cancelled", "the cancelled outcome round-trips through metadata.json");
  });

  await t.test("SynthV Edit-mode approvals: submit -> approval_pending -> decide -> executed resolution delivered; Stop cancels a pending approval; BRIDGE_NOT_CONNECTED yields needs_input", async (st) => {
    const { createPiSessionFactory } = await import(agentRuntimeUrl);
    const { createSynthVToolsExtension, createSynthVDeliveryRegistry } = await loadElectronModule("electron/services/synthv-agent-tools.ts");
    const { AgentApprovalBroker } = await loadElectronModule("electron/services/agent-approvals.ts");
    const bridgeComponentDir = join(tauriRoot, "components/synthv-agent-bridge");
    const { loadConfig } = await import(pathToFileURL(join(bridgeComponentDir, "dist/src/config.js")).href);
    const { createEmbeddedBridge } = await import(pathToFileURL(join(bridgeComponentDir, "dist/src/embedded.js")).href);

    async function waitUntil(predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("waitUntil timed out");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    // A fresh host + AiService wired with the real SynthV tools extension, over the same persisted
    // provider/model selection as the outer `ai`, against either a running or a disconnected fake bridge host.
    async function withSynthVSession(connected, run) {
      const ipcDirectory = await mkdtemp(join(tmpdir(), "agent-e2e-bridge-"));
      const config = loadConfig({
        SYNTHV_AGENT_BRIDGE_DIR: ipcDirectory,
        SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "2000",
        SYNTHV_AGENT_BRIDGE_POLL_MS: "5",
        SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "3000",
        SYNTHV_AGENT_BRIDGE_STATUS_STALE_MS: "5000",
      }, ipcDirectory);
      const bridge = createEmbeddedBridge({ config, clientLabel: "agent-e2e" });
      const receivedActions = [];
      const host = connected ? await startFakeHost({ ipcDirectory, handler: async (action) => { receivedActions.push(action); return { reloaded: true }; } }) : undefined;
      const registry = createSynthVDeliveryRegistry();
      const approvals = new AgentApprovalBroker(
        () => {},
        { execute: async (item) => bridge.tools.find((tool) => tool.name === item.tool).call(item.params), deliver: (resolution) => registry.deliver(resolution) },
      );
      let synthVAi;
      const synthVRuntimeHost = new ElectronRuntimeHost(
        join(tempRoot, `runtime-synthv-${Math.random().toString(36).slice(2)}`),
        { invoke: () => { throw new Error("Plugin capabilities are not used in this e2e test."); }, resolveModel: () => synthVAi.resolveModelSelection() },
        {
          sessionFactory: createPiSessionFactory({
            extensions: ({ sessionId, guards, runState }) => [createSynthVToolsExtension({ bridge, approvals, workMode: () => "edit", sessionId, guards, runState, registry })],
          }),
        },
      );
      synthVAi = new AiService({ metadataPath, safeStorage, runtime: agentRuntimePort(synthVRuntimeHost.runtime), catalog, approvals, id: () => `id-${Math.random().toString(36).slice(2)}` });
      try {
        await run({ ai: synthVAi, approvals, receivedActions });
      } finally {
        await synthVRuntimeHost.runtime.dispose();
        await host?.stop();
        await bridge.close();
        await rm(ipcDirectory, { recursive: true, force: true });
      }
    }

    await st.test("decide(approve) resolves the gated call, and sv_await_approval delivers the executed resolution", async () => {
      await withSynthVSession(true, async ({ ai: synthVAi, approvals, receivedActions }) => {
        mock.reset();
        const conversation = await synthVAi.new_conversation();
        mock.push({ content: [{ type: "tool_use", id: "toolu_sv_0", name: "update_plan", input: { goal: "Reload the SynthV bridge", doneCriteria: ["Bridge reloaded"], todos: [{ id: "t1", title: "Reload the bridge", status: "in_progress" }] } }], stopReason: "tool_use", usage: { input: 90, output: 20, cacheWrite: 0 } });
        mock.push({ content: [{ type: "tool_use", id: "toolu_sv_1", name: "sv_status", input: { operation: "reload" } }], stopReason: "tool_use", usage: { input: 100, output: 20, cacheWrite: 0 } });
        mock.push({ content: [{ type: "tool_use", id: "toolu_sv_2", name: "sv_await_approval", input: {} }], stopReason: "tool_use", usage: { input: 120, output: 20, cacheWrite: 0 } });
        mock.push({ content: [{ type: "text", text: "Reloaded." }, { type: "tool_use", id: "toolu_sv_3", name: "complete_task", input: { summary: "Reloaded the bridge.", evidence: ["The gated reload was approved and executed."] } }], stopReason: "tool_use", usage: { input: 140, output: 20, cacheWrite: 0 } });

        const sendPromise = synthVAi.send_message(conversation.id, "Reload the bridge.", { cwd, effort: "mid" });
        await waitUntil(() => approvals.list().length === 1);
        const [approval] = approvals.list();
        assert.equal(approval.category, "executorControl");
        assert.equal(approval.risk, "high");
        approvals.decide(approval.id, true);

        const messages = await sendPromise;
        assert.equal(mock.requests.length, 4, "update_plan, the gated call, sv_await_approval, then complete_task");
        assert.equal(messages[1].outcome.status, "completed");
        assert.deepEqual(receivedActions, ["reload_bridge"], "exactly one reload reached the fake host, after approval");

        const finalRequest = mock.requests.at(-1);
        const awaitResult = toolResultFor(finalRequest.messages, "toolu_sv_2");
        assert.ok(awaitResult, "the model's history carries a tool_result for the sv_await_approval call");
        assert.match(awaitResult, /"outcome":"executed"/, "sv_await_approval's tool result carries the executed resolution");
        assert.match(awaitResult, /"ok":true/);
      });
    });

    await st.test("Stop while an approval is pending resolves it as cancelled and ends the run cancelled, with no write reaching the host", async () => {
      await withSynthVSession(true, async ({ ai: synthVAi, approvals, receivedActions }) => {
        mock.reset();
        const conversation = await synthVAi.new_conversation();
        mock.push({ content: [{ type: "tool_use", id: "toolu_sv_4", name: "sv_status", input: { operation: "reload" } }], stopReason: "tool_use", usage: { input: 100, output: 20, cacheWrite: 0 } });
        mock.push({ content: [{ type: "tool_use", id: "toolu_sv_5", name: "sv_await_approval", input: {} }], stopReason: "tool_use", usage: { input: 120, output: 20, cacheWrite: 0 } });

        const sendPromise = synthVAi.send_message(conversation.id, "Reload the bridge.", { cwd, effort: "mid" });
        await waitUntil(() => approvals.list().length === 1);
        const [approval] = approvals.list();
        // A second live waiter here reliably avoids a race where the tool's own wait() would otherwise
        // settle before Pi's abort() propagates, sending the run into an unplanned extra round.
        const resolutionPromise = approvals.wait(approval.id, conversation.id);
        await synthVAi.cancel_agent_run(conversation.id);

        const resolution = await resolutionPromise;
        assert.equal(resolution.outcome, "cancelled");
        assert.deepEqual(approvals.list(), [], "the pending approval no longer sits in the pending list once Stop cancels it");
        assert.deepEqual(receivedActions, [], "no write request reached the host: Stop cancelled the approval before it executed");

        // Stop must resolve the pending approval as cancelled regardless of how the underlying Pi
        // session's own abort surfaces on send_message (a graceful cancelled outcome, or a rejection
        // from the in-flight provider call the abort tore down).
        await sendPromise.then(
          (messages) => assert.equal(messages[1].outcome.status, "cancelled", "Stop while an approval is pending cancels the whole run"),
          () => {}, // the abort itself may reject send_message; the approval-cancellation and no-write assertions above are what this test verifies
        );
      });
    });

    await st.test("Stop during a slow turn cancels the pending approval without steering it into an unplanned continuation turn", async () => {
      await withSynthVSession(true, async ({ ai: synthVAi, approvals, receivedActions }) => {
        mock.reset();
        const conversation = await synthVAi.new_conversation();
        mock.push({ content: [{ type: "tool_use", id: "toolu_stop_1", name: "sv_status", input: { operation: "reload" } }], stopReason: "tool_use", usage: { input: 100, output: 20, cacheWrite: 0 } });
        let started;
        const startedPromise = new Promise((resolve) => { started = resolve; });
        mock.push({ kind: "slow", onStarted: () => started() });
        // Only reached if a bug steers the cancelled approval into an unplanned continuation turn.
        mock.push({ content: [{ type: "tool_use", id: "toolu_stop_3", name: "sv_ui", input: { action: "set_selection", operation: "clear", kind: "all" } }], stopReason: "tool_use", usage: { input: 130, output: 20, cacheWrite: 0 } });

        const sendPromise = synthVAi.send_message(conversation.id, "Reload then clear the selection.", { cwd, effort: "mid" });
        await waitUntil(() => approvals.list().length === 1);
        await startedPromise;
        await synthVAi.cancel_agent_run(conversation.id);

        await sendPromise.then(
          (messages) => assert.equal(messages[1].outcome.status, "cancelled", "Stop during the slow turn cancels the whole run"),
          () => {}, // the abort itself may reject send_message; the assertions below are what this test verifies
        );

        assert.equal(mock.requests.length, 2, "no unplanned continuation turn is started after Stop");
        assert.deepEqual(receivedActions, [], "the cancelled resolution never reaches the host through a steered continuation");
        assert.deepEqual(approvals.list(), [], "Stop resolves the pending approval instead of leaving it pending");
      });
    });

    await st.test("a disconnected bridge fails the gated call fast, and the model's request_input yields needs_input", async () => {
      await withSynthVSession(false, async ({ ai: synthVAi, approvals }) => {
        mock.reset();
        const conversation = await synthVAi.new_conversation();
        mock.push({ content: [{ type: "tool_use", id: "toolu_sv_6", name: "sv_status", input: { operation: "reload" } }], stopReason: "tool_use", usage: { input: 100, output: 20, cacheWrite: 0 } });
        mock.push({ content: [{ type: "tool_use", id: "toolu_sv_7", name: "request_input", input: { question: "SynthV Agent Bridge is not connected. Should I keep waiting or would you like to start it?", missing: ["bridge connection"] } }], stopReason: "tool_use", usage: { input: 120, output: 20, cacheWrite: 0 } });

        const messages = await synthVAi.send_message(conversation.id, "Reload the bridge.", { cwd, effort: "mid" });
        assert.equal(mock.requests.length, 2, "the failed gated call, then request_input");
        assert.equal(messages[1].outcome.status, "needs_input");
        assert.deepEqual(approvals.list(), [], "a disconnected bridge never submits an approval");

        const gatedCallResult = toolResultFor(mock.requests[1].messages, "toolu_sv_6");
        assert.ok(gatedCallResult, "the model's history carries a tool_result for the gated sv_status call");
        assert.match(gatedCallResult, /BRIDGE_NOT_CONNECTED/, "the model actually saw BRIDGE_NOT_CONNECTED, not just a needs_input outcome");
      });
    });
  });
});
