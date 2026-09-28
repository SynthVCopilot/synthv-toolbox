import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const desktopRoot = fileURLToPath(new URL("../src/PiDesktop.Tauri/", import.meta.url));
const mainScript = join(desktopRoot, "dist", "electron", "main.js");
const electronBinary = require(join(desktopRoot, "node_modules", "electron"));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(check, { timeoutMs = 15000, intervalMs = 100, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) throw lastError ?? new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

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
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    // Browser.close drops the socket before replying; without this, that send() would hang forever.
    this.socket.addEventListener("close", () => {
      for (const { resolve } of this.pending.values()) resolve(undefined);
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.socket?.close(); } catch { /* already closed */ }
  }
}

async function evaluate(page, expression, { awaitPromise = false, returnByValue = true, includeCommandLineAPI = false } = {}) {
  const result = await page.send("Runtime.evaluate", { expression, awaitPromise, returnByValue, includeCommandLineAPI });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`Evaluation failed: ${text}`);
  }
  return result.result.value;
}

async function screenshot(page, directory, name) {
  const result = await page.send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(directory, `${name}.png`), Buffer.from(result.data, "base64"));
}

async function listProcessesMatching(needle) {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid,command"]);
    return stdout.split("\n").filter((line) => line.includes(needle) && !line.includes("ps -eo"));
  } catch {
    return [];
  }
}

// Connects to the main process's own Node inspector (--inspect), not the renderer CDP target,
// so real OS-level window resizing can be driven without adding a debug command to shipped code.
async function connectInspector(port) {
  const target = await waitFor(async () => {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    return list.find((entry) => typeof entry.webSocketDebuggerUrl === "string");
  }, { label: "the main process inspector target" });
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  return client;
}

test("built Electron app boots, exposes the desktop bridge, and drives the Copilot effort UI over CDP", async (t) => {
  assert.equal(existsSync(mainScript), true, "dist/electron/main.js must exist; run build:electron first");

  const profileDir = await mkdtemp(join(tmpdir(), "synthv-electron-app-profile-"));
  const homeDir = await mkdtemp(join(tmpdir(), "synthv-electron-app-home-"));
  const tmpDir = await mkdtemp(join(tmpdir(), "synthv-electron-app-tmp-"));
  const bridgeDir = await mkdtemp(join(tmpdir(), "synthv-electron-app-bridge-"));
  const screenshotDir = process.env.ELECTRON_APP_TEST_SCREENSHOTS_DIR ?? await mkdtemp(join(tmpdir(), "synthv-electron-app-screenshots-"));
  await mkdir(screenshotDir, { recursive: true });
  const port = await freePort();
  const inspectorPort = await freePort();

  const stderrChunks = [];
  const stdoutChunks = [];
  // HOME/APPDATA/TMPDIR are redirected to temp dirs so SynthVService.scanInstallations() (run at startup)
  // never touches the real ~/Library or %APPDATA%; --user-data-dir already isolates app storage.
  // --use-mock-keychain/--password-store=basic avoid macOS Keychain access under the foreign HOME, which
  // otherwise hangs this Electron build's DevTools HTTP server in this sandbox (it logs "DevTools
  // listening" but /json/list never responds). SYNTHV_AGENT_BRIDGE_DIR is a temp dir too, so the live-run
  // subtest's fake host never touches a real SynthV installation.
  // PI_CODING_AGENT_DIR/PI_OFFLINE/PI_SKIP_VERSION_CHECK and clearing provider keys mirror agent-e2e.mjs's
  // isolation: the Pi SDK's getAgentDir() reads PI_CODING_AGENT_DIR before HOME, so a developer's own shell
  // exporting it would otherwise point this run at the real Pi agent directory and a live provider.
  const spawnEnv = { ...process.env };
  delete spawnEnv.ANTHROPIC_API_KEY;
  delete spawnEnv.OPENAI_API_KEY;
  delete spawnEnv.GOOGLE_API_KEY;
  delete spawnEnv.GEMINI_API_KEY;
  Object.assign(spawnEnv, {
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    HOME: homeDir,
    APPDATA: homeDir,
    TMPDIR: tmpDir,
    SYNTHV_AGENT_BRIDGE_DIR: bridgeDir,
    PI_CODING_AGENT_DIR: join(homeDir, ".pi", "agent"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  });
  const child = spawn(electronBinary, [`--inspect=${inspectorPort}`, "--use-mock-keychain", "--password-store=basic", mainScript, `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`], {
    cwd: desktopRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: spawnEnv,
  });
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

  let browserCdp;
  let pageCdp;
  let inspectorCdp;
  let exitResult;
  try {
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => undefined);
      return response?.ok ? response.json() : undefined;
    }, { label: "CDP endpoint to come up" });

    const versionInfo = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
    const targets = await waitFor(async () => {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = list.find((target) => target.type === "page");
      return page ? list : undefined;
    }, { label: "the main window target" });
    const pageTarget = targets.find((target) => target.type === "page");

    browserCdp = new CdpClient(versionInfo.webSocketDebuggerUrl);
    pageCdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await Promise.all([browserCdp.connect(), pageCdp.connect()]);
    await pageCdp.send("Runtime.enable");
    await pageCdp.send("Page.enable");
    inspectorCdp = await connectInspector(inspectorPort);

    await t.test("preload bridge is exposed to the renderer", async () => {
      const bridgeType = await waitFor(() => evaluate(pageCdp, "typeof window.toolboxDesktop"), { label: "window.toolboxDesktop" });
      assert.equal(bridgeType, "object");
    });

    await t.test("onboarding selects AI mode and opens Copilot", async () => {
      await waitFor(() => evaluate(pageCdp, "!!document.querySelector('[data-onboarding=\"ai\"]')"), { label: "onboarding AI card" });
      await evaluate(pageCdp, "document.querySelector('[data-onboarding=\"ai\"]').click()");
      await waitFor(() => evaluate(pageCdp, "!!document.querySelector('[data-page=\"copilot\"]')"), { label: "Copilot nav item" });
      await evaluate(pageCdp, "document.querySelector('[data-page=\"copilot\"]').click()");
      await waitFor(() => evaluate(pageCdp, "!!document.querySelector('.chat-effort-mode')"), { label: "Copilot effort group" });
      await screenshot(pageCdp, screenshotDir, "01-copilot");
    });

    let budgets;
    await t.test("the Low/Mid/High/Max group renders with Mid active and tooltips match agent_budgets", async () => {
      budgets = await evaluate(pageCdp, "window.toolboxDesktop.invoke('agent_budgets')", { awaitPromise: true });
      assert.deepEqual(Object.keys(budgets).sort(), ["high", "low", "max", "mid"]);
      for (const level of ["low", "mid", "high"]) {
        assert.equal(typeof budgets[level].maxTurns, "number", `${level} maxTurns must be numeric`);
        assert.equal(typeof budgets[level].maxTokens, "number", `${level} maxTokens must be numeric`);
      }
      assert.equal(budgets.max.maxTurns, null);
      assert.equal(budgets.max.maxTokens, null);

      const buttons = await evaluate(pageCdp, `Array.from(document.querySelectorAll('.chat-effort-mode button')).map((button) => ({
        level: button.dataset.agentEffort,
        active: button.classList.contains('active'),
        title: button.getAttribute('title'),
      }))`);
      assert.deepEqual(buttons.map((button) => button.level), ["low", "mid", "high", "max"]);
      assert.deepEqual(buttons.filter((button) => button.active).map((button) => button.level), ["mid"]);
      for (const button of buttons) {
        const budget = budgets[button.level];
        if (button.level === "max") {
          assert.doesNotMatch(button.title, /\d/, "the unlimited Max tooltip must not carry a stale numeric budget");
        } else {
          assert.match(button.title, new RegExp(`\\b${budget.maxTurns}\\b(?!\\s*k)`), `${button.level} tooltip must state its turn limit`);
          assert.match(button.title, new RegExp(`\\b${Math.round(budget.maxTokens / 1000)}k\\b`), `${button.level} tooltip must state its token limit`);
        }
      }
    });

    await t.test("clicking High persists agentEffort in desktop-settings.json", async () => {
      await evaluate(pageCdp, "document.querySelector('[data-agent-effort=\"high\"]').click()");
      await waitFor(() => evaluate(pageCdp, "document.querySelector('[data-agent-effort=\"high\"]').classList.contains('active')"), { label: "High to become active" });
      const settings = await waitFor(async () => {
        const raw = await readFile(join(profileDir, "desktop-settings.json"), "utf8").catch(() => undefined);
        return raw ? JSON.parse(raw) : undefined;
      }, { label: "desktop-settings.json to persist" });
      assert.equal(settings.agentEffort, "high");
    });

    async function assertNoticeDoesNotOverlapComposer(label, level) {
      // An earlier notice can still be on screen, so measure the toast announcing this level.
      const toastFor = `[...document.querySelectorAll('.feedback-stack .toast')].reverse().find((toast) => toast.textContent.includes(${JSON.stringify(level)}))`;
      await waitFor(() => evaluate(pageCdp, `!!${toastFor}`), { label: `the ${level} effort notice toast at ${label}` });
      const layout = await evaluate(pageCdp, `(() => {
        const toast = ${toastFor}.getBoundingClientRect();
        const composer = document.querySelector('.composer').getBoundingClientRect();
        return { toast: { left: toast.left, top: toast.top, right: toast.right, bottom: toast.bottom }, composer: { left: composer.left, top: composer.top, right: composer.right, bottom: composer.bottom } };
      })()`);
      const intersects = layout.toast.left < layout.composer.right && layout.toast.right > layout.composer.left
        && layout.toast.top < layout.composer.bottom && layout.toast.bottom > layout.composer.top;
      assert.equal(intersects, false, `the notice toast must not overlap the composer at ${label}`);
    }

    await t.test("switching effort shows a notice that does not overlap the composer", async () => {
      await assertNoticeDoesNotOverlapComposer("the default window size", "High");
      await screenshot(pageCdp, screenshotDir, "02-notice-vs-composer");
    });

    await t.test("get_agent_runtime_status reports running", async () => {
      const status = await evaluate(pageCdp, "window.toolboxDesktop.invoke('get_agent_runtime_status')", { awaitPromise: true });
      assert.equal(status.running, true);
    });

    await t.test("Copilot renders the goal, live-run and approvals slots", async () => {
      const slots = await evaluate(pageCdp, `({
        goal: !!document.getElementById('agent-goal-slot'),
        liveRun: !!document.getElementById('agent-live-run'),
        approvals: !!document.getElementById('agent-approvals-slot'),
      })`);
      assert.deepEqual(slots, { goal: true, liveRun: true, approvals: true });
    });

    await t.test("the agent transcripts setting toggles through set_agent_transcripts", async () => {
      const before = await evaluate(pageCdp, "window.toolboxDesktop.invoke('bootstrap')", { awaitPromise: true });
      assert.equal(typeof before.agentTranscriptsEnabled, "boolean");
      const after = await evaluate(pageCdp, "window.toolboxDesktop.invoke('set_agent_transcripts', { enabled: true })", { awaitPromise: true });
      assert.equal(after.agentTranscriptsEnabled, true);
      await evaluate(pageCdp, "window.toolboxDesktop.invoke('set_agent_transcripts', { enabled: false })", { awaitPromise: true });
    });

    await t.test("the settings page renders the transcripts copy, not the raw i18n key", async () => {
      await evaluate(pageCdp, "document.querySelector('[data-page=\"settings\"]').click()");
      await waitFor(() => evaluate(pageCdp, "!!document.querySelector('.agent-transcripts-settings')"), { label: "the transcripts settings panel" });
      const text = await evaluate(pageCdp, "document.querySelector('.agent-transcripts-settings').textContent");
      assert.doesNotMatch(text, /copilot\.agentTranscripts/);
      assert.match(text, /applies only to|仅影响之后/);
      await evaluate(pageCdp, "document.querySelector('[data-page=\"copilot\"]').click()");
    });

    // Drives the real OS window through the main process's own Node inspector; see connectInspector.
    async function resizeRealWindow(width, height) {
      await evaluate(inspectorCdp, `require('electron').BrowserWindow.getAllWindows()[0].setBounds({ width: ${width}, height: ${height} })`, { includeCommandLineAPI: true });
    }

    async function rectsFitViewport(label, selectors) {
      const layout = await evaluate(pageCdp, `(() => ({
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        rects: ${JSON.stringify(selectors)}.map((selector) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return { selector, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        }),
      }))()`);
      for (const rect of layout.rects) {
        if (!rect) continue;
        assert.equal(rect.left >= -1, true, `${rect.selector} left edge escapes the viewport at ${label}`);
        assert.equal(rect.top >= -1, true, `${rect.selector} top edge escapes the viewport at ${label}`);
        assert.equal(rect.right <= layout.innerWidth + 1, true, `${rect.selector} right edge escapes the viewport at ${label}`);
        assert.equal(rect.bottom <= layout.innerHeight + 1, true, `${rect.selector} bottom edge escapes the viewport at ${label}`);
      }
    }

    await t.test("a live run streams into #agent-live-run and approval cards drive sv_command approval", async () => {
      const mockServerFixture = await import("./fixtures/mock-anthropic-server.mjs");
      const fakeHostFixture = await import("./fixtures/synthv-fake-host.mjs");

      // Must be in electron/main.ts's model catalog or select_ai_provider rejects it.
      const modelId = ["cla", "ude-sonnet-4-6"].join("");
      const agentDir = join(homeDir, ".pi", "agent");
      await mkdir(agentDir, { recursive: true });

      const mock = mockServerFixture.createMockAnthropicServer({ turns: [] });
      const mockPort = await mock.listen();
      await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: `http://127.0.0.1:${mockPort}` } } }), "utf8");

      const writes = [];
      // delete_notes has no groupLocator/contextId guard requirements when contextId is omitted, so the
      // real classify -> submit -> approve -> execute path runs without a prior sv_query.
      // The fixture's handler is (action, params, raw), not a single request object.
      const fakeHost = await fakeHostFixture.startFakeHost({
        ipcDirectory: bridgeDir,
        handler: (action, params) => {
          if (action === "delete_notes") writes.push(params);
          return {};
        },
      });

      try {
        await evaluate(pageCdp, `window.toolboxDesktop.invoke('add_ai_api_key', ${JSON.stringify({ provider: "anthropic", label: "Test key", apiKey: "test-api-key" })})`, { awaitPromise: true });
        await evaluate(pageCdp, `window.toolboxDesktop.invoke('select_ai_provider', ${JSON.stringify({ provider: "anthropic", model: modelId })})`, { awaitPromise: true });
        // The two invokes above go straight through the raw preload bridge, bypassing the renderer's
        // own api.* wrappers that would also update its in-memory app/provider state; reload so the
        // renderer's next bootstrap() picks up the now-persisted provider selection.
        await evaluate(pageCdp, "window.location.reload()");
        await waitFor(() => evaluate(pageCdp, "!!document.querySelector('[data-page=\"copilot\"]')"), { label: "the nav after reload" });
        await evaluate(pageCdp, "document.querySelector('[data-page=\"copilot\"]').click()");
        await waitFor(() => evaluate(pageCdp, "!!document.getElementById('chat-form')"), { label: "the composer after reload" });
        await evaluate(pageCdp, "document.querySelector('[data-new-conversation]').click()");
        // Waits for the new-conversation run() task (newConversation + listConversations/agentApprovals)
        // to fully settle, not just for #chat-form to exist (it is always present on this page).
        await waitFor(() => evaluate(pageCdp, "!!document.querySelector('.session-item.active')"), { label: "the new conversation to finish creating" });

        // --- Run 1: a gated sv_command returns approval_pending; the model awaits it; Approve executes it. ---
        const deleteArgs = { action: "delete_notes", args: { trackIndex: 1, groupIndex: 1, notes: [{ noteIndex: 1, fingerprint: "fp-1" }] } };
        const plan1 = { goal: "Delete the stray notes.", doneCriteria: ["The stray notes are deleted."], todos: [{ id: "1", title: "Delete the stray notes", status: "in_progress" }] };
        mock.push({
          content: [
            { type: "text", chunks: ["Reading the ", "project, then ", "deleting the stray notes."], chunkDelayMs: 120 },
            { type: "tool_use", id: "toolu_1a", name: "update_plan", input: plan1 },
            { type: "tool_use", id: "toolu_1b", name: "sv_command", input: deleteArgs },
          ],
          stopReason: "tool_use",
        });
        mock.push({ content: [{ type: "tool_use", id: "toolu_2", name: "sv_await_approval", input: {} }], stopReason: "tool_use" });
        // A delay here gives the approvals push's own rAF-scheduled DOM patch (fired the moment the
        // broker settles) a wide, deterministic head start over this turn's own arrival, so the
        // "still in flight" check below cannot pass merely because both happen to finish around the
        // same instant.
        mock.push({ content: [{ type: "text", chunks: ["Confirming the deletion."], chunkDelayMs: 500 }, { type: "tool_use", id: "toolu_3", name: "complete_task", input: { summary: "Deleted the stray notes.", evidence: ["delete_notes executed"] } }], stopReason: "tool_use" });

        await evaluate(pageCdp, "document.getElementById('chat-input').value = 'Delete the stray notes.'");
        await evaluate(pageCdp, "document.getElementById('chat-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))");

        await waitFor(() => evaluate(pageCdp, "(document.getElementById('agent-live-run').textContent || '').includes('Reading the')"), { label: "the first streamed chunk to appear" });
        const firstSnapshot = await evaluate(pageCdp, "document.getElementById('agent-live-run').textContent");
        await waitFor(() => evaluate(pageCdp, `document.getElementById('agent-live-run').textContent !== ${JSON.stringify(firstSnapshot)}`), { label: "the streamed text to grow past the first chunk" });
        const pinned = await evaluate(pageCdp, `(() => { const el = document.querySelector('.messages'); return el.scrollHeight - el.scrollTop - el.clientHeight <= 32; })()`);
        assert.equal(pinned, true, ".messages must stay pinned to the bottom while streaming");

        await waitFor(() => evaluate(pageCdp, "!!document.querySelector('.agent-tool-activity-awaiting_approval')"), { label: "the awaiting_approval tool activity" });
        assert.match(await evaluate(pageCdp, "document.querySelector('.agent-tool-activity-awaiting_approval').textContent"), /delete_notes/);
        await waitFor(() => evaluate(pageCdp, "!!document.querySelector('[data-approve-agent]')"), { label: "the sv_command approval card" });
        assert.equal(writes.length, 0, "no write must reach the fake host before the approval is granted");
        function toolResultText(messages, toolUseId) {
          for (const message of messages ?? []) {
            for (const block of Array.isArray(message.content) ? message.content : []) {
              if (block.type !== "tool_result" || block.tool_use_id !== toolUseId) continue;
              if (typeof block.content === "string") return block.content;
              if (Array.isArray(block.content)) return block.content.map((entry) => entry.text ?? "").join("");
            }
          }
          return undefined;
        }
        const approvalPendingText = await waitFor(() => {
          for (const entry of mock.requests) {
            const text = toolResultText(entry.messages, "toolu_1b");
            if (text?.includes("approval_pending")) return text;
          }
          return undefined;
        }, { label: "the sv_command tool result to carry approval_pending" });
        assert.match(approvalPendingText, /"outcome":"approval_pending"/, "the sv_command tool result must report approval_pending");
        const cardShape = await evaluate(pageCdp, `(() => {
          const card = document.querySelector('.agent-approval');
          const countdown = card.querySelector('.agent-approval-countdown');
          return { hasRisk: !!card.querySelector('.agent-approval-risk-high'), countdownText: countdown.textContent, hasApprove: !!card.querySelector('[data-approve-agent]'), hasDeny: !!card.querySelector('[data-deny-agent]'), action: card.querySelector('.agent-approval-action').textContent };
        })()`);
        assert.equal(cardShape.hasRisk, true, "the card must show the high-risk badge");
        assert.notEqual(cardShape.countdownText, "", "the countdown must be pre-filled, never blank");
        assert.equal(cardShape.hasApprove, true);
        assert.equal(cardShape.hasDeny, true);
        assert.match(cardShape.action, /delete_notes/);

        // The minimum-window layout check, but with a live run and an approval card on screen
        // (sv_await_approval keeps this run blocked, so there is no race to finish resizing in time).
        await resizeRealWindow(960, 640);
        await waitFor(() => evaluate(pageCdp, "window.innerWidth <= 960"), { label: "resize to the minimum window size to apply", timeoutMs: 5000 });
        await rectsFitViewport("the minimum window size with a pending approval", [".chat-effort-mode", ".composer", ".agent-approval"]);
        await screenshot(pageCdp, screenshotDir, "03b-minimum-with-approval");
        await resizeRealWindow(1280, 860);
        await waitFor(() => evaluate(pageCdp, "window.innerWidth > 960"), { label: "resize back to 1280x860 to apply", timeoutMs: 5000 });

        // Arms a page-side watch before clicking, so it captures whether the run is still in flight
        // at the instant the resolution first renders, rather than racing this process's own poll loop.
        // Observes document.body, not the #agent-live-run node itself: decideApproval's click handler
        // triggers a full-page render that replaces that node, which would silently orphan an observer
        // attached to it before the live push's later scoped patch ever touches the new node.
        await evaluate(pageCdp, `void (window.__resolutionWatch = new Promise((resolve) => {
          const capture = () => {
            const node = document.querySelector('.agent-approval-resolution.agent-tool-activity-succeeded');
            if (!node) return false;
            resolve({ stillInFlight: !!document.querySelector('[data-cancel-agent-run]') });
            return true;
          };
          if (capture()) return;
          const observer = new MutationObserver(() => { if (capture()) observer.disconnect(); });
          observer.observe(document.body, { childList: true, subtree: true });
          setTimeout(() => { observer.disconnect(); resolve({ timedOut: true }); }, 10000);
        }))`);
        await evaluate(pageCdp, "document.querySelector('[data-approve-agent]').click()");

        await waitFor(() => writes.length > 0, { label: "the fake host to receive the approved write" });
        assert.equal(writes.length, 1, "exactly one write must reach the fake host");
        const resolutionWatch = await evaluate(pageCdp, "window.__resolutionWatch", { awaitPromise: true });
        assert.equal(resolutionWatch.stillInFlight, true, "the executed resolution must render via the live approvals push while the run is still in flight, not only once the run's own re-fetch runs after it ends");
        // The live-run panel itself clears once the run ends; the resolved-approvals list is expected
        // to keep showing there.
        await waitFor(() => evaluate(pageCdp, "!document.querySelector('#agent-live-run .agent-live')"), { label: "the live-run panel to clear after completion" });
        await waitFor(() => evaluate(pageCdp, "!!document.querySelector('.agent-status-chip')"), { label: "the persisted status chip" });
        assert.match(await evaluate(pageCdp, "document.querySelector('.messages').textContent"), /Deleted the stray notes\./);

        // --- Run 2: a gated sv_command is Denied; the model adapts and asks for input instead. ---
        mock.push({ content: [{ type: "text", chunks: ["Trying to delete more notes."], chunkDelayMs: 80 }, { type: "tool_use", id: "toolu_4", name: "sv_command", input: deleteArgs }], stopReason: "tool_use" });
        mock.push({ content: [{ type: "tool_use", id: "toolu_5", name: "sv_await_approval", input: {} }], stopReason: "tool_use" });
        mock.push({ content: [{ type: "tool_use", id: "toolu_6", name: "request_input", input: { question: "Which notes should be kept?", missing: ["note selection"] } }], stopReason: "tool_use" });

        await evaluate(pageCdp, "document.getElementById('chat-input').value = 'Delete more notes.'");
        await evaluate(pageCdp, "document.getElementById('chat-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))");
        await waitFor(() => evaluate(pageCdp, "!!document.querySelector('[data-deny-agent]')"), { label: "the second approval card" });
        await evaluate(pageCdp, "document.querySelector('[data-deny-agent]').click()");

        await waitFor(() => evaluate(pageCdp, "!!document.querySelector('.agent-approval-resolution.agent-tool-activity-failed')"), { label: "the denied resolution to appear in the live-run activity" });
        await waitFor(() => evaluate(pageCdp, "!!document.querySelector('.agent-status-needs_input')"), { label: "the needs-input status chip" });
        assert.equal(writes.length, 1, "a denied approval must never reach the fake host");

        // --- Run 3: Stop while streaming, with no approval involved (the original regression). ---
        // kind:"slow" holds the connection open until cancelled (or a 5s fallback) instead of a single
        // chunk followed by end_turn, which could finish and request an unqueued next turn before the click.
        mock.push({ kind: "slow" });
        await evaluate(pageCdp, "document.getElementById('chat-input').value = 'Do it again.'");
        await evaluate(pageCdp, "document.getElementById('chat-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))");
        await waitFor(() => evaluate(pageCdp, "!!document.querySelector('[data-cancel-agent-run]')"), { label: "the Stop button for the fourth run" });
        await evaluate(pageCdp, "document.querySelector('[data-cancel-agent-run]').click()");
        // "Stopping" is a transient label between the click and the run actually ending; with the mock
        // responding this fast it can come and go within a single poll interval, so it is not asserted.
        await waitFor(() => evaluate(pageCdp, "!!document.querySelector('.agent-status-cancelled')"), { label: "the cancelled status chip for the fourth run" });
      } finally {
        await fakeHost.stop();
        await mock.close();
      }
    });

    await t.test("resizing the real window keeps the effort group and composer inside the viewport", async () => {
      // The default window is already 1280x860, so resizing to it can be a no-op; settle on a
      // different size first so both target resizes are observable state changes.
      await resizeRealWindow(1100, 750);
      await waitFor(() => evaluate(pageCdp, "window.innerWidth <= 1100"), { label: "resize to 1100x750 to apply", timeoutMs: 5000 });

      await resizeRealWindow(1280, 860);
      await waitFor(() => evaluate(pageCdp, "window.innerWidth > 1100"), { label: "resize to 1280x860 to apply", timeoutMs: 5000 });
      await rectsFitViewport("1280x860", [".chat-effort-mode", ".composer"]);
      await screenshot(pageCdp, screenshotDir, "03-resized-1280x860");

      await resizeRealWindow(960, 640);
      await waitFor(() => evaluate(pageCdp, "window.innerWidth <= 960"), { label: "resize to the minimum window size to apply", timeoutMs: 5000 });
      await rectsFitViewport("minimum window size", [".chat-effort-mode", ".composer"]);
      await screenshot(pageCdp, screenshotDir, "04-resized-minimum");

      await evaluate(pageCdp, "document.querySelector('[data-agent-effort=\"mid\"]').click()");
      await assertNoticeDoesNotOverlapComposer("the minimum window size", "Mid");
      await screenshot(pageCdp, screenshotDir, "05-notice-vs-composer-minimum");
    });

    await t.test("the main process logs no error lines", () => {
      const stderrText = Buffer.concat(stderrChunks).toString("utf8");
      const errorLines = stderrText.split("\n").filter((line) => /error/i.test(line));
      assert.deepEqual(errorLines, []);
    });
  } finally {
    inspectorCdp?.close();
    pageCdp?.close();
    if (browserCdp) {
      try { await browserCdp.send("Browser.close"); } catch { /* best effort graceful shutdown */ }
    }
    browserCdp?.close();
    exitResult = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(undefined), 8000)),
    ]);
    if (!exitResult) child.kill("SIGKILL");
    exitResult = await exited;
    await rm(profileDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    await rm(tmpDir, { recursive: true, force: true });
    await rm(bridgeDir, { recursive: true, force: true });
    if (!process.env.ELECTRON_APP_TEST_SCREENSHOTS_DIR) await rm(screenshotDir, { recursive: true, force: true }).catch(() => undefined);
  }

  await t.test("the app quit cleanly and left no Electron process behind", async () => {
    assert.ok(exitResult, "the app must exit rather than be force-killed");
    assert.equal(exitResult.code, 0, "the app must exit with code 0");
    assert.equal(exitResult.signal, null, "the app must not have been killed by a signal");
    const stderrText = Buffer.concat(stderrChunks).toString("utf8");
    const errorLines = stderrText.split("\n").filter((line) => /error/i.test(line));
    assert.deepEqual(errorLines, [], "no error lines after shutdown");
    const leftover = await waitFor(async () => {
      const matches = await listProcessesMatching(profileDir);
      return matches.length === 0 ? [] : undefined;
    }, { timeoutMs: 5000, label: "leftover Electron processes to exit" }).catch(async () => listProcessesMatching(profileDir));
    assert.deepEqual(leftover, []);
  });
});
