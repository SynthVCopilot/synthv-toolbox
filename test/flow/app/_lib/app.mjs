// Launches the built Electron app with isolated profiles and drives it only through window.toolboxDesktop.invoke over CDP.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const desktopRoot = fileURLToPath(new URL("../../../../src/PiDesktop.Tauri/", import.meta.url));
export const mainScript = join(desktopRoot, "dist", "electron", "main.js");
export const sdkRoot = join(desktopRoot, "components", "synthv-agent-bridge", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
const electronBinary = require(join(desktopRoot, "node_modules", "electron"));

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

export async function waitFor(check, { timeoutMs = 30000, intervalMs = 100, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    if (Date.now() >= deadline) throw lastError ?? new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export class CdpClient {
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
    // Browser.close drops the socket before replying; without this, that send() would hang forever.
    this.socket.addEventListener("close", () => { for (const { resolve } of this.pending.values()) resolve(undefined); this.pending.clear(); });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  close() { try { this.socket?.close(); } catch { /* already closed */ } }
}

export async function evaluate(client, expression, { awaitPromise = false, includeCommandLineAPI = false } = {}) {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, includeCommandLineAPI });
  if (result.exceptionDetails) throw new Error(`Evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  return result.result.value;
}

export const invoke = (page, command, args = {}) => evaluate(page, `window.toolboxDesktop.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`, { awaitPromise: true });

/** Environment that keeps the app away from the real home folder, SynthV installations and AI provider keys. */
export function isolatedEnv(homeDir, extra = {}) {
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", HOME: homeDir, APPDATA: homeDir, LOCALAPPDATA: homeDir, USERPROFILE: homeDir, PI_CODING_AGENT_DIR: join(homeDir, ".pi", "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", ...extra };
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "ELECTRON_RENDERER_URL"]) delete env[key];
  return env;
}

export async function makeTemporaryDirectory(prefix, cleanups) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }).catch(() => {}));
  return directory;
}

/** Points Pi's Anthropic provider at a local mock server for the isolated home. */
export async function useMockAnthropic(homeDir, mockPort) {
  const agentDir = join(homeDir, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: `http://127.0.0.1:${mockPort}` } } }), "utf8");
}

/** Starts the app; resolves once the renderer's preload bridge answers `bootstrap`. */
export async function startApp(args, env, { extraArgs = [] } = {}) {
  assert.equal(existsSync(mainScript), true, "dist/electron/main.js must exist; run build:electron first");
  const port = await freePort();
  const child = spawn(electronBinary, [...extraArgs, mainScript, ...args, `--remote-debugging-port=${port}`], { cwd: desktopRoot, stdio: ["ignore", "pipe", "pipe"], env });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, port, exited, stdout: () => Buffer.concat(stdout).toString("utf8"), stderr: () => Buffer.concat(stderr).toString("utf8") };
}

export async function openPage(app) {
  const target = await waitFor(async () => (await fetch(`http://127.0.0.1:${app.port}/json/list`).then((response) => response.json())).find((entry) => entry.type === "page"), { label: "the main window" });
  const page = new CdpClient(target.webSocketDebuggerUrl);
  await page.connect();
  await page.send("Runtime.enable");
  await waitFor(async () => (await evaluate(page, "typeof window.toolboxDesktop") === "object") && await invoke(page, "bootstrap"), { label: "the preload bridge and bootstrap" });
  return page;
}

/** Closes the browser over CDP so Electron quits normally, flushing Chromium storage and releasing the profile. */
export async function quitApp(app, page) {
  page?.close();
  try {
    const { webSocketDebuggerUrl } = await fetch(`http://127.0.0.1:${app.port}/json/version`).then((response) => response.json());
    const browser = new CdpClient(webSocketDebuggerUrl);
    await browser.connect();
    void browser.send("Browser.close");
  } catch { /* already gone */ }
  const result = await Promise.race([app.exited, new Promise((resolve) => setTimeout(() => resolve(undefined), 15000))]);
  if (result) return result;
  app.child.kill();
  return app.exited;
}
