import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(root, "src/PiDesktop.Tauri");
const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
for (const name of ["core", "providers", "vue"]) {
  assert.equal(manifest.dependencies[`@model-auth/${name}`], `file:.platform-kit-private/model-auth/model-auth-${name}-0.2.7.tgz`);
}
const lock = await readFile(path.join(packageRoot, "package-lock.json"), "utf8");
assert.doesNotMatch(lock, /github\.com\/lsy-404\/model-auth\/releases/);
assert.match(await readFile(path.join(packageRoot, ".gitignore"), "utf8"), /\.platform-kit-private/);
const action = await readFile(path.join(root, ".github/actions/prepare-model-auth/action.yml"), "utf8");
assert.match(action, /persist-credentials: false/);
assert.match(action, /ref: model-auth-private-v0\.2\.7/);
assert.match(action, /Configure PLATFORM_KIT_TOKEN/);
console.log("Private model-auth dependency and source-access contracts passed.");
