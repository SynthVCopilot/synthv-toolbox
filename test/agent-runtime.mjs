import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
