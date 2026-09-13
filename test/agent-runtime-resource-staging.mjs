import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "src", "PiDesktop.Tauri", "package.json"), "utf8"));

assert.equal(packageJson.dependencies["@synthv-toolbox/agent-runtime"], "file:../../packages/agent-runtime");
assert.equal(packageJson.build.asar, true);
assert.ok(packageJson.build.files.includes("!resources/node/**"));
assert.ok(packageJson.build.files.includes("!node_modules/@synthv-toolbox/agent-runtime/node_modules/**"));
assert.equal(packageJson.scripts["prepare:bundled-node"], undefined);
assert.equal(packageJson.scripts["build:runtime"], undefined);

console.log("Electron runtime packaging contracts passed.");
