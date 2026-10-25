import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appRoot, compiled } from "../_lib/load.mjs";
import { assertAsyncProperty, fc } from "../_lib/props.mjs";

const { ElectronCommandRegistry } = await compiled("services/command-registry.js");

const apiSource = await readFile(new URL("src/api.ts", appRoot), "utf8");
const mainSource = await readFile(new URL("electron/main.ts", appRoot), "utf8");
const apiCommands = [...new Set([...apiSource.matchAll(/call(?:<[^;\n]*?>)?\("([^"]+)"/g)].map(match => match[1]))];
const mainCommands = [...mainSource.matchAll(/handlers\.register\("([^"]+)"/g)].map(match => match[1]);

const inertHost = { async load() { return {}; }, async contributions() { return []; }, runtime: { dispose: async () => {} } };
const inert = {};
const inertRegistry = () => new ElectronCommandRegistry(inertHost, { ai: inert, creative: inert, desktop: inert, synthv: inert, componentAudio: { dataRoot: process.cwd(), run: async () => ({ stdout: "", stderr: "" }) } });

test("every renderer call() in api.ts has an Electron handler", () => {
  assert.ok(apiCommands.length > 0, "api.ts call() extraction found nothing");
  const covered = new Set([...inertRegistry().commands(), ...mainCommands]);
  const missing = apiCommands.filter(command => !covered.has(command));
  assert.deepEqual(missing, [], `Renderer commands missing from Electron: ${missing.join(", ")}`);
});

test("no command is registered twice across the registry and main.ts", () => {
  const all = [...inertRegistry().commands(), ...mainCommands];
  const duplicates = all.filter((command, index) => all.indexOf(command) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});

test("HTTP API ports outside 1024-65535 or non-integer are rejected, valid ones are forwarded", async () => {
  const configured = [];
  const host = { ...inertHost, settingsSnapshot: () => ({}), async configure(next) { configured.push(next); }, async httpMcpStatus() { return {}; } };
  const registry = new ElectronCommandRegistry(host, undefined, () => {});
  const call = port => registry.invoke("configure_http_api", { enabled: true, agentEnabled: false, internalFunctionsEnabled: false, advancedFunctionsEnabled: false, port });
  const ports = fc.oneof(fc.integer({ min: 1024, max: 65535 }), fc.integer({ min: -100000, max: 1023 }), fc.integer({ min: 65536, max: 200000 }), fc.double({ noNaN: true }), fc.string(), fc.constant(null));
  await assertAsyncProperty(ports, async port => {
    configured.length = 0;
    const valid = Number.isInteger(port) && port >= 1024 && port <= 65535;
    if (valid) { await call(port); assert.equal(configured.at(-1).httpApiPort, port); }
    else { await assert.rejects(() => call(port), /port must be/); assert.equal(configured.length, 0); }
  });
});

test("the Electron command registry validates input, routes plugin commands, and keeps MCP settings independent", async () => {
  const calls = [];
  const host = {
    async load() { return { loaded: true }; },
    async contributions() { return []; },
    async installPlugin(sourcePath) { calls.push(["install", sourcePath]); return { id: "example.plugin" }; },
    async uninstallPlugin(id) { calls.push(["uninstall", id]); },
    async setPluginEnabled(id, enabled) { calls.push(["enabled", id, enabled]); return { enabled }; },
    async setPluginGrant(id, kind, enabled) { calls.push(["grant", id, kind, enabled]); return { enabled }; },
    settingsSnapshot() { return { pluginInternalFunctionsEnabled: true, pluginAdvancedFunctionsEnabled: false, mcpInternalFunctionsEnabled: false, mcpAdvancedFunctionsEnabled: false, httpApiEnabled: false, httpAgentEnabled: false, httpApiPort: 17831 }; },
    async configure(next) { calls.push(["configure", next]); },
    async httpMcpStatus() { return { enabled: true, internalFunctionsEnabled: true }; },
  };
  const events = [];
  const registry = new ElectronCommandRegistry(host, undefined, (event, payload) => events.push([event, payload]));

  await registry.invoke("install_agent_plugin", { sourcePath: "C:/work/plugin" });
  await registry.invoke("uninstall_agent_plugin", { pluginId: "example.plugin" });
  await registry.invoke("configure_http_api", { enabled: true, agentEnabled: true, internalFunctionsEnabled: true, advancedFunctionsEnabled: false, port: 19000 });

  assert.deepEqual(calls.slice(0, 2), [["install", "C:/work/plugin"], ["uninstall", "example.plugin"]]);
  assert.deepEqual(calls[2], ["configure", { pluginInternalFunctionsEnabled: true, pluginAdvancedFunctionsEnabled: false, mcpInternalFunctionsEnabled: true, mcpAdvancedFunctionsEnabled: false, httpApiEnabled: true, httpAgentEnabled: true, httpApiPort: 19000 }]);
  assert.equal(events.length, 3);
  await assert.rejects(() => registry.invoke("configure_http_api", { enabled: true, agentEnabled: true, internalFunctionsEnabled: false, advancedFunctionsEnabled: false, port: 80 }), /TCP port/);
  await assert.rejects(() => registry.invoke("install_agent_plugin", { sourcePath: "" }), /non-empty string/);
});

test("the file-approval commands are gone, replaced by broker-backed approval commands, and send_message requires runId", async () => {
  const approvals = { snapshot: () => ({ pending: [{ id: "a1" }], recent: [] }), decide: () => {} };
  const desktop = { agentEffort: () => "mid" };
  const ai = { send_message: async (conversationId, input, options) => [{ role: "user", content: input, createdAt: "" }, { role: "assistant", content: "", createdAt: "", outcome: undefined, ...options }] };
  const registry = new ElectronCommandRegistry(inertHost, { ai, creative: {}, desktop, synthv: {}, approvals, componentAudio: { dataRoot: process.cwd() } });
  const commands = registry.commands();
  assert.ok(!commands.includes("agent_file_approvals"), "agent_file_approvals is removed");
  assert.ok(!commands.includes("decide_agent_file_approval"), "decide_agent_file_approval is removed");
  assert.ok(commands.includes("agent_approvals"));
  assert.ok(commands.includes("decide_agent_approval"));
  assert.deepEqual(await registry.invoke("agent_approvals"), { pending: [{ id: "a1" }], recent: [] });
  await assert.rejects(() => registry.invoke("send_message", { conversationId: "c1", input: "hi" }), /runId must be a non-empty string/);
  const sent = await registry.invoke("send_message", { conversationId: "c1", input: "hi", runId: "run-1" });
  assert.equal(sent[1].runId, "run-1");
});

test("steer_agent_run is registered, validates its params and forwards to the AI service", async () => {
  const calls = [];
  const ai = { steer_agent_run: async (conversationId, input) => { calls.push([conversationId, input]); return { role: "user", content: input, createdAt: "" }; } };
  const registry = new ElectronCommandRegistry(inertHost, { ai, creative: {}, desktop: {}, synthv: {}, approvals: {}, componentAudio: { dataRoot: process.cwd() } });
  assert.ok(registry.commands().includes("steer_agent_run"));
  const steered = await registry.invoke("steer_agent_run", { conversationId: "c1", input: "use track 2" });
  assert.equal(steered.content, "use track 2");
  assert.deepEqual(calls, [["c1", "use track 2"]]);
  await assert.rejects(() => registry.invoke("steer_agent_run", { conversationId: "c1" }), /input must be a non-empty string/);
  await assert.rejects(() => registry.invoke("steer_agent_run", { input: "x" }), /conversationId must be a non-empty string/);
});
