// An external stdio MCP server saved through IPC is probed and reaches the agent under the Edit-mode policy.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMockAnthropicServer, systemText } from "../../fixtures/mock-anthropic-server.mjs";
import { invoke, isolatedEnv, makeTemporaryDirectory, openPage, quitApp, startApp, useMockAnthropic } from "./_lib/app.mjs";

const fixture = fileURLToPath(new URL("../../fixtures/external-mcp-server.mjs", import.meta.url));
// Must be in electron/main.ts's model catalog or select_ai_provider rejects it.
const MODEL_ID = ["cla", "ude-sonnet-4-6"].join("");

test("an external stdio MCP server reaches the agent and follows the Edit-mode policy", async () => {
  const cleanups = [];
  const profileDir = await makeTemporaryDirectory("toneshuttle-extmcp-profile-", cleanups);
  const homeDir = await makeTemporaryDirectory("toneshuttle-extmcp-home-", cleanups);
  const mock = createMockAnthropicServer({ turns: [] });
  await useMockAnthropic(homeDir, await mock.listen());
  const app = await startApp([`--user-data-dir=${profileDir}`], isolatedEnv(homeDir));
  let page;
  try {
    page = await openPage(app);
    await invoke(page, "complete_onboarding", { mode: "ai" });
    await invoke(page, "add_ai_api_key", { provider: "anthropic", label: "Test key", apiKey: "test-api-key" });
    await invoke(page, "select_ai_provider", { provider: "anthropic", model: MODEL_ID });
    await invoke(page, "set_integration", { integration: "synthv", preference: "off" });
    await invoke(page, "save_mcp_server", { server: { id: "fixture-tools", name: "Fixture tools", command: process.execPath, args: [fixture], enabled: true } });

    const probe = await invoke(page, "test_mcp_server", { id: "fixture-tools" });
    assert.equal(probe.succeeded, true, JSON.stringify(probe));
    for (const name of ["read_status", "write_note", "choose_shape"]) assert.ok(probe.tools?.includes(name), `the probe lists ${name}: ${JSON.stringify(probe)}`);

    mock.push({ content: [{ type: "tool_use", id: "toolu_ext_read", name: "mcp__fixture_tools__read_status", input: {} }, { type: "tool_use", id: "toolu_ext_write", name: "mcp__fixture_tools__write_note", input: { text: "hello" } }], stopReason: "tool_use", usage: { input: 100, output: 10, cacheWrite: 0 } });
    mock.push({ content: [{ type: "tool_use", id: "toolu_ext_ask", name: "request_input", input: { question: "Done?", missing: ["confirmation"] } }], stopReason: "tool_use", usage: { input: 100, output: 10, cacheWrite: 0 } });
    const conversation = await invoke(page, "new_conversation");
    const messages = await invoke(page, "send_message", { conversationId: conversation.id, input: "Check the fixture.", runId: "run-external" });
    assert.equal(messages.at(-1).outcome.status, "needs_input", JSON.stringify(messages.at(-1).outcome));

    const first = mock.requests.at(-2);
    const names = first.tools.map((tool) => tool.name);
    for (const name of ["mcp__fixture_tools__read_status", "mcp__fixture_tools__write_note", "mcp__fixture_tools__choose_shape"]) assert.ok(names.includes(name), `missing ${name} in ${names}`);
    for (const tool of first.tools) assert.ok(!["oneOf", "anyOf", "allOf"].some((key) => key in (tool.input_schema ?? {})), `${tool.name} sends a top-level combinator`);
    assert.match(systemText(first.system), /## External MCP servers[\s\S]*Fixture tools/);

    const results = mock.requests.at(-1).messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === "tool_result");
    const text = (block) => typeof block.content === "string" ? block.content : (block.content ?? []).map((part) => part.text ?? "").join("");
    const read = results.find((block) => block.tool_use_id === "toolu_ext_read");
    const write = results.find((block) => block.tool_use_id === "toolu_ext_write");
    assert.ok(read && !read.is_error, `the read-only tool must run in Edit mode: ${read && text(read)}`);
    assert.match(text(read), /initialized/);
    assert.ok(write?.is_error, "a tool that may change data must be refused in Edit mode");
    assert.match(text(write), /Solo mode/);
  } finally {
    const exit = await quitApp(app, page);
    await mock.close();
    for (const cleanup of cleanups) await cleanup();
    assert.equal(exit?.code, 0, `the app must quit cleanly; output:\n${app.stderr()}`);
  }
});
