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

async function evaluate(page, expression, { awaitPromise = false, returnByValue = true } = {}) {
  const result = await page.send("Runtime.evaluate", { expression, awaitPromise, returnByValue });
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

test("built Electron app boots, exposes the desktop bridge, and drives the Copilot effort UI over CDP", async (t) => {
  assert.equal(existsSync(mainScript), true, "dist/electron/main.js must exist; run build:electron first");

  const profileDir = await mkdtemp(join(tmpdir(), "synthv-electron-app-profile-"));
  const screenshotDir = process.env.ELECTRON_APP_TEST_SCREENSHOTS_DIR ?? await mkdtemp(join(tmpdir(), "synthv-electron-app-screenshots-"));
  await mkdir(screenshotDir, { recursive: true });
  const port = await freePort();

  const stderrChunks = [];
  const stdoutChunks = [];
  const child = spawn(electronBinary, [mainScript, `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`], {
    cwd: desktopRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

  let browserCdp;
  let pageCdp;
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
      const buttons = await evaluate(pageCdp, `Array.from(document.querySelectorAll('.chat-effort-mode button')).map((button) => ({
        level: button.dataset.agentEffort,
        active: button.classList.contains('active'),
        title: button.getAttribute('title'),
      }))`);
      assert.deepEqual(buttons.map((button) => button.level), ["low", "mid", "high", "max"]);
      assert.deepEqual(buttons.filter((button) => button.active).map((button) => button.level), ["mid"]);
      for (const button of buttons) {
        const budget = budgets[button.level];
        if (budget && budget.maxTurns !== null && budget.maxTokens !== null) {
          assert.match(button.title, new RegExp(String(budget.maxTurns)));
          assert.match(button.title, new RegExp(String(Math.round(budget.maxTokens / 1000))));
        } else {
          assert.equal(button.title.length > 0, true);
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

    await t.test("get_agent_runtime_status reports running", async () => {
      const status = await evaluate(pageCdp, "window.toolboxDesktop.invoke('get_agent_runtime_status')", { awaitPromise: true });
      assert.equal(status.running, true);
    });

    await t.test("resizing the real window keeps the effort group and composer inside the viewport", async () => {
      // Electron's DevTools protocol has no Browser.getWindowForTarget/setWindowBounds handler (confirmed
      // absent from the compiled Electron Framework binary), so the dev-only debug_set_window_bounds
      // bridge command drives the actual OS window instead; every other interaction stays CDP-driven.
      async function resizeRealWindow(width, height) {
        await evaluate(pageCdp, `window.toolboxDesktop.invoke('debug_set_window_bounds', { width: ${width}, height: ${height} })`, { awaitPromise: true });
      }

      async function assertLayoutFitsViewport(label) {
        const layout = await evaluate(pageCdp, `(() => {
          const effort = document.querySelector('.chat-effort-mode').getBoundingClientRect();
          const composer = document.querySelector('.composer').getBoundingClientRect();
          return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, effort: { left: effort.left, top: effort.top, right: effort.right, bottom: effort.bottom }, composer: { left: composer.left, top: composer.top, right: composer.right, bottom: composer.bottom } };
        })()`);
        for (const [name, rect] of [["effort group", layout.effort], ["composer", layout.composer]]) {
          assert.equal(rect.left >= -1, true, `${name} left edge escapes the viewport at ${label}`);
          assert.equal(rect.top >= -1, true, `${name} top edge escapes the viewport at ${label}`);
          assert.equal(rect.right <= layout.innerWidth + 1, true, `${name} right edge escapes the viewport at ${label}`);
          assert.equal(rect.bottom <= layout.innerHeight + 1, true, `${name} bottom edge escapes the viewport at ${label}`);
        }
      }

      // The default window is already 1280x860, so resizing to it can be a no-op; settle on a
      // different size first so both target resizes are observable state changes.
      await resizeRealWindow(1100, 750);
      await waitFor(() => evaluate(pageCdp, "window.innerWidth <= 1100"), { label: "resize to 1100x750 to apply", timeoutMs: 5000 });

      await resizeRealWindow(1280, 860);
      await waitFor(() => evaluate(pageCdp, "window.innerWidth > 1100"), { label: "resize to 1280x860 to apply", timeoutMs: 5000 });
      await assertLayoutFitsViewport("1280x860");
      await screenshot(pageCdp, screenshotDir, "02-resized-1280x860");

      await resizeRealWindow(960, 640);
      await waitFor(() => evaluate(pageCdp, "window.innerWidth <= 960"), { label: "resize to the minimum window size to apply", timeoutMs: 5000 });
      await assertLayoutFitsViewport("minimum window size");
      await screenshot(pageCdp, screenshotDir, "03-resized-minimum");
    });

    await t.test("the main process logs no error lines", () => {
      const stderrText = Buffer.concat(stderrChunks).toString("utf8");
      const errorLines = stderrText.split("\n").filter((line) => /error/i.test(line));
      assert.deepEqual(errorLines, []);
    });
  } finally {
    pageCdp?.close();
    if (browserCdp) {
      try { await browserCdp.send("Browser.close"); } catch { /* best effort graceful shutdown */ }
    }
    browserCdp?.close();
    const result = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(undefined), 8000)),
    ]);
    if (!result) child.kill("SIGKILL");
    await exited;
    await rm(profileDir, { recursive: true, force: true });
    if (!process.env.ELECTRON_APP_TEST_SCREENSHOTS_DIR) await rm(screenshotDir, { recursive: true, force: true }).catch(() => undefined);
  }

  await t.test("the app quit and left no Electron process behind", async () => {
    const leftover = await waitFor(async () => {
      const matches = await listProcessesMatching(profileDir);
      return matches.length === 0 ? [] : undefined;
    }, { timeoutMs: 5000, label: "leftover Electron processes to exit" }).catch(async () => listProcessesMatching(profileDir));
    assert.deepEqual(leftover, []);
  });
});
