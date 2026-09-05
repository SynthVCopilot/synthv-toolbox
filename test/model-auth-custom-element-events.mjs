import assert from "node:assert/strict";
const { JSDOM } = await import(new URL("../src/PiDesktop.Tauri/node_modules/jsdom/lib/api.js", import.meta.url));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
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

dialog.shadowRoot.querySelector('[data-part="method-oauth"]').click();
await new Promise((resolve) => setTimeout(resolve, 0));
dialog.shadowRoot.querySelector('[data-provider-id="anthropic"]').click();
await new Promise((resolve) => setTimeout(resolve, 0));

let authorization;
dialog.addEventListener("authorize-oauth", (event) => { authorization = event.detail; });
dialog.shadowRoot.querySelector('[data-part="oauth-config"] button').click();
assert.deepEqual(authorization, ["anthropic"]);

let closed = false;
dialog.addEventListener("close", () => { closed = true; });
dialog.shadowRoot.querySelector('[data-part="close"]').click();
assert.equal(closed, true);

console.log("model-auth custom-element events passed");
