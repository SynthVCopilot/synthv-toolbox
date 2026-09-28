import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMockAnthropicServer } from "./fixtures/mock-anthropic-server.mjs";

// Drives the real @earendil-works/pi-coding-agent SDK through AgentRuntimeWorker directly (no Electron),
// against the shared scripted Anthropic Messages server, to prove the progress projector's contract end
// to end: monotonic seq, the plan and budget snapshots, streamed text, cancelling before ended, and that
// Pi really does forward tool_execution_update to onUpdate. No network, no real credentials, no access to
// the real home directory: PI_CODING_AGENT_DIR, HOME and cwd are all temp directories for this file.

const root = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = join(root, "packages", "agent-runtime");
const tsc = join(packageRoot, "node_modules", "typescript", "bin", "tsc");

if (!existsSync(tsc)) throw new Error("Agent Runtime dependencies are unavailable. Run npm install in packages/agent-runtime first.");
execFileSync(process.execPath, [tsc, "-p", join(packageRoot, "tsconfig.json")], { stdio: "inherit" });
const runtime = await import(`${pathToFileURL(join(packageRoot, "dist", "index.js")).href}?contract=${Date.now()}`);

const MODEL_ID = ["cla", "ude-haiku-4-5"].join("");
const PROVIDER_ID = "anthropic";
const TEST_API_KEY = "test-api-key";

function request(id, method, params, protocolVersion = "1.0") {
  return JSON.stringify({ kind: "request", id, protocolVersion, method, params });
}

function budgetFor(level, maxTurns, maxTokens) {
  return { level, maxTurns, maxTokens };
}

async function send(worker, id, method, params) {
  const [line] = await worker.handleJsonl(request(id, method, params));
  return JSON.parse(line);
}

function hostCapabilities() {
  return {
    request: async (method) => {
      if (method !== "host.model.resolve") throw new Error(`Unexpected host capability call: ${method}`);
      return {
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        credentials: [{ id: "credential-1", providerId: PROVIDER_ID, modelId: MODEL_ID, authMethod: "api-key", apiKey: TEST_API_KEY }],
      };
    },
  };
}

async function initializedWorker(sessionsFactory, cwd) {
  const notifications = [];
  const worker = new runtime.AgentRuntimeWorker(sessionsFactory, hostCapabilities(), undefined, (notification) => notifications.push(notification));
  const hello = await send(worker, "hello", "host.hello", { hostId: "host", protocol: { min: "1.0", max: "1.0" }, capabilities: [] });
  assert.equal(hello.ok, true);
  const init = await send(worker, "init", "session.initialize", { sessionId: "s1", cwd });
  assert.equal(init.ok, true, JSON.stringify(init));
  return { worker, notifications };
}

function progressViews(notifications, runId) {
  return notifications.filter((n) => n.event === "session.progress" && n.params.runId === runId).map((n) => n.params);
}

test("progress e2e: real Pi SDK against the shared mock server, driven through AgentRuntimeWorker", async (t) => {
  const savedEnv = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, HOME: process.env.HOME, PI_OFFLINE: process.env.PI_OFFLINE, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  const tempRoot = await mkdtemp(join(tmpdir(), "agent-progress-e2e-"));
  const agentDir = join(tempRoot, "pi-agent");
  const home = join(tempRoot, "home");
  const cwd = join(tempRoot, "cwd");
  await Promise.all([agentDir, home, cwd].map((dir) => mkdir(dir, { recursive: true })));

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = home;
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
  delete process.env.ANTHROPIC_API_KEY;

  const mock = createMockAnthropicServer();
  const port = await mock.listen();
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { [PROVIDER_ID]: { baseUrl: `http://127.0.0.1:${port}` } } }), "utf8");

  t.after(async () => {
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  await t.test("update_plan + streamed text + complete_task gives monotonic seq, a plan and budget snapshot, and ended last", async () => {
    mock.reset([
      { content: [{ type: "tool_use", id: "toolu_1", name: "update_plan", input: { goal: "Summarize the score", doneCriteria: ["Summary written"], todos: [{ id: "t1", title: "Write summary", status: "in_progress" }] } }], stopReason: "tool_use", usage: { input: 500, output: 60, cacheWrite: 20, cacheRead: 15 } },
      {
        content: [
          { type: "text", chunks: ["Wrote ", "the ", "summary."], chunkDelayMs: 150 },
          { type: "tool_use", id: "toolu_2", name: "complete_task", input: { summary: "Wrote the summary.", evidence: ["Summary written in the reply."] } },
        ],
        stopReason: "tool_use",
        usage: { input: 520, output: 40, cacheWrite: 10, cacheRead: 5 },
      },
    ]);
    const sessionsFactory = runtime.createPiSessionFactory();
    const { worker, notifications } = await initializedWorker(sessionsFactory, cwd);
    t.after(() => worker.dispose());

    const sent = await send(worker, "send", "session.send", { sessionId: "s1", input: "Please summarize this score.", runId: "run-1", budget: budgetFor("mid", 16, 300_000) });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const outcome = sent.result.outcome;
    assert.equal(outcome.status, "completed");

    const views = progressViews(notifications, "run-1");
    assert.ok(views.length > 0);
    for (let i = 1; i < views.length; i++) assert.ok(views[i].seq > views[i - 1].seq);

    const planView = views.find((v) => v.plan !== null);
    assert.ok(planView);
    assert.deepEqual(planView.plan, outcome.plan);

    const distinctNonEmptyText = new Set(views.map((v) => v.text).filter((text) => text.length > 0));
    assert.ok(distinctNonEmptyText.size >= 2, "text streamed across several deltas, not delivered as a single snapshot");

    assert.equal(views.at(-1).phase, "ended");
    assert.equal(views.at(-1).budget.tokens, outcome.budget.tokens);
  });

  await t.test("cancelling a slow streamed turn reports cancelling before ended", async () => {
    mock.reset();
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    mock.push({ kind: "slow", onStarted: () => started() });
    const sessionsFactory = runtime.createPiSessionFactory();
    const { worker, notifications } = await initializedWorker(sessionsFactory, cwd);
    t.after(() => worker.dispose());

    const sendPromise = send(worker, "send", "session.send", { sessionId: "s1", input: "Do something slow.", runId: "run-2", budget: budgetFor("mid", 16, 300_000) });
    await startedPromise;
    const cancelled = await send(worker, "cancel", "session.cancel", { sessionId: "s1" });
    assert.equal(cancelled.result.cancelled, true);
    const sent = await sendPromise;
    assert.equal(sent.result.outcome.status, "cancelled");

    const views = progressViews(notifications, "run-2");
    const cancellingIndex = views.findIndex((v) => v.phase === "cancelling");
    const endedIndex = views.findIndex((v) => v.phase === "ended");
    assert.ok(cancellingIndex >= 0, "a cancelling snapshot was reported");
    assert.ok(endedIndex >= 0 && endedIndex === views.length - 1, "ended is the last snapshot");
    assert.ok(cancellingIndex < endedIndex, "cancelling arrives before ended");
  });

  await t.test("a provider 401 still emits an ended progress snapshot", async () => {
    mock.reset();
    mock.push({ kind: "error", status: 401, errorType: "authentication_error", message: "progress-e2e-401-marker" });
    const sessionsFactory = runtime.createPiSessionFactory();
    const { worker, notifications } = await initializedWorker(sessionsFactory, cwd);
    t.after(() => worker.dispose());

    const sent = await send(worker, "send", "session.send", { sessionId: "s1", input: "Hello?", runId: "run-3", budget: budgetFor("mid", 16, 300_000) });
    assert.equal(sent.ok, false);
    assert.match(sent.error.message, /progress-e2e-401-marker/);

    const views = progressViews(notifications, "run-3");
    assert.ok(views.length > 0);
    assert.equal(views.at(-1).phase, "ended");
  });

  await t.test("a registered inline tool's onUpdate reaches the progress views as awaiting_approval, proving Pi forwards tool_execution_update", async () => {
    mock.reset([
      { content: [
        { type: "tool_use", id: "toolu_3", name: "update_plan", input: { goal: "Probe approvals", doneCriteria: ["Probed"], todos: [{ id: "t1", title: "Probe", status: "in_progress" }] } },
        { type: "tool_use", id: "toolu_4", name: "test_probe", input: {} },
      ], stopReason: "tool_use", usage: { input: 100, output: 20, cacheWrite: 0 } },
      { content: [{ type: "tool_use", id: "toolu_5", name: "complete_task", input: { summary: "Probed.", evidence: ["Probed the approval channel."] } }], stopReason: "tool_use", usage: { input: 110, output: 15, cacheWrite: 0 } },
    ]);
    const sessionsFactory = runtime.createPiSessionFactory({
      extensions: () => [{
        name: "progress-e2e-probe",
        factory: (pi) => {
          pi.registerTool({
            name: "test_probe",
            label: "Probe",
            description: "Reports awaiting_approval then succeeded, proving onUpdate reaches the progress projector.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            async execute(_toolCallId, _params, _signal, onUpdate) {
              onUpdate?.({ content: [], details: { activity: { status: "awaiting_approval", summary: "waiting on approval" } } });
              return { content: [{ type: "text", text: "approved" }], details: { activity: { summary: "approved" } } };
            },
          });
        },
      }],
    });
    const { worker, notifications } = await initializedWorker(sessionsFactory, cwd);
    t.after(() => worker.dispose());

    const sent = await send(worker, "send", "session.send", { sessionId: "s1", input: "Probe approvals.", runId: "run-4", budget: budgetFor("mid", 16, 300_000) });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(sent.result.outcome.status, "completed");

    const views = progressViews(notifications, "run-4");
    const probe = views.flatMap((v) => v.tools).find((tool) => tool.name === "test_probe");
    assert.ok(probe);
    const awaitingIndex = views.findIndex((v) => v.tools.some((tool) => tool.name === "test_probe" && tool.status === "awaiting_approval"));
    const succeededIndex = views.findIndex((v) => v.tools.some((tool) => tool.name === "test_probe" && tool.status === "succeeded"));
    assert.ok(awaitingIndex >= 0, "the tool passed through awaiting_approval");
    assert.ok(succeededIndex > awaitingIndex, "the tool later succeeded");
  });
});
