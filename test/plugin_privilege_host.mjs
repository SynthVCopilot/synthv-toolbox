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
  assert.match(host, /"activate" => "host\.internal"/);
  assert.match(host, /"synthv\.sandbox"/);
  assert.match(host, /"synthv\.authorization"/);
  assert.match(host, /"host\.network"/);
  assert.match(host, /url\.scheme\(\) != "https"/);
  assert.match(host, /is_public_address/);
  assert.match(host, /NETWORK_RESPONSE_LIMIT/);
  assert.match(host, /redirect\(reqwest::redirect::Policy::none\(\)\)/);
});
