import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const main = source("src", "PiDesktop.Tauri", "src", "main.ts");
const api = source("src", "PiDesktop.Tauri", "src", "api.ts");
const types = source("src", "PiDesktop.Tauri", "src", "types.ts");

test("smart SVP launch supports explicit format ambiguity and host choice", () => {
  assert.match(types, /projectFormat\?: "generation1" \| "generation2" \| "ambiguous"/);
  assert.match(types, /smartSvpLaunchAlwaysAsk: boolean/);
  assert.match(main, /svp-route-required/);
  assert.match(main, /svpFormatAmbiguous/);
  assert.match(main, /data-resolve-svp-host/);
});

test("pending cold-start routes are fetched after UI initialization", () => {
  assert.match(api, /pending_svp_route/);
  assert.match(main, /getPendingSvpRoute\(\)/);
  assert.doesNotMatch(main, /smartRoutingWorksOnlyWhileToolboxIsAlreadyRunning/);
});

test("Always ask is persisted through the backend setting", () => {
  assert.match(api, /set_svp_always_ask/);
  assert.match(main, /svp-routing-always-ask/);
});
