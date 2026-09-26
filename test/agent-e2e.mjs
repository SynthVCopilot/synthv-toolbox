import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// ---------------------------------------------------------------------------
// Scripted Anthropic Messages API server
// ---------------------------------------------------------------------------

function sendSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function writeNormalTurn(res, turn) {
  const usage = turn.usage ?? { input: 0, output: 0, cacheWrite: 0 };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  sendSse(res, "message_start", {
    type: "message_start",
    message: {
      id: `msg_${Math.random().toString(36).slice(2)}`,
      type: "message",
      role: "assistant",
      model: MODEL_ID,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.input, output_tokens: 0, cache_creation_input_tokens: usage.cacheWrite ?? 0, cache_read_input_tokens: 0 },
    },
  });
  turn.content.forEach((block, index) => {
    if (block.type === "text") {
      sendSse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      sendSse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      sendSse(res, "content_block_stop", { type: "content_block_stop", index });
    } else if (block.type === "tool_use") {
      sendSse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      sendSse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      sendSse(res, "content_block_stop", { type: "content_block_stop", index });
    }
  });
  sendSse(res, "message_delta", { type: "message_delta", delta: { stop_reason: turn.stopReason, stop_sequence: null }, usage: { output_tokens: usage.output } });
  sendSse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function writeSlowTurn(res, turn) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  sendSse(res, "message_start", {
    type: "message_start",
    message: { id: "msg_slow", type: "message", role: "assistant", model: MODEL_ID, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  });
  sendSse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  sendSse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Working on it" } });
  turn.onStarted?.();
  const timer = setTimeout(() => {
    // Only reached if the caller failed to cancel in time; finish the turn so the test does not hang.
    try {
      sendSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sendSse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
      sendSse(res, "message_stop", { type: "message_stop" });
      res.end();
    } catch { /* connection already gone */ }
  }, 5000);
  res.on("close", () => clearTimeout(timer));
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((block) => block?.type === "text").map((block) => block.text).join("");
}

function systemText(system) {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.filter((block) => block?.type === "text").map((block) => block.text).join("");
}

function createMockAnthropicServer() {
  const requests = [];
  let queue = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* leave null */ }
      const headers = { ...req.headers };
      delete headers["x-api-key"];
      delete headers.authorization;
      requests.push({ path: req.url, system: body?.system, tools: body?.tools, messages: body?.messages, headers });
      const turn = queue.shift();
      if (!turn) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "No scripted turn was queued for this request." } }));
        return;
      }
      if (turn.kind === "error") {
        res.writeHead(turn.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: turn.errorType ?? "authentication_error", message: turn.message } }));
        return;
      }
      if (turn.kind === "slow") writeSlowTurn(res, turn);
      else writeNormalTurn(res, turn);
    });
  });
  return {
    requests,
    push(turn) { queue.push(turn); },
    reset() { queue = []; requests.length = 0; },
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return server.address().port;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------------------------------------------------------------------------

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
  ai = new AiService({ metadataPath, safeStorage, runtime: agentRuntimePort(runtimeHost.runtime), catalog, id: () => `id-${Math.random().toString(36).slice(2)}` });

  await ai.add_ai_api_key(PROVIDER_ID, "Test key", "test-api-key", [MODEL_ID]);
  await ai.select_ai_provider(PROVIDER_ID, MODEL_ID);

  function toolNames(request) {
    return (request.tools ?? []).map((tool) => tool.name).sort();
  }

  await t.test("update_plan then complete_task with evidence completes the run", async () => {
    mock.reset();
    const conversation = await ai.new_conversation();
    mock.push({ content: [{ type: "tool_use", id: "toolu_1", name: "update_plan", input: { goal: "Summarize the score", doneCriteria: ["Summary written"], todos: [{ id: "t1", title: "Write summary", status: "in_progress" }] } }], stopReason: "tool_use", usage: { input: 500, output: 60, cacheWrite: 0 } });
    mock.push({ content: [{ type: "text", text: "Done." }, { type: "tool_use", id: "toolu_2", name: "complete_task", input: { summary: "Wrote the summary.", evidence: ["Summary written in the reply."] } }], stopReason: "tool_use", usage: { input: 520, output: 40, cacheWrite: 0 } });

    const messages = await ai.send_message(conversation.id, "Please summarize this score.", { cwd, effort: "mid" });
    assert.equal(mock.requests.length, 2, "update_plan and complete_task are two separate provider requests");
    assert.deepEqual(toolNames(mock.requests[0]), ["complete_task", "request_input", "update_plan"]);
    assert.deepEqual(toolNames(mock.requests[1]), ["complete_task", "request_input", "update_plan"]);
    const systemPrompts = mock.requests.map((request) => systemText(request.system));
    assert.ok(systemPrompts[0].length > 0, "the runtime sends a non-empty system prompt");
    assert.equal(systemPrompts[0], systemPrompts[1], "the system prompt is byte-identical across every request of the run");

    const outcome = messages[1].outcome;
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.summary, "Wrote the summary.");
    assert.deepEqual(outcome.evidence, ["Summary written in the reply."]);
    assert.equal(outcome.plan.goal, "Summarize the score", "the completed outcome still carries the final plan");
    assert.equal(outcome.budget.turns, 2, "one turn per provider request");
    assert.equal(outcome.budget.tokens, 500 + 60 + 520 + 40, "tokens are input + output + cache writes summed across every request");
    assert.equal(messages[1].content, "Done.", "the assistant's accompanying text is returned");
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
  });

  await t.test("request_input reports needs_input, and the next message continues with the restored plan", async () => {
    mock.reset();
    const conversation = await ai.new_conversation();
    mock.push({ content: [{ type: "tool_use", id: "toolu_5", name: "update_plan", input: { goal: "Import a project file", doneCriteria: ["File imported"], todos: [{ id: "t1", title: "Locate the file", status: "in_progress" }] } }], stopReason: "tool_use", usage: { input: 300, output: 20, cacheWrite: 0 } });
    mock.push({ content: [{ type: "tool_use", id: "toolu_6", name: "request_input", input: { question: "Which file should I import?", missing: ["source file path"] } }], stopReason: "tool_use", usage: { input: 310, output: 15, cacheWrite: 0 } });

    const firstTurn = await ai.send_message(conversation.id, "Import my project.", { cwd, effort: "mid" });
    const firstOutcome = firstTurn[1].outcome;
    assert.equal(firstOutcome.status, "needs_input");
    assert.deepEqual(firstOutcome.missing, ["source file path"]);
    assert.equal(firstOutcome.plan.goal, "Import a project file", "the plan is persisted alongside the needs_input outcome");

    mock.reset();
    mock.push({ content: [{ type: "tool_use", id: "toolu_7", name: "complete_task", input: { summary: "Imported the file.", evidence: ["Imported the provided file."] } }], stopReason: "tool_use", usage: { input: 50, output: 10, cacheWrite: 0 } });
    const secondTurn = await ai.send_message(conversation.id, "It's at ./song.svp", { cwd, effort: "mid" });
    assert.equal(mock.requests.length, 1, "complete_task succeeds without a fresh update_plan call, proving the plan carried over in-session");
    assert.equal(secondTurn[1].outcome.status, "completed");
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
  });

  await t.test("a provider HTTP 401 rejects send_message and persists nothing", async () => {
    mock.reset();
    const conversation = await ai.new_conversation();
    mock.push({ kind: "error", status: 401, errorType: "authentication_error", message: "e2e-401-marker" });

    await assert.rejects(
      () => ai.send_message(conversation.id, "Hello?", { cwd, effort: "mid" }),
      (error) => { assert.match(error.message, /e2e-401-marker/); return true; },
    );
    const reopened = await ai.open_conversation(conversation.id);
    assert.equal(reopened.messages.length, 0, "no assistant message is persisted when the provider call fails");
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

    const reopened = await ai.open_conversation(conversation.id);
    assert.equal(reopened.messages.length, 2, "a cancelled outcome is persisted like any other outcome");
  });
});
