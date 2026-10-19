import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
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
      .replace('from "./local-credential-store.js";', `from "${pathToFileURL(join(tauriRoot, "dist/electron/services/local-credential-store.js")).href}";`)
      .replace('from "./http-mcp-server.js";', `from "${pathToFileURL(join(tauriRoot, "dist/electron/services/http-mcp-server.js")).href}";`);
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
      .replace('from "./local-credential-store.js";', `from "${pathToFileURL(join(tauriRoot, "dist/electron/services/local-credential-store.js")).href}";`)
      .replace('from "./http-mcp-server.js";', `from "${pathToFileURL(join(tauriRoot, "dist/electron/services/http-mcp-server.js")).href}";`);
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
    .replace('from "@synthv-toolbox/agent-runtime";', `from "${agentRuntimeUrl}";`)
    .replace('from "./http-mcp-server.js";', `from "${pathToFileURL(join(root, "src/PiDesktop.Tauri/dist/electron/services/http-mcp-server.js")).href}";`);
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

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const httpMcpServerUrl = pathToFileURL(join(repositoryRoot, "src/PiDesktop.Tauri/dist/electron/services/http-mcp-server.js")).href;
const unusedCapabilities = { invoke: () => { throw new Error("not used in this test"); } };
async function loadRuntimeHost() {
  const text = source
    .replace('from "@synthv-toolbox/runtime-protocol";', `from "${pathToFileURL(join(repositoryRoot, "packages/runtime-protocol/dist/index.js")).href}";`)
    .replace('from "@synthv-toolbox/agent-runtime";', `from "${pathToFileURL(join(repositoryRoot, "packages/agent-runtime/dist/index.js")).href}";`)
    .replace('from "./http-mcp-server.js";', `from "${httpMcpServerUrl}";`);
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(text, { mode: "transform" })).toString("base64")}`);
}

test("the HTTP API bearer token is generated once, stored owner-only, kept by configure and rotated in place", async (t) => {
  const { ElectronRuntimeHost } = await loadRuntimeHost();
  const { HttpMcpServer } = await import(httpMcpServerUrl);
  const directory = await mkdtemp(join(tmpdir(), "runtime-host-token-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, "runtime-settings.json");
  const ownerOnly = async () => { if (process.platform !== "win32") assert.equal((await stat(settingsPath)).mode & 0o777, 0o600); };
  const runtimeHost = new ElectronRuntimeHost(directory, unusedCapabilities);
  const token = (await runtimeHost.load()).httpApiToken;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).httpApiToken, token);
  await ownerOnly();
  assert.equal((await new ElectronRuntimeHost(directory, unusedCapabilities).load()).httpApiToken, token, "a restart keeps the stored token");

  const server = new HttpMcpServer({ async mcpTools() { return []; }, async callMcpTool() { return { content: null }; } });
  t.after(() => server.stop());
  await runtimeHost.attachHttpServer(server);
  await runtimeHost.configure({ ...runtimeHost.settingsSnapshot(), httpApiEnabled: true, httpApiPort: 0, httpApiToken: "" });
  assert.equal(runtimeHost.settingsSnapshot().httpApiToken, token, "configure keeps the token unless one is supplied");
  let status = await runtimeHost.httpMcpStatus();
  assert.equal(status.running, true);
  assert.equal(status.token, token);
  assert.equal(status.authRequired, true);
  assert.equal(status.serverName, "toneshuttle");
  assert.deepEqual(status.protocolVersions, ["2025-11-25", "2025-06-18", "2025-03-26"]);
  const listener = server.server;
  await runtimeHost.configure(runtimeHost.settingsSnapshot());
  assert.equal(server.server, listener, "saving unchanged settings keeps the running server");
  const ping = (endpoint, bearer) => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal((await ping(status.endpoint, token)).status, 200);

  status = await runtimeHost.rotateHttpApiToken();
  assert.match(status.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(status.token, token);
  assert.equal(server.server, listener, "a new token is swapped into the running listener, so requests in flight are not cut off");
  assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).httpApiToken, status.token);
  await ownerOnly();
  assert.equal((await ping(status.endpoint, token)).status, 401);
  assert.equal((await ping(status.endpoint, status.token)).status, 200);
});

test("an unreadable settings file is never overwritten with defaults just to store a new token", async (t) => {
  const { ElectronRuntimeHost } = await loadRuntimeHost();
  const directory = await mkdtemp(join(tmpdir(), "runtime-host-damaged-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, "runtime-settings.json");
  const damaged = '{"pluginAdvancedFunctionsEnabled": true, "httpApiEnabled": tr';
  await writeFile(settingsPath, damaged, "utf8");
  const settings = await new ElectronRuntimeHost(directory, unusedCapabilities).load();
  assert.match(settings.httpApiToken, /^[A-Za-z0-9_-]{43}$/, "the session still gets a token");
  assert.equal(await readFile(settingsPath, "utf8"), damaged, "the user's file must stay as it was so it can be repaired");
});

test("plugin commands only touch installed plugin directories", async (t) => {
  const { ElectronRuntimeHost } = await loadRuntimeHost();
  const directory = await mkdtemp(join(tmpdir(), "runtime-host-plugin-ids-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pluginSource = join(directory, "source");
  await mkdir(pluginSource, { recursive: true });
  await writeFile(join(pluginSource, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: "example.plugin", name: "Example", version: "1.0.0", hostApi: { min: "1.0", max: "1.0" } }));
  const runtimeRoot = join(directory, "runtime");
  const runtimeHost = new ElectronRuntimeHost(runtimeRoot, unusedCapabilities);
  await runtimeHost.load();
  await runtimeHost.installPlugin(pluginSource);
  await mkdir(join(runtimeRoot, "victim.dir"), { recursive: true });
  const attempts = (id) => [() => runtimeHost.uninstallPlugin(id), () => runtimeHost.setPluginEnabled(id, true), () => runtimeHost.setPluginGrant(id, "internal", false)];
  for (const id of ["..", "../victim.dir", "..\\victim.dir", "example.plugin/..", "example.plugin\\..", "Example.Plugin", "plugins", "", 42]) {
    for (const attempt of attempts(id)) await assert.rejects(attempt, /Plugin id is invalid/, `rejects ${JSON.stringify(id)}`);
  }
  for (const attempt of attempts("other.plugin")) await assert.rejects(attempt, /Plugin is not installed/);
  assert.ok(existsSync(join(runtimeRoot, "victim.dir")));
  assert.ok(existsSync(join(runtimeRoot, "runtime-settings.json")));
  assert.equal((await runtimeHost.setPluginEnabled("example.plugin", false)).enabled, false);
  await runtimeHost.uninstallPlugin("example.plugin");
  assert.equal(existsSync(join(runtimeRoot, "plugins", "example.plugin")), false);
  await assert.rejects(() => runtimeHost.setPluginEnabled("example.plugin", true), /Plugin is not installed/);
});

test("the runtime host plugin id rule matches validatePluginManifest", () => {
  const protocol = readFileSync(new URL("../packages/runtime-protocol/src/index.ts", import.meta.url), "utf8");
  assert.equal(/const pluginIdPattern = (\/.+\/);/.exec(source)[1], /const identifierPattern = (\/.+\/);/.exec(protocol)[1]);
});
