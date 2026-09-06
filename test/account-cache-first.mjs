import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

const source = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");
const start = source.indexOf("async function refreshAccountUsage(");
const end = source.indexOf("function startInstanceRefresh", start);
assert.ok(start >= 0 && end > start, "account refresh implementation must be found");
const pending = [];
let renders = 0;
const context = vm.createContext({
  app: { sv2AccountIndicatorEnabled: true }, page: "accounts", accountPageGeneration: 1,
  accountUsageRefreshInFlight: undefined, accountUsageRefreshScope: undefined, accountUsageRefreshPageGeneration: undefined,
  cachedAccountProfiles: undefined, profiles: { version: "cached" },
  render: () => { renders += 1; },
  api: {
    sv2AccountUsageSnapshot: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    sv2AccountUsageSnapshotForSlot: (slotId) => new Promise((resolve, reject) => pending.push({ resolve: (value) => resolve({ ...value, slotId }), reject })),
    sv2ProfileState: async () => ({ version: "state" }),
  },
  supportsWindowsSv2Extensions: () => true,
  formatError: (reason) => String(reason),
  error: "",
});
vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context);

const first = context.refreshAccountUsage();
const second = context.refreshAccountUsage();
assert.equal(pending.length, 1, "matching refreshes share one request");
pending.shift().resolve({ profiles: { version: "fresh" } });
await Promise.all([first, second]);
assert.equal(context.profiles.version, "fresh");

const stale = context.refreshAccountUsage();
assert.equal(pending.length, 1);
context.accountPageGeneration += 1;
context.page = "home";
pending.shift().resolve({ profiles: { version: "stale" } });
await stale;
assert.equal(context.profiles.version, "fresh", "a response after leaving accounts cannot replace cached cards");
assert.equal(renders, 1, "a response after leaving accounts cannot render the old page");

context.page = "accounts";
const oldPageRequest = context.refreshAccountUsage(undefined, context.accountPageGeneration);
assert.equal(pending.length, 1);
context.accountPageGeneration += 1;
const currentPageRequest = context.refreshAccountUsage(undefined, context.accountPageGeneration);
assert.equal(pending.length, 1, "a new page generation waits for the previous network request");
pending.shift().resolve({ profiles: { version: "old-page" } });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(pending.length, 1, "the current page starts a replacement request after the old request settles");
pending.shift().resolve({ profiles: { version: "current-page" } });
await Promise.all([oldPageRequest, currentPageRequest]);
assert.equal(context.profiles.version, "current-page", "re-entering accounts cannot reuse a stale request");

const failedRequest = context.refreshAccountUsage(undefined, context.accountPageGeneration);
context.accountPageGeneration += 1;
const retryAfterFailure = context.refreshAccountUsage("slot-b", context.accountPageGeneration);
pending.shift().reject(new Error("offline"));
await assert.rejects(failedRequest, /offline/);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(pending.length, 1, "a queued slot refresh still runs after an old request fails");
pending.shift().resolve({ profiles: { version: "after-failure" } });
await retryAfterFailure;
assert.equal(context.profiles.version, "after-failure");

let resolveCachedProfiles;
context.api.sv2CachedProfileState = () => new Promise((resolve) => { resolveCachedProfiles = resolve; });
context.profiles = undefined;
context.accountPageGeneration += 1;
context.loadCachedAccountPage(context.accountPageGeneration);
context.profiles = { version: "complete-from-instance-refresh" };
resolveCachedProfiles({ version: "late-lightweight-cache" });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(context.profiles.version, "complete-from-instance-refresh", "a late lightweight cache cannot overwrite a complete account snapshot");
pending.shift().resolve({ profiles: { version: "fresh-after-instance-refresh" } });
await new Promise((resolve) => setImmediate(resolve));

context.profiles = undefined;
context.accountPageGeneration += 1;
context.loadCachedAccountPage(context.accountPageGeneration);
assert.equal(pending.length, 0, "cold entry reads local cache before starting a remote refresh");
resolveCachedProfiles({ version: "cold-start-cache" });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(context.profiles.version, "cold-start-cache", "cached cards are visible while the remote refresh remains pending");
assert.equal(pending.length, 1);
pending.shift().reject(new Error("refresh unavailable"));
await new Promise((resolve) => setImmediate(resolve));
assert.equal(context.profiles.version, "cold-start-cache", "refresh failure keeps the cached cards visible");
assert.match(context.error, /refresh unavailable/);

context.profiles = undefined;
context.accountPageGeneration += 1;
context.loadCachedAccountPage(context.accountPageGeneration);
context.page = "home";
context.accountPageGeneration += 1;
resolveCachedProfiles({ version: "abandoned-cache" });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(context.profiles, undefined);
assert.equal(pending.length, 0, "leaving before the cache resolves does not start a remote refresh");

context.page = "accounts";
context.app.sv2AccountIndicatorEnabled = false;
context.accountPageGeneration += 1;
context.loadCachedAccountPage(context.accountPageGeneration);
resolveCachedProfiles({ version: "local-cache" });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(pending.length, 0, "disabling the account indicator does not send account requests");
assert.equal(context.profiles.version, "state", "local state still refreshes when account requests are disabled");
console.log("Account cache-first refresh behavior passed.");
