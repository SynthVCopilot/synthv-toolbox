import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const require = createRequire(new URL("../src/PiDesktop.Tauri/package.json", import.meta.url));
const { parse } = require("@babel/parser");
const source = readFileSync(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");
const names = new Set(["refreshAutostartStatus", "changeAutostart", "renderSettings"]);
const functions = parse(source, { sourceType: "module", plugins: ["typescript"] }).program.body
  .filter(node => node.type === "FunctionDeclaration" && names.has(node.id.name));
assert.equal(functions.length, names.size);
const context = vm.createContext({
  app: { mode: "toolbox", svpAssociation: {}, configPath: "", appVersion: "test" },
  page: "settings", autostartQueryGeneration: 0, busy: false, notice: "", renders: 0,
  render() { context.renders += 1; },
  formatError: error => String(error),
  t: key => key, locale: () => "en", icon: () => "", escapeHtml: value => String(value),
  renderToolboxUpdateResult: () => "", toolboxUpdate: undefined,
  api: {},
});
vm.runInContext(stripTypeScriptTypes(functions.map(fn => source.slice(fn.start, fn.end)).join("\n"), { mode: "transform" }), context);

let queries = 0;
context.api.getAutostart = async () => { queries += 1; throw new Error("query unavailable"); };
await context.refreshAutostartStatus();
await new Promise(resolve => setImmediate(resolve));
assert.equal(queries, 1, "query failure must not schedule a render-driven retry");
assert.equal(context.renders, 2);
assert.equal(context.app.autostartEnabled, undefined);
assert.match(context.app.autostartError, /query unavailable/);

context.api.getAutostart = async () => ({ enabled: null, error: "unavailable" });
await context.refreshAutostartStatus();
assert.equal(context.app.autostartEnabled, undefined);
context.app.autostartEnabled = null;
assert.match(context.renderSettings(), /id="autostart-enabled"[^>]*disabled/);
assert.match(context.renderSettings(), /settings.unknown/);

context.api.getAutostart = async () => ({ enabled: false, error: null });
await context.refreshAutostartStatus();
assert.equal(context.app.autostartEnabled, false);
assert.equal(context.app.autostartError, undefined);
assert.doesNotMatch(context.renderSettings(), /id="autostart-enabled"[^>]*disabled/);
context.busy = true;
assert.match(context.renderSettings(), /id="autostart-enabled"[^>]*disabled/);
context.busy = false;

context.api.setAutostart = async enabled => enabled;
await context.changeAutostart(true);
assert.equal(context.app.autostartEnabled, true);
assert.equal(context.notice, "accountNotice.autostartEnabled");
assert.match(context.renderSettings(), /id="autostart-enabled"[^>]*checked/);

let finishQuery;
context.api.getAutostart = () => new Promise(resolve => { finishQuery = resolve; });
const stale = context.refreshAutostartStatus();
await context.changeAutostart(true);
finishQuery({ enabled: false, error: null });
await stale;
assert.equal(context.app.autostartEnabled, true, "an old query must not overwrite a completed toggle");

context.api.setAutostart = async () => { throw new Error("write failed"); };
context.api.getAutostart = async () => ({ enabled: false, error: null });
await assert.rejects(context.changeAutostart(true), /write failed/);
assert.equal(context.app.autostartEnabled, false, "failed writes must reread actual OS state");

context.api.getAutostart = () => new Promise(resolve => { finishQuery = resolve; });
const leaving = context.refreshAutostartStatus();
context.page = "home";
const rendersBefore = context.renders;
finishQuery({ enabled: true, error: null });
await leaving;
assert.equal(context.renders, rendersBefore, "a completed query must not render a different page");

console.log("Autostart production UI and async behavior passed.");
