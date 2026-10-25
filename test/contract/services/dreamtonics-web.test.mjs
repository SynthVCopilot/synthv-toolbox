import assert from "node:assert/strict";
import test from "node:test";
const { DreamtonicsWebAccounts } = await import(new URL("../../../src/PiDesktop.Tauri/electron/services/dreamtonics-web.ts", import.meta.url));

function fixture({ token = "Bearer synthetic", enroll, quit, invalidEnrollment = false } = {}) {
  const calls = [];
  const browser = {
    open: async () => calls.push("login"),
    clear: async () => calls.push("clear"),
    authorization: async () => token,
    fetch: async (url, init) => {
      const path = url.split("/").at(-1);
      calls.push(path);
      assert.equal(init.headers.Authorization, token);
      if (path === "my_licenses") return Response.json({ status: 200, data: [{ id: "private-license", product: { name: "Editor" }, status: "active", license_type: "permanent" }] });
      if (path === "my_devices") return Response.json({ status: 200, data: { offline_license_devices: [{ id: "private-device", device_name: "Computer", offline_license_enabled: true }] } });
      assert.equal(init.method, "POST");
      assert.equal(init.body, "{}");
      if (path === "test_enroll" && invalidEnrollment) return new Response("invalid json");
      return Response.json((path === "test_enroll" ? enroll : quit) ?? { status: 200, data: { status: "success" } });
    },
  };
  return { service: new DreamtonicsWebAccounts(() => browser), calls };
}

test("web query uses its own login and exits a successful connection test", async () => {
  const { service, calls } = fixture();
  const snapshot = await service.inspect("slot");
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.use, "available");
  assert.deepEqual(snapshot.offlineDevices, [{ name: "Computer", enabled: true }]);
  assert.deepEqual(snapshot.licenses, [{ name: "Editor", status: "active", type: "permanent" }]);
  assert.deepEqual(calls, ["my_licenses", "my_devices", "test_enroll", "test_quit"]);
  assert.doesNotMatch(JSON.stringify(snapshot), /synthetic|private-license|private-device/);
});

test("missing web sign-in never makes an API request", async () => {
  const { service, calls } = fixture({ token: null });
  assert.equal((await service.inspect("slot")).status, "loginRequired");
  assert.deepEqual(calls, []);
});

test("a concurrent-device rejection is busy and does not exit another test", async () => {
  const { service, calls } = fixture({ enroll: { status: 409, error: "device-concurrent-session-exceeded" } });
  const snapshot = await service.inspect("slot");
  assert.equal(snapshot.use, "busy");
  assert.equal(snapshot.status, "ready");
  assert.equal(calls.includes("test_quit"), false);
});

test("failed cleanup cannot report availability", async () => {
  const { service } = fixture({ quit: { status: 500 } });
  const snapshot = await service.inspect("slot");
  assert.equal(snapshot.use, "unknown");
  assert.equal(snapshot.status, "error");
});

test("a malformed successful response still exits the connection test", async () => {
  const { service, calls } = fixture({ invalidEnrollment: true });
  const snapshot = await service.inspect("slot");
  assert.equal(snapshot.use, "unknown");
  assert.equal(calls.at(-1), "test_quit");
});

test("repeated clicks share one in-flight query", async () => {
  const { service, calls } = fixture();
  const first = service.inspect("slot");
  const second = service.inspect("slot");
  assert.equal(first, second);
  await first;
  assert.equal(calls.filter(path => path === "test_enroll").length, 1);
});

test("forgetting an account clears its independent web session", async () => {
  const { service, calls } = fixture();
  await service.forget("slot");
  assert.deepEqual(calls, ["clear"]);
});
