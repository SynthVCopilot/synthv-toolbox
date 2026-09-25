import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = join(root, "packages", "agent-runtime");
const tsc = join(packageRoot, "node_modules", "typescript", "bin", "tsc");

if (!existsSync(tsc)) throw new Error("Agent Runtime dependencies are unavailable. Run npm install in packages/agent-runtime first.");
execFileSync(process.execPath, [tsc, "-p", join(packageRoot, "tsconfig.json")], { stdio: "inherit" });
const runtime = await import(`${pathToFileURL(join(packageRoot, "dist", "index.js")).href}?contract=${Date.now()}`);
const modelAuth = await import(pathToFileURL(join(packageRoot, "node_modules", "@model-auth", "core", "dist", "index.js")).href);

const CONTEXT_WINDOW = 325_542;

function request(id, method, params, protocolVersion = "1.0") {
  return JSON.stringify({ kind: "request", id, protocolVersion, method, params });
}

function placeholderOutcome() {
  return {
    status: "incomplete",
    summary: "",
    evidence: [],
    missing: [],
    plan: null,
    budget: { level: "mid", maxTurns: 10, maxTokens: 100_000, turns: 0, tokens: 0 },
  };
}

/**
 * A fake PiSdk driving the real extensionFactories/tools the runtime installs, so tests exercise the
 * actual update_plan/complete_task/request_input tools and the before_agent_start/turn_end/tool_call hooks.
 * `rounds` is consumed one entry per session.prompt() call (initial call plus every auto-continuation).
 */
function createFakeSdk(rounds) {
  const pending = [...rounds];
  const tools = new Map();
  const handlers = { before_agent_start: [], turn_end: [], tool_call: [] };
  const messages = [];
  const settingsOverrides = [];
  const systemPrompts = [];
  let thinkingLevel;
  let disposed = false;
  let contextWindow = CONTEXT_WINDOW;

  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    on(event, handler) { handlers[event].push(handler); },
  };

  async function runToolCallHandlers(toolName) {
    let final;
    for (const handler of handlers.tool_call) {
      const result = await handler({ toolName });
      if (result) final = result;
    }
    return final;
  }

  const session = {
    setThinkingLevel(level) { thinkingLevel = level; },
    messages,
    async prompt(text) {
      messages.push({ role: "user", content: [{ type: "text", text }] });
      let systemPrompt = "BASE SYSTEM PROMPT";
      for (const handler of handlers.before_agent_start) {
        const result = await handler({ systemPrompt });
        if (result && typeof result.systemPrompt === "string") systemPrompt = result.systemPrompt;
      }
      systemPrompts.push(systemPrompt);

      if (pending.length === 0) throw new Error("fake sdk: no more scripted rounds");
      const round = pending.shift();
      // A single session.prompt() call can drive several internal turns (Pi's own tool-use loop);
      // `round.turns` models that. A flat round is sugar for one turn.
      const turnDefs = round.turns ?? [{ toolCalls: round.toolCalls, text: round.text, usage: round.usage }];
      for (const turnDef of turnDefs) {
        let terminated = false;
        for (const call of turnDef.toolCalls ?? []) {
          const blocked = await runToolCallHandlers(call.name);
          if (blocked && blocked.block) {
            messages.push({ role: "toolResult", toolName: call.name, content: [{ type: "text", text: blocked.reason ?? "" }], isError: true });
            if (blocked.terminate) terminated = true;
            continue;
          }
          const tool = tools.get(call.name);
          let result;
          try {
            result = await tool.execute("call-id", call.args);
          } catch (error) {
            result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
          }
          messages.push({ role: "toolResult", toolName: call.name, content: result.content, details: result.details, isError: Boolean(result.isError) });
          if (result.terminate) terminated = true;
        }

        const assistantMessage = {
          role: "assistant",
          content: turnDef.text ? [{ type: "text", text: turnDef.text }] : [],
          ...(turnDef.usage ? { usage: turnDef.usage } : {}),
        };
        messages.push(assistantMessage);
        for (const handler of handlers.turn_end) await handler({ message: assistantMessage });
        if (terminated) break;
      }
    },
    dispose() { disposed = true; },
  };

  const sdk = {
    getAgentDir: () => "/agent",
    SettingsManager: { create: () => ({ applyOverrides: (overrides) => settingsOverrides.push(overrides) }) },
    DefaultResourceLoader: class {
      constructor(options) { this.options = options; }
      async reload() {
        for (const extension of this.options.extensionFactories ?? []) await extension.factory(pi);
      }
    },
    ModelRuntime: {
      create: async () => ({
        setRuntimeApiKey: async () => {},
        getModel: () => ({ contextWindow }),
      }),
    },
    createAgentSession: async () => ({ session }),
  };

  return {
    sdk,
    tools,
    messages,
    settingsOverrides,
    systemPrompts,
    get thinkingLevel() { return thinkingLevel; },
    get disposed() { return disposed; },
    get remainingRounds() { return pending.length; },
    setContextWindow(value) { contextWindow = value; },
  };
}

test("JSONL worker negotiates before creating, sending to and closing a Pi session", async () => {
  const prompts = [];
  let disposed = false;
  const worker = new runtime.AgentRuntimeWorker({
    create: async ({ sessionId, model }) => ({
      prompt: async (input) => { prompts.push(`${sessionId}:${model.providerId}:${input}`); return { message: "assistant reply", outcome: placeholderOutcome() }; },
      dispose: () => { disposed = true; },
    }),
  }, { request: async (method) => method === "host.model.resolve" ? {
    providerId: "openai", modelId: "gpt-4.1", credentials: [{ id: "credential-1", providerId: "openai", modelId: "gpt-4.1", authMethod: "api-key", apiKey: "temporary" }],
  } : {} });

  const beforeHello = JSON.parse((await worker.handleJsonl(request("1", "session.initialize", { sessionId: "s1" })))[0]);
  assert.equal(beforeHello.error.code, "protocol.not-negotiated");

  const hello = JSON.parse((await worker.handleJsonl(request("2", "host.hello", {
    hostId: "native-host",
    protocol: { min: "1.0", max: "1.0" },
    capabilities: [],
  })))[0]);
  assert.equal(hello.ok, true);
  assert.equal(hello.result.runtimeId, runtime.AGENT_RUNTIME_ID);

  assert.equal(JSON.parse((await worker.handleJsonl(request("3", "session.initialize", { sessionId: "s1" })))[0]).ok, true);
  const sent = JSON.parse((await worker.handleJsonl(request("4", "session.send", { sessionId: "s1", input: "hello" })))[0]);
  assert.equal(sent.result.accepted, true);
  assert.equal(sent.result.message, "assistant reply");
  assert.equal(sent.result.outcome.status, "incomplete");
  assert.deepEqual(prompts, ["s1:openai:hello"]);
  assert.equal(JSON.parse((await worker.handleJsonl(request("5", "session.close", { sessionId: "s1" })))[0]).result.closed, true);
  assert.equal(disposed, true);
});

test("session.initialize rejects an invalid plan and session.send rejects an invalid budget", async () => {
  const worker = new runtime.AgentRuntimeWorker(
    { create: async () => ({ prompt: async () => ({ message: "", outcome: placeholderOutcome() }), dispose: () => {} }) },
    { request: async (method) => method === "host.model.resolve" ? {
      providerId: "openai", modelId: "gpt-4.1", credentials: [{ id: "credential-1", providerId: "openai", modelId: "gpt-4.1", authMethod: "api-key", apiKey: "temporary" }],
    } : {} },
  );
  await worker.handleJsonl(request("hello", "host.hello", { hostId: "host", protocol: { min: "1.0", max: "1.0" }, capabilities: [] }));

  const badPlan = JSON.parse((await worker.handleJsonl(request("init", "session.initialize", { sessionId: "s1", plan: { goal: "" } })))[0]);
  assert.equal(badPlan.ok, false);
  assert.equal(badPlan.error.code, "session.invalid");

  assert.equal(JSON.parse((await worker.handleJsonl(request("init2", "session.initialize", { sessionId: "s1" })))[0]).ok, true);
  const badBudget = JSON.parse((await worker.handleJsonl(request("send", "session.send", { sessionId: "s1", input: "hi", budget: { level: "mid", maxTurns: null, maxTokens: null } })))[0]);
  assert.equal(badBudget.ok, false);
  assert.equal(badBudget.error.code, "session.invalid");
});

test("worker forwards explicit host-capability calls and plugin backends receive declared permissions", async () => {
  const calls = [];
  const host = { request: async (method, params) => { calls.push({ method, params }); return { succeeded: true }; } };
  const worker = new runtime.AgentRuntimeWorker({ create: async () => ({ prompt: async () => ({ message: "", outcome: placeholderOutcome() }), dispose: () => {} }) }, host);
  assert.deepEqual(await worker.invokeHost("host.read", "project", "read", { id: "project-1" }), { succeeded: true });

  let activated = false;
  let pluginContext;
  const manifest = {
    schemaVersion: 1,
    id: "com.example.tune",
    name: "Tune",
    version: "1.0.0",
    hostApi: { min: "1.0", max: "1.0" },
    backend: { entry: "backend/index.js" },
    permissions: { "project.read": "required" },
  };
  const loaded = await runtime.loadPluginBackends(pathToFileURL(join(root, "test", ".tmp", "virtual-plugin-root")).href, [manifest], host, async () => ({
    default: () => {},
    activate: async (context) => {
      activated = true;
      pluginContext = context;
      await context.invokeHost("project.read", "project", "read", { id: "project-1" });
    },
    invoke: async (context, method, params) => {
      await context.invokeHost("project.read", "project", "read", { id: "project-1" });
      return { method, params };
    },
  }));
  assert.equal(activated, true);
  assert.equal(loaded.length, 1);
  assert.equal(calls.filter(({ method }) => method === "host.capability.invoke").length, 2);
  assert.equal(calls.find(({ params }) => params.pluginId === manifest.id).params.permissionLevel, "required");
  await assert.rejects(
    () => pluginContext.invokeHost("project.write", "project", "write", {}),
    /has not declared/,
  );

  assert.equal(loaded[0].piExtensionPath, loaded[0].entryPath);
  const pluginDiscovery = {
    discover: async () => [manifest],
    extensionPaths: () => [loaded[0].piExtensionPath],
    invoke: async (pluginId, method, params) => {
      const plugin = loaded.find(({ manifest: item }) => item.id === pluginId);
      if (!plugin) return { kind: "not-found" };
      if (!plugin.invoke) return { kind: "unsupported" };
      return { kind: "handled", result: await plugin.invoke(method, params) };
    },
  };
  const pluginWorker = new runtime.AgentRuntimeWorker({ create: async () => ({ prompt: async () => ({ message: "", outcome: placeholderOutcome() }), dispose: () => {} }) }, host, pluginDiscovery);
  await pluginWorker.handleJsonl(request("plugin-hello", "host.hello", { hostId: "host", protocol: { min: "1.0", max: "1.0" }, capabilities: [] }));
  const discovered = JSON.parse((await pluginWorker.handleJsonl(request("plugin-discover", "runtime.plugins.discover", {
    root: "C:/plugins", enabledPluginIds: [manifest.id],
  })))[0]);
  assert.deepEqual(discovered.result.plugins, [manifest]);
  const invoked = JSON.parse((await pluginWorker.handleJsonl(request("plugin-invoke", "runtime.plugin.invoke", {
    pluginId: manifest.id,
    method: "run",
    params: { strength: 5 },
  })))[0]);
  assert.deepEqual(invoked.result, { method: "run", params: { strength: 5 } });
  const unknown = JSON.parse((await pluginWorker.handleJsonl(request("plugin-missing", "runtime.plugin.invoke", {
    pluginId: "com.example.missing",
    method: "run",
    params: {},
  })))[0]);
  assert.equal(unknown.error.code, "plugins.not-found");
});

test("Pi session factory injects discovered default extension paths into the resource loader", async () => {
  let loaderOptions;
  let createOptions;
  const session = { prompt: async () => {}, setThinkingLevel: () => {}, messages: [], dispose: () => {} };
  const factory = runtime.createPiSessionFactory(
    () => ["C:/plugins/com.example/backend/index.js"],
    async () => ({
      getAgentDir: () => "C:/agent",
      SettingsManager: { create: () => ({ applyOverrides: () => {} }) },
      DefaultResourceLoader: class {
        constructor(options) { loaderOptions = options; }
        async reload() {}
      },
      ModelRuntime: {
        create: async () => ({
          setRuntimeApiKey: async () => {},
          getModel: () => ({ id: "model-1", contextWindow: 200_000 }),
        }),
      },
      createAgentSession: async (options) => { createOptions = options; return { session }; },
    }),
  );
  const created = await factory.create({ sessionId: "s1", cwd: "C:/project", model: { providerId: "example", modelId: "model-1", apiKey: "temporary" } });
  assert.equal(typeof created.prompt, "function");
  assert.deepEqual(loaderOptions.additionalExtensionPaths, ["C:/plugins/com.example/backend/index.js"]);
  assert.equal(loaderOptions.extensionFactories.length, 1);
  assert.equal(loaderOptions.extensionFactories[0].name, "synthv-task-loop");
  assert.equal(createOptions.resourceLoader instanceof Object, true);
  assert.equal(createOptions.noTools, "builtin");
  assert.deepEqual(createOptions.model, { id: "model-1", contextWindow: 200_000 });
  assert.equal(createOptions.modelRuntime instanceof Object, true);
  assert.equal(createOptions.settingsManager instanceof Object, true);
});

test("model auth uses adapter request contracts and reports missing stream support", async () => {
  const credential = modelAuth.createCredentialMetadata({
    id: "credential-1",
    providerId: "example",
    authMethod: "api-key",
    modelIds: ["model-1"],
  });
  const gateway = new runtime.ModelAuthGateway([credential], new Map([[
    "example",
    {
      remove: async () => {},
      request: async (credentialId, requestValue) => ({ output: `${credentialId}:${requestValue.modelId}` }),
    },
  ]]));
  const result = await gateway.request("example", { modelId: "model-1", input: "hi" });
  assert.deepEqual(result, { kind: "ok", value: { output: "credential-1:model-1" } });
  const stream = await gateway.stream("example", { modelId: "model-1", input: "hi" });
  assert.equal(stream.kind, "unsupported");
});

test("session initialization rejects a host model selection without credentials", async () => {
  const worker = new runtime.AgentRuntimeWorker(
    { create: async () => ({ prompt: async () => ({ message: "", outcome: placeholderOutcome() }), dispose: () => {} }) },
    { request: async () => ({ providerId: "openai", modelId: "gpt-4.1", credentials: [] }) },
  );
  await worker.handleJsonl(request("hello", "host.hello", { hostId: "host", protocol: { min: "1.0", max: "1.0" }, capabilities: [] }));
  const response = JSON.parse((await worker.handleJsonl(request("init", "session.initialize", { sessionId: "s1" })))[0]);
  assert.equal(response.ok, false);
  assert.match(response.error.message, /No eligible credential/);
});

test("stdio worker emits JSONL responses and discovers backend and UI-only plugins", async () => {
  const pluginRoot = join(root, "test", ".tmp", "agent-runtime-cli-plugins");
  rmSync(pluginRoot, { recursive: true, force: true });
  mkdirSync(join(pluginRoot, "com.example.plugin", "backend"), { recursive: true });
  writeFileSync(join(pluginRoot, "com.example.plugin", "package.json"), '{"type":"module"}\n');
  writeFileSync(join(pluginRoot, "com.example.plugin", "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    id: "com.example.plugin",
    name: "Example plugin",
    version: "1.0.0",
    hostApi: { min: "1.0", max: "1.0" },
    backend: { entry: "backend/index.js" },
    permissions: { "project.read": "optional" },
  }));
  writeFileSync(
    join(pluginRoot, "com.example.plugin", "backend", "index.js"),
    "export async function activate(context) { await context.invokeHost('project.read', 'project', 'read', { id: 'project-1' }); }\n",
  );
  mkdirSync(join(pluginRoot, "com.example.ui"), { recursive: true });
  writeFileSync(join(pluginRoot, "com.example.ui", "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    id: "com.example.ui",
    name: "Example UI plugin",
    version: "1.0.0",
    hostApi: { min: "1.0", max: "1.0" },
    pages: [{ id: "main", title: "Example", entry: "ui/index.html" }],
  }));

  const workerPath = join(packageRoot, "dist", "worker.js");
  const child = spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdoutBuffer = "";
  let stderrBuffer = "";
  const messages = [];
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line);
      messages.push(message);
      if (message.kind === "request" && message.method === "host.capability.invoke") {
        child.stdin.write(`${JSON.stringify({
          kind: "response",
          id: message.id,
          protocolVersion: message.protocolVersion,
          ok: true,
          result: { granted: true },
        })}\n`);
      }
    }
  });
  child.stderr.on("data", (chunk) => { stderrBuffer += chunk; });

  child.stdin.write(`${request("hello", "host.hello", { hostId: "host", protocol: { min: "1.0", max: "1.0" }, capabilities: [] })}\n`);
  child.stdin.write(`${request("plugins", "runtime.plugins.discover", { root: pluginRoot, enabledPluginIds: ["com.example.plugin"] })}\n`);
  await waitFor(() => messages.some((message) => message.kind === "request" && message.method === "host.capability.invoke")
    && messages.some((message) => message.kind === "response" && message.id === "plugins"));
  assert.equal(messages.find((message) => message.kind === "response" && message.id === "hello").ok, true);
  assert.deepEqual(
    messages.find((message) => message.kind === "response" && message.id === "plugins").result.plugins.map((plugin) => plugin.id).sort(),
    ["com.example.plugin"],
  );

  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    child.once("exit", (code) => code === 0 || code === null ? resolve() : reject(new Error(`worker exited with ${code}`)));
  });
  assert.equal(stderrBuffer, "");
});

// --- PiSession task loop, driven through the real extension against a fake Pi SDK ---

async function createSession(fake, extra = {}) {
  const factory = runtime.createPiSessionFactory(() => [], async () => fake.sdk);
  return factory.create({ sessionId: "s1", cwd: "/project", model: { providerId: "example", modelId: "model-1", apiKey: "temporary" }, ...extra });
}

function budgetFor(level, maxTurns, maxTokens) {
  return { level, maxTurns, maxTokens };
}

test("completed flow records evidence and summary, falling back when the final turn has no text", async () => {
  const fake = createFakeSdk([
    { toolCalls: [
      { name: "update_plan", args: { goal: "Ship the mix", doneCriteria: ["Mix exported"], todos: [{ id: "t1", title: "Export mix", status: "in_progress" }] } },
      { name: "complete_task", args: { summary: "Exported the mix.", evidence: ["mix.wav written"] } },
    ] },
  ]);
  const session = await createSession(fake);
  const { message, outcome } = await session.prompt("Export the mix", budgetFor("mid", 16, 300_000));
  assert.equal(outcome.status, "completed");
  assert.deepEqual(outcome.evidence, ["mix.wav written"]);
  assert.equal(outcome.summary, "Exported the mix.");
  assert.equal(outcome.plan.goal, "Ship the mix");
  assert.equal(message, "Exported the mix.");
});

test("complete_task is rejected without a plan and with the wrong evidence count, then succeeds", async () => {
  const fake = createFakeSdk([
    { toolCalls: [{ name: "complete_task", args: { summary: "Done", evidence: ["a"] } }], text: "trying" },
    { toolCalls: [
      { name: "update_plan", args: { goal: "Two criteria", doneCriteria: ["A", "B"], todos: [{ id: "t1", title: "Do it", status: "pending" }] } },
      { name: "complete_task", args: { summary: "Bad count", evidence: ["only-one"] } },
    ], text: "retry" },
    { toolCalls: [{ name: "complete_task", args: { summary: "All done", evidence: ["a done", "b done"] } }] },
  ]);
  const session = await createSession(fake);
  const { outcome } = await session.prompt("Do two things", budgetFor("mid", 16, 300_000));
  assert.equal(outcome.status, "completed");
  assert.deepEqual(outcome.evidence, ["a done", "b done"]);
  const toolResults = fake.messages.filter((m) => m.role === "toolResult" && m.toolName === "complete_task");
  assert.equal(toolResults.length, 3);
  assert.equal(toolResults[0].isError, true);
  assert.match(toolResults[0].content[0].text, /update_plan/);
  assert.equal(toolResults[1].isError, true);
  assert.match(toolResults[1].content[0].text, /exactly 2 entries/);
  assert.equal(toolResults[2].isError, false);
});

test("pending todos do not block complete_task", async () => {
  const fake = createFakeSdk([
    { toolCalls: [
      { name: "update_plan", args: { goal: "G", doneCriteria: ["C1"], todos: [{ id: "t1", title: "Pending step", status: "pending" }] } },
      { name: "complete_task", args: { summary: "Done anyway", evidence: ["evidence"] } },
    ] },
  ]);
  const session = await createSession(fake);
  const { outcome } = await session.prompt("Go", budgetFor("mid", 16, 300_000));
  assert.equal(outcome.status, "completed");
});

test("request_input ends the run as needs_input with missing items", async () => {
  const fake = createFakeSdk([
    { toolCalls: [{ name: "request_input", args: { question: "Which song?", missing: ["target song"] } }] },
  ]);
  const session = await createSession(fake);
  const { outcome, message } = await session.prompt("Tune the vocals", budgetFor("mid", 16, 300_000));
  assert.equal(outcome.status, "needs_input");
  assert.equal(outcome.summary, "Which song?");
  assert.deepEqual(outcome.missing, ["target song"]);
  assert.deepEqual(outcome.evidence, []);
  assert.equal(message, "Which song?");
});

test("the runtime auto-continues after a text-only round and the continuation prompt reports budget usage", async () => {
  const fake = createFakeSdk([
    { text: "Thinking about it", usage: { input: 100, output: 50, cacheWrite: 0 } },
    { toolCalls: [{ name: "update_plan", args: { goal: "G", doneCriteria: ["C"], todos: [{ id: "t1", title: "Step", status: "in_progress" }] } }, { name: "complete_task", args: { summary: "Done", evidence: ["done"] } }] },
  ]);
  const session = await createSession(fake);
  const { outcome } = await session.prompt("Go", budgetFor("mid", 16, 300_000));
  assert.equal(outcome.status, "completed");
  const userMessages = fake.messages.filter((m) => m.role === "user");
  assert.equal(userMessages.length, 2);
  assert.match(userMessages[1].content[0].text, /Budget used: 1 of 16 turns, 150 of 300000 tokens used\./);
});

test("the idle-continuation limit stops the run as incomplete; low allows exactly one idle continuation", async () => {
  const fake = createFakeSdk([
    { text: "still thinking" },
    { text: "still thinking again" },
  ]);
  const session = await createSession(fake);
  const { outcome } = await session.prompt("Go", budgetFor("low", 16, 300_000));
  assert.equal(outcome.status, "incomplete");
  assert.equal(fake.remainingRounds, 0);
});

test("budget exhaustion by turns blocks non-terminating tools with terminate and ends budget_exhausted", async () => {
  const fake = createFakeSdk([
    { turns: [
      { text: "warm up" },
      { toolCalls: [{ name: "some_other_tool", args: {} }] },
    ] },
  ]);
  fake.tools.set("some_other_tool", { execute: async () => ({ content: [{ type: "text", text: "should not run" }] }) });
  const session = await createSession(fake);
  const { outcome } = await session.prompt("Go", budgetFor("mid", 1, 300_000));
  assert.equal(outcome.status, "budget_exhausted");
  assert.equal(outcome.summary, "");
  const blocked = fake.messages.find((m) => m.role === "toolResult" && m.toolName === "some_other_tool");
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /Run budget exhausted/);
});

test("budget exhaustion by tokens also blocks further tool calls and ends budget_exhausted", async () => {
  const fake = createFakeSdk([
    { turns: [
      { text: "burning tokens", usage: { input: 200_000, output: 50_000, cacheWrite: 0 } },
      { toolCalls: [{ name: "some_other_tool", args: {} }] },
    ] },
  ]);
  fake.tools.set("some_other_tool", { execute: async () => ({ content: [{ type: "text", text: "should not run" }] }) });
  const session = await createSession(fake);
  const { outcome } = await session.prompt("Go", budgetFor("mid", 16, 200_000));
  assert.equal(outcome.status, "budget_exhausted");
  const blocked = fake.messages.find((m) => m.role === "toolResult" && m.toolName === "some_other_tool");
  assert.equal(blocked.isError, true);
});

test("max level runs unlimited with xhigh thinking and a 16384 reserve", async () => {
  const fake = createFakeSdk([
    { toolCalls: [{ name: "update_plan", args: { goal: "G", doneCriteria: ["C"], todos: [{ id: "t1", title: "Step", status: "in_progress" }] } }, { name: "complete_task", args: { summary: "Done", evidence: ["done"] } }] },
  ]);
  const session = await createSession(fake);
  const { outcome } = await session.prompt("Go", budgetFor("max", null, null));
  assert.equal(outcome.status, "completed");
  assert.equal(fake.thinkingLevel, "xhigh");
  const compaction = fake.settingsOverrides.at(-1).compaction;
  assert.equal(compaction.reserveTokens, 16_384);
  assert.equal(compaction.enabled, true);
});

test("low level's compaction override is derived from the model context window", async () => {
  const fake = createFakeSdk([
    { toolCalls: [{ name: "update_plan", args: { goal: "G", doneCriteria: ["C"], todos: [{ id: "t1", title: "Step", status: "in_progress" }] } }, { name: "complete_task", args: { summary: "Done", evidence: ["done"] } }] },
  ]);
  const session = await createSession(fake);
  await session.prompt("Go", budgetFor("low", 16, 300_000));
  const compaction = fake.settingsOverrides.at(-1).compaction;
  const expectedReserve = Math.max(16_384, Math.round(CONTEXT_WINDOW * (1 - 0.5)));
  assert.equal(compaction.reserveTokens, expectedReserve);
  assert.equal(compaction.keepRecentTokens, Math.min(12_000, Math.floor((CONTEXT_WINDOW - expectedReserve) / 2)));
  assert.equal(fake.thinkingLevel, "low");
});

test("update_plan after complete_task clears the recorded signal", async () => {
  const fake = createFakeSdk([
    { toolCalls: [
      { name: "update_plan", args: { goal: "G", doneCriteria: ["C"], todos: [{ id: "t1", title: "Step", status: "in_progress" }] } },
      { name: "complete_task", args: { summary: "Done", evidence: ["done"] } },
      { name: "update_plan", args: { goal: "G2", doneCriteria: ["C2"], todos: [{ id: "t2", title: "Step2", status: "in_progress" }] } },
    ] },
    { toolCalls: [{ name: "complete_task", args: { summary: "Done2", evidence: ["done2"] } }] },
  ]);
  const session = await createSession(fake);
  const { outcome } = await session.prompt("Go", budgetFor("mid", 16, 300_000));
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.plan.goal, "G2");
  assert.equal(outcome.summary, "Done2");
});

test("a seeded plan from session.initialize appears in the before_agent_start section; an invalid plan is rejected", async () => {
  const fake = createFakeSdk([
    { toolCalls: [{ name: "complete_task", args: { summary: "Done", evidence: ["done"] } }] },
  ]);
  const seededPlan = { goal: "Seeded goal", doneCriteria: ["Criterion"], todos: [{ id: "t1", title: "Step", status: "pending" }] };
  const session = await createSession(fake, { plan: seededPlan });
  await session.prompt("Continue", budgetFor("mid", 16, 300_000));
  assert.match(fake.systemPrompts[0], /Seeded goal/);
});

test("session.initialize rejects an invalid seeded plan via the worker", async () => {
  const created = [];
  const worker = new runtime.AgentRuntimeWorker(
    { create: async (input) => { created.push(input); return { prompt: async () => ({ message: "", outcome: placeholderOutcome() }), dispose: () => {} }; } },
    { request: async () => ({ providerId: "openai", modelId: "gpt-4.1", credentials: [{ id: "c1", providerId: "openai", modelId: "gpt-4.1", authMethod: "api-key", apiKey: "k" }] }) },
  );
  await worker.handleJsonl(request("hello", "host.hello", { hostId: "host", protocol: { min: "1.0", max: "1.0" }, capabilities: [] }));
  const response = JSON.parse((await worker.handleJsonl(request("init", "session.initialize", { sessionId: "s1", plan: { goal: "" } })))[0]);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "session.invalid");
  assert.equal(created.length, 0);
});

test("the run message never reuses a previous run's text", async () => {
  const fake = createFakeSdk([
    { text: "first run text" },
    { text: "second run text" },
  ]);
  const session = await createSession(fake);
  const first = await session.prompt("Go", budgetFor("low", 1, 300_000));
  assert.equal(first.message, "first run text");
  const second = await session.prompt("Go again", budgetFor("low", 1, 300_000));
  assert.equal(second.message, "second run text");
  assert.notEqual(second.message, first.message);
});

async function waitFor(predicate, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for the worker response.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
