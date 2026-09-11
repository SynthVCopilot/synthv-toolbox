import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(root, "src/PiDesktop.Tauri");
const release = "https://github.com/lsy-404/platform-kit/releases/download/v0.5.4";
const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
for (const name of ["core", "providers"]) {
  assert.equal(
    manifest.dependencies[`@model-auth/${name}`],
    `${release}/model-auth-${name}-0.5.4.tgz`,
  );
}
assert.equal(manifest.dependencies["@model-auth/vue"], "https://github.com/lsy-404/platform-kit/releases/download/v0.5.4/model-auth-vue-0.5.4.tgz");
const [lock, prepare, desktop, ffmpeg] = await Promise.all([
  readFile(path.join(packageRoot, "package-lock.json"), "utf8"),
  readFile(path.join(root, ".github/workflows/prepare-desktop.yml"), "utf8"),
  readFile(path.join(root, ".github/workflows/desktop.yml"), "utf8"),
  readFile(path.join(root, ".github/workflows/ffmpeg-verify.yml"), "utf8"),
]);
for (const value of [lock, prepare, desktop, ffmpeg]) {
  assert.doesNotMatch(value, /\.platform-kit-private|PLATFORM_KIT_TOKEN|prepare-model-auth/);
}
console.log("Public model-auth dependency contracts passed.");
