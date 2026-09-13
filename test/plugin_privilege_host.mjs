import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = readFileSync(join(root, "src", "PiDesktop.Tauri", "src-tauri", "src", "agent_runtime_commands.rs"), "utf8");
const manager = readFileSync(join(root, "src", "PiDesktop.Tauri", "src-tauri", "src", "plugin_manager.rs"), "utf8");

test("the native host reauthorizes every plugin capability invocation", () => {
  assert.match(host, /plugin_id: String/);
  assert.match(host, /plugin_manager::authorize_capability/);
  assert.match(manager, /if !state\.enabled/);
  assert.match(manager, /插件未声明该宿主权限/);
  assert.match(manager, /internal_functions_enabled/);
  assert.match(manager, /advanced_functions_enabled/);
});

test("privileged host capabilities have explicit boundaries", () => {
  assert.match(host, /"activate"[\s\S]*=> "host\.internal"/);
  assert.match(host, /"synthv\.sandbox"/);
  assert.match(host, /"synthv\.authorization"/);
  assert.match(host, /"host\.network"/);
  assert.match(host, /url\.scheme\(\) != "https"/);
  assert.match(host, /is_public_address/);
  assert.match(host, /NETWORK_RESPONSE_LIMIT/);
  assert.match(host, /redirect\(reqwest::redirect::Policy::none\(\)\)/);
});

test("internal account operations stay explicit and require host.internal", () => {
  assert.match(host, /"force-activate"/);
  assert.match(host, /"recover-switch"/);
  assert.match(host, /"clear-local-session"/);
  assert.match(host, /"clear-offline-license-cache"/);
  assert.match(host, /"force-launch"/);
  assert.match(host, /"clear-local-session"[\s\S]*"clear-offline-license-cache"[\s\S]*=> "host\.internal"/);
  assert.doesNotMatch(host, /functionName|reflect|invokeInternal/);
});

test("internal diagnostics, paths, and runtime status are explicit capabilities", () => {
  assert.match(host, /"synthv\.diagnostics"/);
  assert.match(host, /"cached-state"/);
  assert.match(host, /"account-usage-for-slot"/);
  assert.match(host, /"voice-catalog"/);
  assert.match(host, /"synthv\.paths"/);
  assert.match(host, /"slot-folder"/);
  assert.match(host, /"sandbox-folder"/);
  assert.match(host, /"runtime\.internal"/);
  assert.match(host, /require_permission\(&invocation\.permission, "host\.internal"\)/);
  assert.match(host, /fn required_slot_id/);
});
