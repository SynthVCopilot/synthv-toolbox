import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = readFileSync(new URL("../src/PiDesktop.Tauri/electron/services/runtime-host.ts", import.meta.url), "utf8");

test("Electron runtime host keeps privileged MCP tools server-assigned", () => {
  assert.match(source, /toolbox_internal/);
  assert.match(source, /toolbox_advanced/);
  assert.match(source, /"permission" in args/);
  assert.match(source, /mcpInternalFunctionsEnabled/);
  assert.match(source, /mcpAdvancedFunctionsEnabled/);
  assert.match(source, /pluginInternalFunctionsEnabled/);
  assert.match(source, /pluginAdvancedFunctionsEnabled/);
  assert.match(source, /Plugin host requests require pluginId/);
  assert.match(source, /pluginPermissionLevel\(manifest, permission\) === "none"/);
});

test("A real ElectronRuntimeHost resolves the model through AiService and drives an agent session end to end", async (t) => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const tauriRoot = join(root, "src/PiDesktop.Tauri");
  const runtimeProtocolUrl = pathToFileURL(join(root, "packages/runtime-protocol/dist/index.js")).href;
  const agentRuntimeUrl = pathToFileURL(join(root, "packages/agent-runtime/dist/index.js")).href;
  const modelAuthCoreUrl = pathToFileURL(join(tauriRoot, "node_modules/@model-auth/core/dist/index.js")).href;

  const loadModule = async (relativePath, extraReplacements = []) => {
    const raw = await readFile(join(tauriRoot, relativePath), "utf8");
    let text = raw
      .replace('from "@synthv-toolbox/runtime-protocol";', `from "${runtimeProtocolUrl}";`)
      .replace('from "@synthv-toolbox/agent-runtime";', `from "${agentRuntimeUrl}";`)
      .replace('from "@model-auth/core";', `from "${modelAuthCoreUrl}";`)
    .replace('from "./local-credential-store.js";', `from "${pathToFileURL(join(tauriRoot, "dist/electron/services/local-credential-store.js")).href}";`);
    for (const [search, replace] of extraReplacements) text = text.replace(search, replace);
    const executable = stripTypeScriptTypes(text, { mode: "transform" });
    return import(`data:text/javascript;base64,${Buffer.from(executable).toString("base64")}`);
  };

  const { AiService, agentRuntimePort } = await loadModule("electron/services/ai-service.ts");
  const { ElectronRuntimeHost } = await loadModule("electron/services/runtime-host.ts");

  const directory = await mkdtemp(join(tmpdir(), "electron-runtime-host-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalog = {
    async models() { return [["cla", "ude-opus-4-8"].join("")]; },
    async opencode() { return {}; },
  };

  const runtimeHost = new ElectronRuntimeHost(
    join(directory, "runtime"),
    { invoke: () => { throw new Error("not used in this test"); }, resolveModel: () => ai.resolveModelSelection() },
    { sessionFactory: {
      async create() {
        return {
          async prompt(input, budget) {
            return {
              message: `Handled: ${input}`,
              outcome: {
                status: "completed",
                summary: "Done.",
                evidence: ["Replied to the prompt."],
                missing: [],
                plan: { goal: "Reply to the test prompt.", doneCriteria: ["Replied to the prompt."], todos: [{ id: "reply", title: "Reply to the prompt.", status: "completed" }] },
                budget: { ...budget, turns: 1, tokens: 100, uncachedInputTokens: 0, cacheReadTokens: 0 },
              },
            };
          },
          dispose() {},
        };
      },
    } },
  );
  const ai = new AiService({
    metadataPath: join(directory, "ai.json"),
    runtime: agentRuntimePort(runtimeHost.runtime),
    catalog,
    approvals: { cancelConversation() {} },
    id: () => `id-${Math.random()}`,
  });

  await ai.add_ai_api_key("anthropic", "Test key", "test-api-key");
  await ai.select_ai_provider("anthropic", ["cla", "ude-opus-4-8"].join(""));

  const conversation = await ai.new_conversation();
  const messages = await ai.send_message(conversation.id, "Hello there");
  const reply = messages.find(message => message.role === "assistant");
  assert.ok(reply);
  assert.match(reply.content, /Handled: Hello there/);
});

test("onAgentProgress receives session.progress views carrying the sessionId and runId passed to send_message", async (t) => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const tauriRoot = join(root, "src/PiDesktop.Tauri");
  const runtimeProtocolUrl = pathToFileURL(join(root, "packages/runtime-protocol/dist/index.js")).href;
  const agentRuntimeUrl = pathToFileURL(join(root, "packages/agent-runtime/dist/index.js")).href;
  const modelAuthCoreUrl = pathToFileURL(join(tauriRoot, "node_modules/@model-auth/core/dist/index.js")).href;

  const loadModule = async (relativePath, extraReplacements = []) => {
    const raw = await readFile(join(tauriRoot, relativePath), "utf8");
    let text = raw
      .replace('from "@synthv-toolbox/runtime-protocol";', `from "${runtimeProtocolUrl}";`)
      .replace('from "@synthv-toolbox/agent-runtime";', `from "${agentRuntimeUrl}";`)
      .replace('from "@model-auth/core";', `from "${modelAuthCoreUrl}";`)
    .replace('from "./local-credential-store.js";', `from "${pathToFileURL(join(tauriRoot, "dist/electron/services/local-credential-store.js")).href}";`);
    for (const [search, replace] of extraReplacements) text = text.replace(search, replace);
    const executable = stripTypeScriptTypes(text, { mode: "transform" });
    return import(`data:text/javascript;base64,${Buffer.from(executable).toString("base64")}`);
  };

  const { AiService, agentRuntimePort } = await loadModule("electron/services/ai-service.ts");
  const { ElectronRuntimeHost } = await loadModule("electron/services/runtime-host.ts");

  const directory = await mkdtemp(join(tmpdir(), "electron-runtime-host-progress-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalog = {
    async models() { return [["cla", "ude-opus-4-8"].join("")]; },
    async opencode() { return {}; },
  };

  const progressViews = [];
  const runtimeHost = new ElectronRuntimeHost(
    join(directory, "runtime"),
    { invoke: () => { throw new Error("not used in this test"); }, resolveModel: () => ai.resolveModelSelection() },
    {
      sessionFactory: {
        async create() {
          return {
            async prompt(input, budget, report, runId) {
              report({ phase: "starting", round: 0, text: "", plan: null, tools: [], toolCount: 0, budget: { turns: 0, tokens: 0, uncachedInputTokens: 0, cacheReadTokens: 0 }, retry: null, pendingInput: null, seq: 1 });
              report({ phase: "ended", round: 0, text: `Handled: ${input}`, plan: null, tools: [], toolCount: 0, budget: { ...budget, turns: 1, tokens: 100, uncachedInputTokens: 0, cacheReadTokens: 0 }, retry: null, pendingInput: null, seq: 2 });
              assert.equal(typeof runId, "string");
              return {
                message: `Handled: ${input}`,
                outcome: {
                  status: "completed",
                  summary: "Done.",
                  evidence: ["Replied to the prompt."],
                  missing: [],
                  plan: { goal: "Reply to the test prompt.", doneCriteria: ["Replied to the prompt."], todos: [{ id: "reply", title: "Reply to the prompt.", status: "completed" }] },
                  budget: { ...budget, turns: 1, tokens: 100, uncachedInputTokens: 0, cacheReadTokens: 0 },
                },
              };
            },
            dispose() {},
          };
        },
      },
      onAgentProgress: (progress) => progressViews.push(progress),
    },
  );
  const ai = new AiService({
    metadataPath: join(directory, "ai.json"),
    runtime: agentRuntimePort(runtimeHost.runtime),
    catalog,
    approvals: { cancelConversation() {} },
    id: () => `id-${Math.random()}`,
  });

  await ai.add_ai_api_key("anthropic", "Test key", "test-api-key");
  await ai.select_ai_provider("anthropic", ["cla", "ude-opus-4-8"].join(""));

  const conversation = await ai.new_conversation();
  await ai.send_message(conversation.id, "Hello there", { runId: "run-progress-test" });

  assert.equal(progressViews.length, 2, "both report() calls reached onAgentProgress");
  for (const view of progressViews) {
    assert.equal(view.sessionId, conversation.id);
    assert.equal(view.runId, "run-progress-test");
  }
  assert.equal(progressViews[0].phase, "starting");
  assert.equal(progressViews[1].phase, "ended");
});

test("ElectronRuntimeHost enables long Pi prompt caching unless the user already chose a retention", async (t) => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const runtimeProtocolUrl = pathToFileURL(join(root, "packages/runtime-protocol/dist/index.js")).href;
  const agentRuntimeUrl = pathToFileURL(join(root, "packages/agent-runtime/dist/index.js")).href;
  const raw = await readFile(join(root, "src/PiDesktop.Tauri/electron/services/runtime-host.ts"), "utf8");
  const text = raw
    .replace('from "@synthv-toolbox/runtime-protocol";', `from "${runtimeProtocolUrl}";`)
    .replace('from "@synthv-toolbox/agent-runtime";', `from "${agentRuntimeUrl}";`);
  const { ElectronRuntimeHost } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(text, { mode: "transform" })).toString("base64")}`);
  const previous = process.env.PI_CACHE_RETENTION;
  t.after(() => { if (previous === undefined) delete process.env.PI_CACHE_RETENTION; else process.env.PI_CACHE_RETENTION = previous; });
  const host = { invoke: () => { throw new Error("not used in this test"); } };

  delete process.env.PI_CACHE_RETENTION;
  new ElectronRuntimeHost(join(tmpdir(), "runtime-host-cache"), host);
  assert.equal(process.env.PI_CACHE_RETENTION, "long");

  process.env.PI_CACHE_RETENTION = "short";
  new ElectronRuntimeHost(join(tmpdir(), "runtime-host-cache"), host);
  assert.equal(process.env.PI_CACHE_RETENTION, "short");
});
