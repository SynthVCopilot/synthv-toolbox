import assert from "node:assert/strict";
import test from "node:test";
const registryPath = new URL("../src/PiDesktop.Tauri/dist/electron/services/command-registry.js", import.meta.url);
const { ElectronCommandRegistry } = await import(registryPath.href);

test("the Electron command registry validates input, routes sessions, and keeps MCP settings independent", async () => {
  const calls = [];
  const host = {
    async load() { return { loaded: true }; },
    async contributions() { return []; },
    async installPlugin(sourcePath) { calls.push(["install", sourcePath]); return { id: "example.plugin" }; },
    async uninstallPlugin(id) { calls.push(["uninstall", id]); },
    async setPluginEnabled(id, enabled) { calls.push(["enabled", id, enabled]); return { enabled }; },
    async setPluginGrant(id, kind, enabled) { calls.push(["grant", id, kind, enabled]); return { enabled }; },
    async initializeAgentSession(...args) { calls.push(["initialize", ...args]); return { sessionId: args[0] }; },
    async sendAgentMessage(...args) { calls.push(["send", ...args]); return { accepted: true }; },
    async closeAgentSession(...args) { calls.push(["close", ...args]); return { closed: true }; },
    settingsSnapshot() { return { pluginInternalFunctionsEnabled: true, pluginAdvancedFunctionsEnabled: false, mcpInternalFunctionsEnabled: false, mcpAdvancedFunctionsEnabled: false, httpApiEnabled: false, httpAgentEnabled: false, httpApiPort: 17831 }; },
    async configure(next) { calls.push(["configure", next]); },
    async httpMcpStatus() { return { enabled: true, internalFunctionsEnabled: true }; },
  };
  const events = [];
  const registry = new ElectronCommandRegistry(host, undefined, (event, payload) => events.push([event, payload]));

  await registry.invoke("agent_session_initialize", { sessionId: "chat-1", cwd: "C:/work", systemPrompt: "help" });
  await registry.invoke("agent_session_send", { sessionId: "chat-1", input: "hello" });
  await registry.invoke("agent_session_close", { sessionId: "chat-1" });
  await registry.invoke("configure_http_api", { enabled: true, agentEnabled: true, internalFunctionsEnabled: true, advancedFunctionsEnabled: false, port: 19000 });

  assert.deepEqual(calls.slice(0, 3), [["initialize", "chat-1", "C:/work", "help"], ["send", "chat-1", "hello"], ["close", "chat-1"]]);
  assert.deepEqual(calls[3], ["configure", { pluginInternalFunctionsEnabled: true, pluginAdvancedFunctionsEnabled: false, mcpInternalFunctionsEnabled: true, mcpAdvancedFunctionsEnabled: false, httpApiEnabled: true, httpAgentEnabled: true, httpApiPort: 19000 }]);
  assert.equal(events.length, 4);
  await assert.rejects(() => registry.invoke("configure_http_api", { enabled: true, agentEnabled: true, internalFunctionsEnabled: false, advancedFunctionsEnabled: false, port: 80 }), /TCP port/);
  await assert.rejects(() => registry.invoke("agent_session_send", { sessionId: "chat-1", input: "" }), /non-empty string/);
});
