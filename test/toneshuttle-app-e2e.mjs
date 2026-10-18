// Drives the built Electron app over CDP to prove the Toneshuttle rename, the SynthV integration switch and the
// authenticated MCP endpoint work end to end, then connects to that endpoint with the official MCP SDK client using
// exactly the token the Connections page shows. Requires `npm run build:electron` first.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import test from "node:test";

const require = createRequire(import.meta.url);
const desktopRoot = fileURLToPath(new URL("../src/PiDesktop.Tauri/", import.meta.url));
const mainScript = join(desktopRoot, "dist", "electron", "main.js");
const electronBinary = require(join(desktopRoot, "node_modules", "electron"));
const sdkRoot = join(desktopRoot, "components", "synthv-agent-bridge", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function waitFor(check, { timeoutMs = 20000, intervalMs = 100, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    if (Date.now() >= deadline) throw lastError ?? new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error(`Failed to connect to ${this.url}`)), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (typeof message.id !== "number" || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    });
    this.socket.addEventListener("close", () => { for (const { resolve } of this.pending.values()) resolve(undefined); this.pending.clear(); });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  close() { try { this.socket?.close(); } catch { /* already closed */ } }
}

async function evaluate(page, expression, { awaitPromise = false } = {}) {
  const result = await page.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) throw new Error(`Evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  return result.result.value;
}

const invoke = (page, command, args = {}) => evaluate(page, `window.toolboxDesktop.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`, { awaitPromise: true });
const click = (page, selector) => evaluate(page, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error("missing ${selector.replaceAll("\"", "'")}"); element.click(); return true; })()`);
const navPages = (page) => evaluate(page, "[...document.querySelectorAll('.nav [data-page]')].map((item) => item.dataset.page)");

test("Toneshuttle app: branding, SynthV integration switch and authenticated MCP work in the real Electron build", async (t) => {
  assert.equal(existsSync(mainScript), true, "dist/electron/main.js must exist; run build:electron first");
  const profileDir = await mkdtemp(join(tmpdir(), "toneshuttle-e2e-profile-"));
  const homeDir = await mkdtemp(join(tmpdir(), "toneshuttle-e2e-home-"));
  const screenshotDir = process.env.TONESHUTTLE_E2E_SCREENSHOTS ?? await mkdtemp(join(tmpdir(), "toneshuttle-e2e-shots-"));
  await mkdir(screenshotDir, { recursive: true });
  const port = await freePort();
  const mcpPort = await freePort();
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", HOME: homeDir, APPDATA: homeDir, LOCALAPPDATA: homeDir, USERPROFILE: homeDir, PI_CODING_AGENT_DIR: join(homeDir, ".pi", "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" };
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ELECTRON_RENDERER_URL"]) delete env[key];
  const child = spawn(electronBinary, [mainScript, `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`], { cwd: desktopRoot, stdio: ["ignore", "pipe", "pipe"], env });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let page;
  const shot = async (name) => { const result = await page.send("Page.captureScreenshot", { format: "png" }); await writeFile(join(screenshotDir, `${name}.png`), Buffer.from(result.data, "base64")); };
  try {
    const target = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())).find((entry) => entry.type === "page"), { label: "the main window" });
    page = new CdpClient(target.webSocketDebuggerUrl);
    await page.connect();
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    await waitFor(() => evaluate(page, "typeof window.toolboxDesktop === 'object' && !!document.querySelector('[data-onboarding=\"toolbox\"]')"), { label: "onboarding" });

    await t.test("window title and onboarding carry the new name", async () => {
      assert.equal(await evaluate(page, "document.title"), "Toneshuttle");
      assert.match(await evaluate(page, "document.querySelector('.onboarding-brand').textContent"), /声梭|Toneshuttle/);
      await shot("01-onboarding");
    });

    await t.test("toolbox mode shows the branded sidebar and SynthV pages follow the integration state", async () => {
      await click(page, "[data-onboarding=\"toolbox\"]");
      await waitFor(() => evaluate(page, "!!document.querySelector('.brand strong')"), { label: "sidebar" });
      assert.match(await evaluate(page, "document.querySelector('.brand').innerText"), /声梭[\s\S]*人声与音频创作工具箱/);
      const state = await invoke(page, "bootstrap");
      assert.ok(state.integrations?.synthv, "bootstrap must report the SynthV integration state");
      assert.deepEqual(state.installations, [], "the isolated HOME/APPDATA has no SynthV installation");
      assert.equal((await navPages(page)).includes("bridge"), state.integrations.synthv.enabled);
      await shot("02-home");
    });

    await t.test("Settings > Integrations > Off hides SynthV pages, persists, and On restores them", async () => {
      await click(page, "[data-page=\"settings\"]");
      await waitFor(() => evaluate(page, "!!document.querySelector('[data-set-integration=\"synthv:off\"]')"), { label: "integration switch" });
      await click(page, "[data-set-integration=\"synthv:off\"]");
      await waitFor(async () => !(await navPages(page)).includes("bridge"), { label: "Bridge nav to disappear" });
      assert.ok(!(await navPages(page)).includes("accounts"));
      const saved = JSON.parse(await readFile(join(profileDir, "desktop-settings.json"), "utf8"));
      assert.equal(saved.integrations.synthv, "off");
      assert.equal(await evaluate(page, "document.querySelector('[data-set-integration=\"synthv:off\"]').getAttribute('aria-pressed')"), "true");
      await shot("03-settings-integration-off");
      await click(page, "[data-page=\"home\"]");
      await waitFor(() => evaluate(page, "!!document.querySelector('.quick-card')"), { label: "home quick start" });
      const quick = await evaluate(page, "[...document.querySelectorAll('.quick-card')].map((card) => card.dataset.feature ?? card.dataset.page)");
      assert.ok(!quick.some((id) => ["score-to-synthv", "cover", "project-tools"].includes(id)), `quick start offered a SynthV tool: ${quick}`);
      await click(page, "[data-page=\"settings\"]");
      await waitFor(() => evaluate(page, "!!document.querySelector('[data-set-integration=\"synthv:on\"]')"), { label: "integration switch" });
      await click(page, "[data-set-integration=\"synthv:on\"]");
      await waitFor(async () => (await navPages(page)).includes("bridge"), { label: "Bridge nav to return" });
    });

    let status;
    await t.test("Connections turns MCP on and shows token-bearing client configs", async () => {
      await click(page, "[data-page=\"connections\"]");
      await waitFor(() => evaluate(page, "!!document.querySelector('#http-api-form')"), { label: "connections form" });
      await evaluate(page, `(() => { document.querySelector('#http-api-enabled').checked = true; document.querySelector('#http-agent-enabled').checked = true; document.querySelector('#http-internal-functions-enabled').checked = true; document.querySelector('#http-api-port').value = '${mcpPort}'; document.querySelector('#http-api-form').requestSubmit(); return true; })()`);
      await waitFor(() => evaluate(page, "document.querySelectorAll('.mcp-snippet').length === 4"), { label: "client snippets" });
      status = await invoke(page, "get_http_api_status");
      assert.equal(status.running, true, status.lastError ?? "MCP server is not running");
      assert.equal(typeof status.token, "string");
      assert.ok(status.token.length >= 32, "token must be long enough to resist guessing");
      const shown = await evaluate(page, "document.querySelector('[data-mcp-token]').textContent");
      assert.ok(!shown.includes(status.token), "the token must be masked until revealed");
      const claude = await evaluate(page, "document.querySelector('.mcp-snippet pre').textContent");
      assert.match(claude, new RegExp(`^claude mcp add --transport http toneshuttle http://127\\.0\\.0\\.1:${mcpPort}/mcp --header "Authorization: Bearer `));
      await click(page, "[data-toggle-mcp-token]");
      assert.equal(await evaluate(page, "document.querySelector('[data-mcp-token]').textContent"), status.token);
      await evaluate(page, "document.querySelector('.mcp-client-setup').scrollIntoView()");
      await shot("04-connections");
    });

    await t.test("the official MCP SDK client connects with the shown token and gets well-formed results", async () => {
      const { Client } = await import(pathToFileURL(join(sdkRoot, "client", "index.js")).href);
      const { StreamableHTTPClientTransport } = await import(pathToFileURL(join(sdkRoot, "client", "streamableHttp.js")).href);
      const client = new Client({ name: "toneshuttle-e2e", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(status.endpoint), { requestInit: { headers: { Authorization: `Bearer ${status.token}` } } }));
      try {
        assert.equal(client.getServerVersion()?.name, "toneshuttle");
        const { tools } = await client.listTools();
        const names = tools.map((tool) => tool.name).sort();
        assert.deepEqual(names, ["toolbox_agent", "toolbox_internal"]);
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
      await evaluate(page, "window.confirm = () => true");
      await click(page, "[data-rotate-mcp-token]");
      const next = await waitFor(async () => { const value = await invoke(page, "get_http_api_status"); return value.token !== status.token && value.running ? value : undefined; }, { label: "a new token" });
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
      const headers = (token) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });
      assert.equal((await fetch(next.endpoint, { method: "POST", headers: headers(status.token), body })).status, 401);
      assert.equal((await fetch(next.endpoint, { method: "POST", headers: headers(next.token), body })).status, 200);
    });

    await t.test("agent sessions carry the Toneshuttle identity and only the active integration's tools", async () => {
      const { createMockAnthropicServer, systemText } = await import("./fixtures/mock-anthropic-server.mjs");
      const mock = createMockAnthropicServer({ turns: [] });
      const mockPort = await mock.listen();
      const agentDir = join(homeDir, ".pi", "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: `http://127.0.0.1:${mockPort}` } } }), "utf8");
      // Must be in electron/main.ts's model catalog or select_ai_provider rejects it.
      const modelId = ["cla", "ude-sonnet-4-6"].join("");
      const runOnce = async (label) => {
        mock.push({ content: [{ type: "tool_use", id: `toolu_${label}`, name: "request_input", input: { question: "Which file?", missing: ["audio file path"] } }], stopReason: "tool_use", usage: { input: 100, output: 10, cacheWrite: 0 } });
        const conversation = await invoke(page, "new_conversation");
        const messages = await invoke(page, "send_message", { conversationId: conversation.id, input: "Analyze my vocal take.", runId: `run-${label}` });
        assert.equal(messages.at(-1).outcome.status, "needs_input", JSON.stringify(messages.at(-1).outcome));
        return mock.requests.at(-1);
      };
      try {
        await invoke(page, "set_mode", { mode: "ai" });
        await invoke(page, "add_ai_api_key", { provider: "anthropic", label: "Test key", apiKey: "test-api-key" });
        await invoke(page, "select_ai_provider", { provider: "anthropic", model: modelId });
        await invoke(page, "set_integration", { integration: "synthv", preference: "on" });
        const withSynthV = await runOnce("on");
        const system = systemText(withSynthV.system);
        assert.match(system, /You are the assistant built into Toneshuttle \(声梭\)/);
        assert.doesNotMatch(system, /coding assistant/i, "Pi's default identity must be replaced");
        assert.match(system, /Active integrations: Synthesizer V/);
        const names = withSynthV.tools.map((tool) => tool.name);
        for (const name of ["toolbox_audio_probe", "toolbox_lyrics_rhymes", "toolbox_history", "sv_status", "toolbox_cover", "request_input"]) assert.ok(names.includes(name), `missing ${name} in ${names}`);
        for (const tool of withSynthV.tools) assert.ok(!["oneOf", "anyOf", "allOf"].some((key) => key in (tool.input_schema ?? {})), `${tool.name} sends a top-level combinator to the Messages API`);
        await invoke(page, "set_integration", { integration: "synthv", preference: "off" });
        const withoutSynthV = await runOnce("off");
        assert.match(systemText(withoutSynthV.system), /Active integrations: none\./);
        const offNames = withoutSynthV.tools.map((tool) => tool.name);
        assert.ok(offNames.includes("toolbox_audio_probe"), "generic tools stay available without SynthV");
        assert.ok(!offNames.some((name) => name.startsWith("sv_") || name === "toolbox_cover"), `SynthV tools leaked into a session with the integration off: ${offNames}`);
      } finally { await mock.close(); }
    });

    await t.test("About carries the license, links and non-affiliation notice", async () => {
      await click(page, "[data-page=\"about\"]");
      await waitFor(() => evaluate(page, "!!document.querySelector('.about-notice')"), { label: "about page" });
      const about = await evaluate(page, "document.querySelector('.about-product').innerText");
      assert.match(about, /Apache-2\.0/);
      assert.match(about, /Dreamtonics/);
      assert.deepEqual(await evaluate(page, "[...document.querySelectorAll('[data-open-toolbox-project]')].map((button) => button.dataset.openToolboxProject)"), ["project", "issues", "terms"]);
      await shot("05-about");
    });
  } finally {
    page?.close();
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (process.env.TONESHUTTLE_E2E_KEEP !== "1") await Promise.all([profileDir, homeDir].map((directory) => rm(directory, { recursive: true, force: true }).catch(() => {})));
    if (process.env.TONESHUTTLE_E2E_DEBUG === "1") console.log(Buffer.concat(output).toString("utf8"));
  }
});
