import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../src/PiDesktop.Tauri/package.json", import.meta.url));
const { parse } = require("@babel/parser");
const readSource = (name) => {
  const text = readFileSync(new URL(`../src/PiDesktop.Tauri/src/${name}`, import.meta.url), "utf8");
  return { text, statements: parse(text, { sourceType: "module", plugins: ["typescript"] }).program.body };
};
const main = readSource("main.ts");
const apiSource = readSource("api.ts");
const functionSource = (name) => {
  const node = main.statements.find((item) => item.type === "FunctionDeclaration" && item.id?.name === name);
  assert.ok(node, `Missing production function ${name}`);
  return main.text.slice(node.start, node.end);
};
const execute = (source, context = {}) => vm.runInNewContext(stripTypeScriptTypes(source, { mode: "transform" }), context);
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(api) {
  const listeners = new Map();
  const functions = ["renderSvpRouteDialog", "renderSvpRouteCandidate", "accountProbeSessionLabel", "svpRoutePlanFromPayload", "listenForSvpRouteRequests"].map(functionSource).join("\n");
  const instance = execute(`(() => {
    let pendingSvpRoute, error = "", notice = "", routeRequestGeneration = 0;
    const isTauri = () => true;
    const render = () => {};
    const formatError = (reason) => reason?.message ?? String(reason);
    const icon = () => "";
    const t = (key) => key;
    const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
    ${functions}
    return {
      listen: listenForSvpRouteRequests,
      html: (plan) => { pendingSvpRoute = plan; return renderSvpRouteDialog(); },
      state: () => ({ pendingSvpRoute, error, notice }),
    };
  })()`, { api, listen: async (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); } });
  return { ...instance, emit: (name, payload) => listeners.get(name)({ payload }) };
}
function route(projectPath = "C:\\Projects\\song.svp") {
  return {
    projectPath, formatVersion: 197, projectFormat: "ambiguous", requiredVoices: [],
    selectedSlotId: "host:flat:abc", selectedLaunchMode: "normal", requiresConfirmation: true,
    summary: "Choose a host", detail: "Format needs confirmation",
    candidates: [{ slotId: "host:flat:abc", displayName: "Flat <preview>", hostProfile: "flat", idle: true,
      launchMode: "normal", remoteUse: "unknown", sessionStatus: "ready", authorizationSource: "unknown",
      matchedVoices: [], missingOrUnknownVoices: [], exactAuthorizationMatch: false, reason: "Installed application" }],
  };
}
test("production API sends the selected host and Always ask setting to the backend", async () => {
  const declaration = apiSource.statements.map((item) => item.type === "ExportNamedDeclaration" ? item.declaration : item).filter((item) => item?.type === "VariableDeclaration").flatMap((item) => item.declarations).find((item) => item.id.name === "api");
  const properties = declaration.init.properties.filter((item) => ["setSvpLaunchAlwaysAsk", "getPendingSvpRoute", "launchSvpRoute"].includes(item.key.name));
  assert.equal(properties.length, 3);
  const calls = [];
  const api = execute(`({ ${properties.map((item) => apiSource.text.slice(item.start, item.end)).join(",")} })`, { call: async (name, args) => { calls.push([name, args]); return null; } });
  await api.setSvpLaunchAlwaysAsk(true);
  await api.setSvpLaunchAlwaysAsk(false);
  await api.getPendingSvpRoute();
  await api.launchSvpRoute("host:flat:abc", "C:\\Projects\\song.svp", "normal");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["set_svp_always_ask", { alwaysAsk: true }], ["set_svp_always_ask", { alwaysAsk: false }],
    ["pending_svp_route", null], ["launch_svp_route", { slotId: "host:flat:abc", projectPath: "C:\\Projects\\song.svp", mode: "normal" }],
  ]);
});
test("production dialog renders format and standalone host without account controls", () => {
  const html = harness({}).html(route());
  assert.match(html, /SVP v197/);
  assert.match(html, /settings.svpFormatAmbiguous/);
  assert.match(html, /Flat &lt;preview>/);
  assert.match(html, /data-launch-svp-route="host:flat:abc"/);
  assert.match(html, /settings.openWithHost/);
  assert.doesNotMatch(html, /accountUi.confirmThisAccount|accountUi.authorizationUnknownManualConfirmationRequired/);
  const empty = route(); empty.candidates = [];
  assert.match(harness({}).html(empty), /settings.noCompatibleHosts/);
});
test("a live route wins over the production startup pending request", async () => {
  const pending = deferred(); const started = deferred();
  const instance = harness({ getPendingSvpRoute: () => { started.resolve(); return pending.promise; } });
  const listening = instance.listen(); await started.promise;
  instance.emit("svp-route-request", route("live.svp")); pending.resolve(route("old.svp")); await listening;
  assert.equal(instance.state().pendingSvpRoute.projectPath, "live.svp");
});
test("a live error prevents a stale pending route from reopening the dialog", async () => {
  const pending = deferred(); const started = deferred();
  const instance = harness({ getPendingSvpRoute: () => { started.resolve(); return pending.promise; } });
  const listening = instance.listen(); await started.promise;
  instance.emit("svp-route-error", "The selected host is unavailable"); pending.resolve(route("old.svp")); await listening;
  assert.equal(instance.state().pendingSvpRoute, undefined);
  assert.equal(instance.state().error, "The selected host is unavailable");
});
test("a retained cold-start failure is shown after listeners initialize", async () => {
  const instance = harness({ getPendingSvpRoute: async () => { throw new Error("Invalid SVP"); } });
  await instance.listen();
  assert.equal(instance.state().pendingSvpRoute, undefined);
  assert.equal(instance.state().error, "Invalid SVP");
});
