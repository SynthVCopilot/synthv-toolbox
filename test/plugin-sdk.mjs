import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(root, "packages", "plugin-sdk");
const outputDirectory = join(root, "test", ".tmp", "plugin-sdk");
const tsc = join(root, "src", "PiDesktop.Tauri", "node_modules", "typescript", "bin", "tsc");

if (!existsSync(tsc)) throw new Error("TypeScript compiler is unavailable. Install frontend dependencies before running this test.");
rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
execFileSync(process.execPath, [tsc, "-p", join(packageRoot, "tsconfig.json"), "--outDir", outputDirectory], { stdio: "inherit" });
writeFileSync(join(outputDirectory, "package.json"), '{"type":"module"}\n');
const sdk = await import(`${pathToFileURL(join(outputDirectory, "src", "index.js")).href}?contract=${Date.now()}`);
const fixture = await import(`${pathToFileURL(join(outputDirectory, "fixtures", "auto-tune", "plugin.js")).href}?contract=${Date.now()}`);

test("defines a runtime-protocol compatible plugin manifest", () => {
  assert.equal(fixture.default.id, "com.example.auto-tune");
  assert.equal(fixture.default.pages[0].entry, "ui/index.html");
  assert.equal(fixture.default.actions[0].location, "project.toolbar");
});

test("wraps only a supplied backend transport", async () => {
  const calls = [];
  const client = sdk.createHostApiClient({
    async request(method, params) {
      calls.push([method, params]);
      return { accepted: true };
    },
  });
  assert.deepEqual(await client.call("project.inspect", { id: "project-1" }), { accepted: true });
  assert.deepEqual(calls, [["project.inspect", { id: "project-1" }]]);
});

test("exchanges ready, request, response, and event messages with the iframe host", async () => {
  const listeners = new Map();
  const sent = [];
  const hostWindow = { postMessage(message) { sent.push(message); } };
  const pluginWindow = {
    parent: hostWindow,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
  };
  globalThis.window = pluginWindow;
  const client = sdk.createPluginGuiClient();
  client.ready();
  const events = [];
  client.onEvent((event, params) => events.push([event, params]));
  const request = client.request("project.inspect", { id: "project-1" });
  const requestMessage = sent.at(-1);
  listeners.get("message")({ source: hostWindow, data: { type: "plugin-ui:event", event: "project.changed", params: { id: "project-1" } } });
  listeners.get("message")({ source: hostWindow, data: { type: "plugin-ui:response", id: requestMessage.id, ok: true, result: { name: "Demo" } } });
  assert.equal(sent[0].type, "plugin-ui:ready");
  assert.deepEqual(await request, { name: "Demo" });
  assert.deepEqual(events, [["project.changed", { id: "project-1" }]]);
  client.dispose();
});

console.log("Plugin SDK contracts passed.");
