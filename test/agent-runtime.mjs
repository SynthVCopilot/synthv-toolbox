import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname.slice(1);
const packageRoot = join(root, "packages", "agent-runtime");
const tsc = join(packageRoot, "node_modules", "typescript", "bin", "tsc");

if (!existsSync(tsc)) throw new Error("Agent Runtime dependencies are unavailable. Run npm install in packages/agent-runtime first.");
execFileSync(process.execPath, [tsc, "-p", join(packageRoot, "tsconfig.json")], { stdio: "inherit" });
const runtime = await import(`${pathToFileURL(join(packageRoot, "dist", "index.js")).href}?contract=${Date.now()}`);
const modelAuth = await import(pathToFileURL(join(packageRoot, "node_modules", "@model-auth", "core", "dist", "index.js")).href);

function request(id, method, params, protocolVersion = "1.0") {
  return JSON.stringify({ kind: "request", id, protocolVersion, method, params });
}

test("JSONL worker negotiates before creating, sending to and closing a Pi session", async () => {
  const prompts = [];
  let disposed = false;
  const worker = new runtime.AgentRuntimeWorker({
    create: async ({ sessionId }) => ({
      prompt: async (input) => { prompts.push(`${sessionId}:${input}`); },
      dispose: () => { disposed = true; },
    }),
  });

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
  assert.equal(JSON.parse((await worker.handleJsonl(request("4", "session.send", { sessionId: "s1", input: "hello" })))[0]).result.accepted, true);
  assert.deepEqual(prompts, ["s1:hello"]);
  assert.equal(JSON.parse((await worker.handleJsonl(request("5", "session.close", { sessionId: "s1" })))[0]).result.closed, true);
  assert.equal(disposed, true);
});

test("worker forwards explicit host-capability calls and plugin backends receive declared permissions", async () => {
  const calls = [];
  const host = { request: async (method, params) => { calls.push({ method, params }); return { succeeded: true }; } };
  const worker = new runtime.AgentRuntimeWorker({ create: async () => ({ prompt: async () => {}, dispose: () => {} }) }, host);
  assert.deepEqual(await worker.invokeHost("project", "read", { id: "project-1" }), { succeeded: true });

  let activated = false;
  let pluginContext;
  const manifest = {
    schemaVersion: 1,
    id: "com.example.tune",
    name: "Tune",
    version: "1.0.0",
    hostApi: { min: "1.0", max: "1.0" },
    backend: { entry: "backend/index.js" },
    permissions: ["project.read"],
  };
  const loaded = await runtime.loadPluginBackends("file:///plugins", [manifest], host, async () => ({
    activate: async (context) => {
      activated = true;
      pluginContext = context;
      await context.invokeHost("project.read", "project", "read", { id: "project-1" });
    },
  }));
  assert.equal(activated, true);
  assert.equal(loaded.length, 1);
  assert.equal(calls.filter(({ method }) => method === "host.capability.invoke").length, 2);
  await assert.rejects(
    () => pluginContext.invokeHost("project.write", "project", "write", {}),
    /has not declared/,
  );
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

test("stdio worker emits JSONL responses only and discovers compatible plugin backends", async () => {
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
    permissions: ["project.read"],
  }));
  writeFileSync(
    join(pluginRoot, "com.example.plugin", "backend", "index.js"),
    "export async function activate(context) { await context.invokeHost('project.read', 'project', 'read', { id: 'project-1' }); }\n",
  );

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
  child.stdin.write(`${request("plugins", "runtime.plugins.discover", { root: pluginRoot })}\n`);
  await waitFor(() => messages.some((message) => message.kind === "request" && message.method === "host.capability.invoke")
    && messages.some((message) => message.kind === "response" && message.id === "plugins"));
  assert.equal(messages.find((message) => message.kind === "response" && message.id === "hello").ok, true);
  assert.deepEqual(messages.find((message) => message.kind === "response" && message.id === "plugins").result.plugins.map((plugin) => plugin.id), ["com.example.plugin"]);

  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    child.once("exit", (code) => code === 0 || code === null ? resolve() : reject(new Error(`worker exited with ${code}`)));
  });
  assert.equal(stderrBuffer, "");
});

async function waitFor(predicate, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for the worker response.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
