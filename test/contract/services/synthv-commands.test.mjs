import assert from "node:assert/strict";
import test from "node:test";

const modulePath = new URL("../../../src/PiDesktop.Tauri/electron/services/synthv-commands.ts", import.meta.url);
const { registerSynthVCommands } = await import(modulePath.href);

test("SynthV command mapping preserves validated API parameters", async () => {
  const handlers = new Map();
  const calls = [];
  const service = {
    scanInstallations: async () => [], profileState: async () => ({}), createProfile: async (...args) => calls.push(["create", ...args]), renameProfile: async (...args) => calls.push(["rename", ...args]), deleteProfile: async (...args) => calls.push(["delete", ...args]), activateProfile: async (...args) => calls.push(["activate", ...args]), prepareConcurrentProfile: async (...args) => calls.push(["prepare", ...args]), openProfileFolder: async (...args) => calls.push(["open", ...args]), readSession: async () => ({ path: "session", sha256: "a", plaintext: "content" }), writeSession: async (...args) => { calls.push(["write", ...args]); return { path: "session", sha256: "b" }; }, syncProfile: async (...args) => calls.push(["sync", ...args]), previewSvpRoute: async (...args) => calls.push(["route", ...args]), listProcesses: async () => [], focusInstance: async (...args) => calls.push(["focus", ...args]), terminateInstance: async (...args) => calls.push(["terminate", ...args]), shortcutProfile: () => ({}), sendShortcut: async (...args) => calls.push(["shortcut", ...args]), installBridge: async (...args) => calls.push(["install", ...args]), diagnoseBridge: async (...args) => calls.push(["diagnose", ...args]), setAutostart: async (...args) => calls.push(["autostart", ...args]), getAutostart: async () => ({ enabled: false }),
  };
  registerSynthVCommands({ register: (name, handler) => handlers.set(name, handler) }, service);
  await handlers.get("send_synthv_bridge_shortcut")({ processId: 7, processIdentity: "7:stable", action: "start" });
  for (const name of ["read_sv2_session_document", "write_sv2_session_document", "sv2_set_offline_license"]) assert.equal(handlers.has(name), false);
  await handlers.get("install_bridge")({ targets: [{ scriptsPath: "C:/scripts", bridgeProfile: "sv2" }] });
  assert.deepEqual(calls, [["shortcut", 7, "7:stable", "start"], ["install", [{ scriptsPath: "C:/scripts", bridgeProfile: "sv2" }]]]);
  assert.throws(() => handlers.get("send_synthv_bridge_shortcut")({ processId: 0, processIdentity: "x", action: "start" }), /positive integer/);
  assert.throws(() => handlers.get("install_bridge")({ targets: [{ scriptsPath: "", bridgeProfile: "sv2" }] }), /non-empty string/);
});
