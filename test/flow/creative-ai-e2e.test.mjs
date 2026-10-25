import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMockAnthropicServer, messageText } from "../fixtures/mock-anthropic-server.mjs";
import { createCreativeService } from "../../src/PiDesktop.Tauri/dist/electron/services/creative-service.js";

// Lyric candidates and workflow review run through the real Pi SDK and the Electron host chain
// against a scripted local model, with temp directories for every piece of state.

const root = fileURLToPath(new URL("../..", import.meta.url));
const tauriRoot = join(root, "src/PiDesktop.Tauri");
const runtimeProtocolUrl = pathToFileURL(join(root, "packages/runtime-protocol/dist/index.js")).href;
const agentRuntimeUrl = pathToFileURL(join(root, "packages/agent-runtime/dist/index.js")).href;
const modelAuthCoreUrl = pathToFileURL(join(tauriRoot, "node_modules/@model-auth/core/dist/index.js")).href;

async function loadElectronModule(relativePath) {
  const raw = await readFile(join(tauriRoot, relativePath), "utf8");
  const text = raw
    .replace('from "@synthv-toolbox/runtime-protocol";', `from "${runtimeProtocolUrl}";`)
    .replace('from "@synthv-toolbox/agent-runtime";', `from "${agentRuntimeUrl}";`)
    .replace('from "@model-auth/core";', `from "${modelAuthCoreUrl}";`)
    .replace('from "./local-credential-store.js";', `from "${pathToFileURL(join(tauriRoot, "dist/electron/services/local-credential-store.js")).href}";`)
    .replace('from "./http-mcp-server.js";', `from "${pathToFileURL(join(tauriRoot, "dist/electron/services/http-mcp-server.js")).href}";`);
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(text, { mode: "transform" })).toString("base64")}`);
}

const MODEL_ID = ["cla", "ude-haiku-4-5"].join("");
const PROVIDER_ID = "anthropic";

test("Lyric candidates and workflow review run through the agent runtime and the selected model", async (t) => {
  const savedEnv = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, HOME: process.env.HOME, PI_OFFLINE: process.env.PI_OFFLINE, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  const tempRoot = await mkdtemp(join(tmpdir(), "creative-ai-e2e-"));
  const agentDir = join(tempRoot, "pi-agent"), home = join(tempRoot, "home");
  await Promise.all([agentDir, home].map((dir) => mkdir(dir, { recursive: true })));
  Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, HOME: home, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" });
  delete process.env.ANTHROPIC_API_KEY;

  const mock = createMockAnthropicServer();
  const port = await mock.listen();
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { [PROVIDER_ID]: { baseUrl: `http://127.0.0.1:${port}` } } }), "utf8");

  let aiMode = true;
  let ai;
  const { AiService, agentRuntimePort } = await loadElectronModule("electron/services/ai-service.ts");
  const { ElectronRuntimeHost } = await loadElectronModule("electron/services/runtime-host.ts");
  const runtimeHost = new ElectronRuntimeHost(join(tempRoot, "runtime"), { invoke: () => { throw new Error("Plugin capabilities are not used here."); }, resolveModel: () => ai.resolveModelSelection() });
  const catalog = { async models(provider) { return provider === PROVIDER_ID ? [MODEL_ID] : []; }, async opencode() { return {}; } };
  ai = new AiService({ metadataPath: join(tempRoot, "ai", "metadata.json"), runtime: agentRuntimePort(runtimeHost.runtime), catalog, approvals: { cancelConversation() {} }, agentAllowed: () => aiMode });
  await ai.add_ai_api_key(PROVIDER_ID, "Test key", "test-api-key", [MODEL_ID]);
  await ai.select_ai_provider(PROVIDER_ID, MODEL_ID);

  const creative = createCreativeService(join(tempRoot, "creative"), async () => { throw new Error("no component"); }, undefined, undefined, { complete: (system, input, signal) => ai.complete(system, input, signal), backupIntervalMs: 3_600_000 });

  t.after(async () => {
    creative.dispose?.();
    await runtimeHost.runtime.dispose();
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });

  const finish = (answer) => [
    { content: [{ type: "tool_use", id: "toolu_plan", name: "update_plan", input: { goal: "Reply", doneCriteria: ["Reply given"], todos: [{ id: "t1", title: "Reply", status: "in_progress" }] } }], stopReason: "tool_use", usage: { input: 100, output: 20, cacheWrite: 0 } },
    { content: [{ type: "text", text: answer }, { type: "tool_use", id: "toolu_done", name: "complete_task", input: { summary: "Replied.", evidence: ["Replied."] } }], stopReason: "tool_use", usage: { input: 110, output: 40, cacheWrite: 0 } },
  ];
  const request = { language: "zh-CN", brief: "离别", imagery: "月台", sectionLabel: "副歌", tone: "", targetRhyme: "ang", candidateCount: 3 };

  await t.test("candidates come from the model's reply and the session exposes no SynthV or file tools", async () => {
    mock.reset();
    for (const turn of finish(JSON.stringify({ candidates: [{ text: "旧月台还留着未熄的光", note: "a" }, { text: "风把信吹回我身旁", note: "b" }, { text: "故乡越来越长", note: "c" }] }))) mock.push(turn);
    const set = await creative.invoke("generate_lyric_candidates", { request });
    assert.deepEqual(set.candidates.map((item) => item.text), ["旧月台还留着未熄的光", "风把信吹回我身旁", "故乡越来越长"]);
    assert.ok(set.candidates.every((item) => item.rhymeMatched === true));
    assert.deepEqual(mock.requests[0].tools.map((tool) => tool.name).sort(), ["complete_task", "request_input", "update_plan"]);
    assert.match(messageText(mock.requests[0].messages[0]), /离别/);
  });

  await t.test("review returns the model's text", async () => {
    mock.reset();
    for (const turn of finish("结论：结果可信。")) mock.push(turn);
    assert.equal(await creative.invoke("review_workflow", { kind: "project-doctor", data: { findings: 0 } }), "结论：结果可信。");
  });

  await t.test("a model failure surfaces as an error", async () => {
    mock.reset([{ kind: "error", status: 401, message: "invalid key" }]);
    await assert.rejects(creative.invoke("review_workflow", { kind: "project-doctor", data: {} }));
  });

  await t.test("outside AI mode no model request is made", async () => {
    mock.reset();
    aiMode = false;
    try {
      await assert.rejects(creative.invoke("generate_lyric_candidates", { request }), /AI mode/);
      await assert.rejects(creative.invoke("review_workflow", { kind: "project-doctor", data: {} }), /AI mode/);
      assert.equal(mock.requests.length, 0);
    } finally { aiMode = true; }
  });

  await t.test("cancelling stops the model request and returns no candidates", async () => {
    mock.reset();
    const started = new Promise((resolve) => mock.push({ kind: "slow", onStarted: resolve }));
    const controller = new AbortController();
    const pending = creative.invoke("generate_lyric_candidates", { request }, controller.signal);
    const settled = assert.rejects(pending);
    await started;
    controller.abort();
    await settled;
    assert.equal(mock.requests.length, 1);
  });
});
