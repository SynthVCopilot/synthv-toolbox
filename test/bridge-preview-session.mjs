import assert from "node:assert/strict";
import { AGENT_EFFORT_LEVELS, DEFAULT_AGENT_EFFORT, estimateAgentRunBudget } from "../packages/runtime-protocol/dist/index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripTypeScriptTypes } from "node:module";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let source = readFileSync(join(root, "src", "PiDesktop.Tauri", "src", "api.ts"), "utf8");
const brandSource = stripTypeScriptTypes(readFileSync(join(root, "src", "PiDesktop.Tauri", "src", "brand.ts"), "utf8"), { mode: "transform" });
const { BRAND } = await import(`data:text/javascript;base64,${Buffer.from(brandSource).toString("base64")}`);
source = source
  .replace(/^import[^;]+;\r?\n/gmu, "")
  .replace(/^import type \{[\s\S]*?\} from "\.\/types";\r?\n/mu, "")
  .replace("const preview = !hasDesktopBridge();", "const preview = true;")
  .replace("export const api =", "const api =");
source = stripTypeScriptTypes(source);
const api = Function("packageJson", "AGENT_EFFORT_LEVELS", "DEFAULT_AGENT_EFFORT", "estimateAgentRunBudget", "BRAND", `${source}; return api;`)(
  { version: "preview" }, AGENT_EFFORT_LEVELS, DEFAULT_AGENT_EFFORT, estimateAgentRunBudget, BRAND,
);

await api.autoConnectSynthvBridge(4202, "preview-4202");
let status = await api.bridgeSessionStatus();
assert.equal(status.connected, true);
assert.equal(status.requestedProcessId, 4202);
assert.equal(status.instanceOwnership, "unverified");

await api.stopSynthvBridge(4202, "preview-4202");
status = await api.bridgeSessionStatus();
assert.equal(status.connected, false);
assert.equal(status.requestedProcessId, null);

console.log("Bridge preview activation and stop flow passed.");
