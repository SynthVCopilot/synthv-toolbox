// The SynthV integration switch and the authenticated MCP endpoint, driven through IPC against the built app.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { freePort, invoke, isolatedEnv, makeTemporaryDirectory, openPage, quitApp, sdkRoot, startApp } from "./_lib/app.mjs";

test("the SynthV integration setting and the MCP endpoint work in the built app", async (t) => {
  const cleanups = [];
  const profileDir = await makeTemporaryDirectory("toneshuttle-mcp-profile-", cleanups);
  const homeDir = await makeTemporaryDirectory("toneshuttle-mcp-home-", cleanups);
  const mcpPort = await freePort();
  const app = await startApp([`--user-data-dir=${profileDir}`], isolatedEnv(homeDir));
  let page;
  let status;
  try {
    page = await openPage(app);
    await invoke(page, "complete_onboarding", { mode: "toolbox" });

    await t.test("the integration preference is applied and persisted", async () => {
      const state = await invoke(page, "bootstrap");
      assert.ok(state.integrations?.synthv, "bootstrap must report the SynthV integration state");
      assert.deepEqual(state.installations.filter((item) => item.source !== "Windows installed application"), [], "the isolated HOME has no SynthV scripts or standard installation; registry entries describe the machine");
      // "auto" resolves from detection, so start from explicit values.
      const on = await invoke(page, "set_integration", { integration: "synthv", preference: "on" });
      assert.equal(on.integrations.synthv.preference, "on");
      assert.equal(on.integrations.synthv.enabled, true);
      const off = await invoke(page, "set_integration", { integration: "synthv", preference: "off" });
      assert.equal(off.integrations.synthv.preference, "off");
      assert.equal(off.integrations.synthv.enabled, false);
      assert.equal(JSON.parse(await readFile(join(profileDir, "desktop-settings.json"), "utf8")).integrations.synthv, "off");
      assert.equal((await invoke(page, "set_integration", { integration: "synthv", preference: "on" })).integrations.synthv.enabled, true);
    });

    await t.test("enabling MCP starts an endpoint with a long random token", async () => {
      status = await invoke(page, "configure_http_api", { enabled: true, agentEnabled: true, internalFunctionsEnabled: true, advancedFunctionsEnabled: false, port: mcpPort });
      assert.equal(status.running, true, status.lastError ?? "MCP server is not running");
      assert.equal(new URL(status.endpoint).port, String(mcpPort));
      assert.equal(typeof status.token, "string");
      assert.ok(status.token.length >= 32, "token must be long enough to resist guessing");
    });

    await t.test("the official MCP SDK client connects with the token and gets well-formed results", async () => {
      const { Client } = await import(pathToFileURL(join(sdkRoot, "client", "index.js")).href);
      const { StreamableHTTPClientTransport } = await import(pathToFileURL(join(sdkRoot, "client", "streamableHttp.js")).href);
      const client = new Client({ name: "toneshuttle-flow", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(status.endpoint), { requestInit: { headers: { Authorization: `Bearer ${status.token}` } } }));
      try {
        assert.equal(client.getServerVersion()?.name, "toneshuttle");
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name).sort(), ["toolbox_agent", "toolbox_internal"]);
        for (const tool of tools) assert.ok(!["oneOf", "anyOf", "allOf"].some((key) => key in tool.inputSchema), `${tool.name} has a top-level combinator`);
        const history = await client.callTool({ name: "toolbox_internal", arguments: { capability: "creative", operation: "list_creative_history", params: {} } });
        assert.equal(history.isError, false, JSON.stringify(history.content));
        const agent = await client.callTool({ name: "toolbox_agent", arguments: { action: "list" } });
        assert.equal(agent.isError, true, "toolbox mode must refuse the internal agent");
        assert.match(agent.content[0].text, /AI mode/);
      } finally { await client.close(); }
    });

    await t.test("requests without the token, or with a wrong one, are rejected", async () => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } } });
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      assert.equal((await fetch(status.endpoint, { method: "POST", headers, body })).status, 401);
      assert.equal((await fetch(status.endpoint, { method: "POST", headers: { ...headers, authorization: "Bearer wrong" }, body })).status, 401);
      assert.equal((await fetch(status.agentEndpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${status.token}` }, body: JSON.stringify({ input: "hi" }) })).status, 409, "/agent must refuse in toolbox mode");
    });

    await t.test("rotating the token invalidates the old one", async () => {
      const next = await invoke(page, "rotate_http_api_token");
      assert.notEqual(next.token, status.token);
      assert.equal(next.running, true);
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
      const headers = (token) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });
      assert.equal((await fetch(next.endpoint, { method: "POST", headers: headers(status.token), body })).status, 401);
      assert.equal((await fetch(next.endpoint, { method: "POST", headers: headers(next.token), body })).status, 200);
    });
  } finally {
    const exit = await quitApp(app, page);
    for (const cleanup of cleanups) await cleanup();
    assert.equal(exit?.code, 0, `the app must quit cleanly; output:\n${app.stderr()}`);
  }
});
