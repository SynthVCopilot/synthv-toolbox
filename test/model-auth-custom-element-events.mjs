import assert from "node:assert/strict";
const { JSDOM } = await import(new URL("../src/PiDesktop.Tauri/node_modules/jsdom/lib/api.js", import.meta.url));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
// jsdom does not implement the browser top-layer methods.
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  SVGElement: dom.window.SVGElement,
  customElements: dom.window.customElements,
  CustomEvent: dom.window.CustomEvent,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle,
});

const { registerModelAuthElement } = await import(new URL("../src/PiDesktop.Tauri/node_modules/@model-auth/vue/dist/model-auth-element.js", import.meta.url));
registerModelAuthElement();
const dialog = document.createElement("model-auth-dialog");
dialog.open = true;
dialog.catalogStatus = { state: "ready", source: "models.dev" };
dialog.providers = [{
  id: "anthropic", name: "Anthropic", description: "OAuth", authMethods: ["oauth", "api-key"],
  available: true, oauthEnabled: true, loadStrategy: "round-robin", models: ["claude"],
  oauthModels: ["claude"], apiKeyModels: [], oauthCredentials: [], apiKeyCredentials: [],
}];
document.body.append(dialog);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(dialog.shadowRoot.querySelector("dialog")?.open, true);
assert.equal(dialog.shadowRoot.querySelectorAll(".model-auth-progress-segment").length, 3);
const stage = (title, value) => {
  assert.equal(dialog.shadowRoot.querySelector("h2").textContent, title);
  assert.equal(dialog.shadowRoot.querySelector('[role="progressbar"]').getAttribute("aria-valuenow"), String(value));
  assert.deepEqual([...dialog.shadowRoot.querySelectorAll(".model-auth-progress-fill")].map(node => node.style.width),
    [0, 1, 2].map(index => index < value ? "100%" : "0%"));
  assert.equal(dialog.shadowRoot.textContent.includes("模型与负载策略"), false);
  assert.equal(dialog.shadowRoot.textContent.includes("对当前提供商的所有已启用凭据生效"), false);
};
stage("选择方式", 0);

dialog.shadowRoot.querySelector('[data-part="method-oauth"]').click();
await new Promise((resolve) => setTimeout(resolve, 0));
stage("选择提供商", 1);
dialog.shadowRoot.querySelector('[data-provider-id="anthropic"]').click();
await new Promise((resolve) => setTimeout(resolve, 0));
stage("完成授权", 2);
assert.equal(dialog.shadowRoot.querySelector('[part="model-search"]'), null);

let authorization;
dialog.addEventListener("authorize-oauth", (event) => { authorization = event.detail; });
dialog.shadowRoot.querySelector('[data-part="oauth-config"] button').click();
assert.deepEqual(authorization, ["anthropic"]);
assert.equal(dialog.shadowRoot.querySelector('[role="progressbar"]').getAttribute("aria-valuenow"), "2");
assert.equal(dialog.shadowRoot.querySelector('[data-part="confirm"]'), null);
dialog.providers = [{ ...dialog.providers[0], oauthCredentials: [{ id: "verified", label: "Test", enabled: true, healthy: true, weight: 1 }] }];
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(dialog.shadowRoot.querySelector('[role="progressbar"]').getAttribute("aria-valuenow"), "3");
stage("确认", 3);
assert.equal(dialog.shadowRoot.querySelector('[data-part="oauth-config"]'), null);
assert.equal(dialog.shadowRoot.querySelector('[part="model-search"]'), null);
assert.equal(dialog.shadowRoot.querySelector('[part="model-row"]'), null);
dialog.shadowRoot.querySelector('[data-part="back"]').click();
await new Promise((resolve) => setTimeout(resolve, 0));
stage("完成授权", 2);
dialog.shadowRoot.querySelector('[data-part="continue-confirmation"]').click();
await new Promise((resolve) => setTimeout(resolve, 0));
stage("确认", 3);
assert.equal(dialog.shadowRoot.querySelector('[part="model-search"]'), null);
assert.equal(dialog.shadowRoot.querySelector('[part="model-row"]'), null);
let selection = 0;
dialog.addEventListener("select-model", () => { selection += 1; });
let closed = false;
dialog.addEventListener("close", () => { closed = true; });
dialog.shadowRoot.querySelector('[data-part="confirm"]').click();
assert.equal(selection, 0);
assert.equal(closed, true);

console.log("model-auth custom-element events passed");
