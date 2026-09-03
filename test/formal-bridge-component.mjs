import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const component = join(root, "src", "PiDesktop.Tauri", "src-tauri", "components", "synthv-agent-bridge");
const app = join(root, "src", "PiDesktop.Tauri");

assert.ok(existsSync(join(component, "package.json")));
assert.ok(existsSync(join(component, "package-lock.json")));
assert.ok(existsSync(join(component, "src", "cli.ts")));
assert.ok(existsSync(join(component, "synthv", "SynthVAgentBridge.lua")));
assert.ok(existsSync(join(component, "legacy-sv1", "src", "cli.ts")));
assert.equal(existsSync(join(component, ".git")), false);
assert.equal(existsSync(join(root, ".gitmodules")), false);
assert.match(readFileSync(join(app, "scripts", "ensure-bridge.mjs"), "utf8"), /components.synthv-agent-bridge/);
assert.doesNotMatch(readFileSync(join(app, "src-tauri", "src", "lib.rs"), "utf8"), /external.synthv-agent-bridge/);

console.log("Formal Bridge component contracts passed.");
