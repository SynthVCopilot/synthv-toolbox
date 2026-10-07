import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(root, "src/PiDesktop.Tauri");
const release = "https://github.com/lsy-404/platform-kit/releases/download";
const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
for (const [name, version] of [["core", "0.9.0"], ["providers", "0.13.0"], ["vue", "0.10.3"]]) {
  assert.equal(manifest.dependencies[`@model-auth/${name}`], `${release}/model-auth-${name}-v${version}/model-auth-${name}-${version}.tgz`);
  const installed = JSON.parse(await readFile(path.join(packageRoot, `node_modules/@model-auth/${name}/package.json`), "utf8"));
  assert.equal(installed.version, version);
}
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
