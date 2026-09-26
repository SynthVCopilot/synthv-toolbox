import assert from "node:assert/strict";
import test from "node:test";
const registryPath = new URL("../src/PiDesktop.Tauri/dist/electron/services/command-registry.js", import.meta.url);
const { ElectronCommandRegistry } = await import(registryPath.href);

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
