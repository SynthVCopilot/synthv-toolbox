import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { JSDOM } from "../src/PiDesktop.Tauri/node_modules/jsdom/lib/api.js";
import { mountModelAuthDialog } from "../src/PiDesktop.Tauri/src/modelAuthDialog.ts";

function fixture(execute = async () => {}) {
  const dom = new JSDOM("<!doctype html><body><main id='app'></main></body>");
  globalThis.document = dom.window.document;
  const cancelled = [], calls = [];
  let closes = 0, updates = 0;
  const controller = mountModelAuthDialog({
    async execute(...args) { calls.push(args); return execute(...args); },
    async cancelAuthorization(id) { cancelled.push(id); },
    close() { closes++; },
    updated() { updates++; },
    formatError() { return "连接失败，请重试"; },
  });
  const element = document.querySelector("model-auth-dialog");
  controller.update({ open: true, providers: [] });
  return {
    controller, element, cancelled, calls,
    get closes() { return closes; }, get updates() { return updates; },
    emit(action, detail = ["anthropic"]) { element.dispatchEvent(new dom.window.CustomEvent(action, { detail })); },
  };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("未配置连接时发送会打开认证弹窗，不创建对话或发起模型请求", async () => {
  const source = await readFile(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function sendPrompt("), source.indexOf("async function refreshAiProviderSummary("));
  const run = () => assert.fail("must not start a model request");
  for (const provider of [undefined, { connected: false }]) {
    let opened = 0, refreshed = 0;
    const harness = new Function("activeAiProvider", "syncModelAuthDialog", "refreshAiCatalogLive", "run",
      `let aiProviderPickerOpen = false; ${stripTypeScriptTypes(body)}; return { sendPrompt, isOpen: () => aiProviderPickerOpen };`)(
      () => provider, () => opened++, () => refreshed++, run,
    );
    await harness.sendPrompt("test draft");
    assert.equal(harness.isOpen(), true);
    assert.equal(opened, 1);
    assert.equal(refreshed, 1);
  }
});

test("页面重绘只同步状态，不重新挂载或重复绑定动作", async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) f.controller.update({ open: true, providers: [{ id: String(i) }] });
  document.querySelector("#app").innerHTML = "<section>refreshed</section>";
  assert.equal(f.element.parentElement, document.body);
  assert.equal(document.querySelectorAll("model-auth-dialog").length, 1);
  f.emit("authorize-oauth");
  f.emit("authorize-oauth");
  await tick();
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0][2], /^[\da-f-]{36}$/);
  assert.equal(f.updates, 1);
  f.controller.dispose();
});

test("关闭保留弹窗节点供退出动画使用，并取消当前授权", async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  f.emit("reconnect-oauth", ["anthropic", "account-1"]);
  f.emit("close");
  assert.equal(f.closes, 1);
  assert.equal(f.element.open, false);
  assert.equal(f.element.isConnected, true);
  assert.deepEqual(f.cancelled, [f.calls[0][2]]);
  pending.resolve();
  await tick();
  assert.equal(f.updates, 0);
  assert.equal(f.element.open, false);
  f.controller.dispose();
});

test("重开后的新操作不受已取消请求的迟到错误影响", async () => {
  const first = deferred(), second = deferred();
  let count = 0;
  const f = fixture(() => (++count === 1 ? first : second).promise);
  f.emit("authorize-oauth");
  f.controller.close();
  f.controller.update({ open: true });
  f.emit("authorize-oauth");
  first.reject(new Error("old failure"));
  await tick();
  assert.equal(f.element.busy, true);
  assert.equal(f.element.error, null);
  second.resolve();
  await tick();
  assert.equal(f.element.busy, false);
  assert.equal(f.updates, 1);
  f.controller.dispose();
});

test("API 验证失败可重试，刷新不会清除错误或重建弹窗", async () => {
  let count = 0;
  const f = fixture(async () => { if (++count === 1) throw new Error("private detail"); });
  f.emit("add-api-key", [{ providerId: "anthropic", label: "Test", apiKey: "test-only-key" }]);
  await tick();
  assert.equal(f.element.error, "连接失败，请重试");
  f.controller.update({ open: true, providers: [{ id: "anthropic" }] });
  assert.equal(f.element.error, "连接失败，请重试");
  f.emit("add-api-key", [{ providerId: "anthropic", label: "Test", apiKey: "test-only-key" }]);
  await tick();
  assert.equal(f.element.error, null);
  assert.equal(f.calls.length, 2);
  f.controller.dispose();
});

test("只有模型选择成功后关闭，隐藏状态不接受新动作", async () => {
  const f = fixture();
  f.emit("select-model", [{ providerId: "anthropic", model: "test-model" }]);
  await tick();
  assert.equal(f.element.open, false);
  assert.equal(f.closes, 1);
  assert.equal(f.element.isConnected, true);
  f.emit("authorize-oauth");
  assert.equal(f.calls.length, 1);
  f.controller.dispose();
});

test("宿主关闭与销毁也会终止授权生命周期", async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  f.emit("authorize-oauth");
  f.controller.update({ open: false });
  assert.equal(f.cancelled.length, 1);
  f.controller.dispose();
  assert.equal(f.element.isConnected, false);
  pending.resolve();
  await tick();
  assert.equal(f.updates, 0);
});
