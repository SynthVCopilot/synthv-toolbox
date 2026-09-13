import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "src", "PiDesktop.Tauri", "scripts", "prepare-bundled-node.mjs");
for (const target of ["x86_64-pc-windows-msvc", "aarch64-apple-darwin", "x86_64-unknown-linux-gnu"]) {
  const output = execFileSync(process.execPath, [script, "--dry-run"], { env: { ...process.env, SYNTHV_TOOLBOX_NODE_TARGET: target }, encoding: "utf8" });
  const manifest = JSON.parse(output);
  assert.equal(manifest.target, target);
  assert.equal(manifest.version, "22.19.0");
  assert.ok(manifest.archive);
}
console.log("Bundled Node target contract passed.");
