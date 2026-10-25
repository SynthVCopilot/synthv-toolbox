import assert from "node:assert/strict";
import test from "node:test";
import { createProviderUsage, toRendererUsage } from "../../../src/PiDesktop.Tauri/dist/electron/services/ai-usage.js";

const ISO = "2026-10-25T12:00:00.000Z";
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const authorizationOf = init => init?.headers?.authorization ?? init?.headers?.Authorization;

/** An in-memory stand-in for the account's sealed OAuth login, with the same read/modify contract. */
function credentialStore(initial) {
  let current = initial;
  return {
    current: () => current,
    for: () => ({
      read: async () => current,
      list: async () => [],
      delete: async () => {},
      modify: async (_provider, update) => { const next = await update(current); if (next) current = next; return current; },
    }),
  };
}

const oauth = { type: "oauth", access: "access-1", refresh: "refresh-1", expires: Date.now() + 3_600_000, accountId: "acct-1" };
const anthropicRoutes = (hits, usage) => async (url, init) => {
  const target = String(url);
  hits.push({ target, authorization: authorizationOf(init) });
  if (target.endsWith("/api/oauth/usage")) return usage(init);
  if (target.endsWith("/api/oauth/profile")) return json({ organization: { uuid: "org-1", organization_type: "claude_max" } });
  if (target.includes("/subscription_details")) return json({ subscription: { billing_interval: "month" } });
  throw new Error(`unexpected request ${target}`);
};

test("Anthropic readings reach the renderer as windows with percent used and reset time", async () => {
  const hits = [];
  const usage = createProviderUsage({
    credentialStore: credentialStore(oauth).for,
    fetchImpl: anthropicRoutes(hits, () => json({ subscription_type: "max", five_hour: { utilization: 42, resets_at: ISO }, seven_day: { utilization: 7, resets_at: ISO } })),
  });
  const { accounts } = await usage.query("anthropic", ["cred-1"]);
  assert.equal(accounts.length, 1);
  const [account] = accounts;
  assert.equal(account.credentialId, "cred-1");
  assert.equal(account.providerId, "anthropic");
  assert.equal(account.status, "ok");
  assert.equal(account.error, null);
  const session = account.windows.find(window => window.usedPercent === 42);
  assert.ok(session, "the 42% window is reported");
  assert.equal(session.remainingPercent, 58);
  assert.equal(session.resetAt, Date.parse(ISO));
  assert.equal(account.windows.length, 2);
  assert.ok(hits.some(hit => hit.target.endsWith("/api/oauth/usage")) && hits.filter(hit => hit.target.includes("/api/")).every(hit => hit.authorization === "Bearer access-1"), "requests carry the stored access token");
});

test("a rejected token is renewed once through the credential store and the read retried", async () => {
  const store = credentialStore(oauth);
  const refreshes = [];
  const fetchImpl = async (url, init) => {
    const target = String(url);
    if (target.includes("/oauth/token")) { refreshes.push(target); return json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }); }
    return anthropicRoutes([], request => authorizationOf(request) === "Bearer access-2" ? json({ five_hour: { utilization: 10, resets_at: ISO } }) : json({ error: { message: "expired" } }, 401))(url, init);
  };
  const usage = createProviderUsage({ credentialStore: store.for, fetchImpl });
  const { accounts } = await usage.query("anthropic", ["cred-1"]);
  assert.equal(accounts[0].status, "ok");
  assert.equal(accounts[0].windows[0].usedPercent, 10);
  assert.equal(store.current().access, "access-2", "the renewed login is stored");
  assert.equal(store.current().refresh, "refresh-2");
  assert.equal(refreshes.length, 1, "one renewal for the whole read");
});

test("a failed read reports the error and keeps the last good windows", async () => {
  let clock = 1_000_000;
  let healthy = true;
  const usage = createProviderUsage({
    credentialStore: credentialStore(oauth).for,
    now: () => clock,
    fetchImpl: anthropicRoutes([], () => healthy ? json({ five_hour: { utilization: 30, resets_at: ISO } }) : json({ error: { message: "busy" } }, 503)),
  });
  const first = (await usage.query("anthropic", ["cred-1"])).accounts[0];
  assert.equal(first.status, "ok");
  clock += 60 * 60_000;
  healthy = false;
  const second = (await usage.query("anthropic", ["cred-1"])).accounts[0];
  assert.equal(second.windows[0].usedPercent, 30, "the last good window is still shown");
  assert.match(String(second.error), /503|busy/);
});

test("reads inside the minimum interval reuse the held reading instead of calling the provider", async () => {
  const hits = [];
  const usage = createProviderUsage({
    credentialStore: credentialStore(oauth).for,
    fetchImpl: anthropicRoutes(hits, () => json({ five_hour: { utilization: 5, resets_at: ISO } })),
  });
  await usage.query("anthropic", ["cred-1"]);
  const calls = hits.length;
  const again = (await usage.query("anthropic", ["cred-1"])).accounts[0];
  assert.equal(hits.length, calls);
  assert.equal(again.windows[0].usedPercent, 5);
});

test("providers without a usage service report unknown and accounts without an OAuth login report an error", async () => {
  const requests = [];
  const usage = createProviderUsage({ credentialStore: credentialStore(oauth).for, fetchImpl: async url => { requests.push(String(url)); throw new Error("no request expected"); } });
  const workbuddy = (await usage.query("workbuddy", ["a"])).accounts[0];
  assert.equal(workbuddy.status, "unknown");
  assert.deepEqual(workbuddy.windows, []);
  assert.equal(requests.length, 0);
  const apiKeyOnly = createProviderUsage({ credentialStore: () => ({ read: async () => ({ type: "api_key", key: "k" }), list: async () => [], modify: async () => undefined, delete: async () => {} }) });
  const account = (await apiKeyOnly.query("openai-codex", ["b"])).accounts[0];
  assert.equal(account.status, "error");
  assert.match(account.error, /Sign in again/);
});

test("Codex readings carry plan, window and balance in the renderer shape", async () => {
  const usage = createProviderUsage({
    credentialStore: credentialStore(oauth).for,
    fetchImpl: async (url, init) => {
      assert.ok(String(url).endsWith("/backend-api/wham/usage"));
      assert.ok(Object.values(init.headers).includes("acct-1"), "the account id header is sent");
      return json({ plan_type: "pro", rate_limit: { primary_window: { used_percent: 12.5, limit_window_seconds: 18000, reset_at: 1_800_000_000 } }, credits: { balance: 3.5 } });
    },
  });
  const account = (await usage.query("openai-codex", ["c"])).accounts[0];
  assert.equal(account.status, "ok");
  assert.equal(account.plan, "pro");
  assert.equal(account.windows[0].usedPercent, 12.5);
  assert.equal(account.windows[0].remainingPercent, 87.5);
  assert.equal(account.windows[0].resetAt, 1_800_000_000_000);
  assert.equal(account.balance.amount, 3.5);
});

test("toRendererUsage keeps only fields the settings page models", () => {
  const shaped = toRendererUsage({ providerId: "anthropic", credentialId: "x", status: "ok", plan: "max", windows: [{ id: "w", label: "5h", scope: "account", modelFamilies: [], status: "known", usedRatio: 0.5, reliability: "high", kind: "session", usedPercent: 50, resetAt: null }], balance: null, fetchedAtUtc: ISO, error: null, identity: "org-1" });
  assert.equal("identity" in shaped, false);
  assert.equal(shaped.windows[0].remainingPercent, 50);
  assert.equal("scope" in shaped.windows[0], false);
});
