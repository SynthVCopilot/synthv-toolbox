import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appRoot = join(root, "src", "PiDesktop.Tauri");
const logo = "./assets/brand-logo.svg";
const read = (path) => readFileSync(path, "utf8");
const index = read(join(appRoot, "index.html"));
const brand = read(join(appRoot, "src", "brand.ts"));
const about = read(join(appRoot, "src", "about.ts"));
const main = read(join(appRoot, "src", "main.ts"));
const vite = read(join(appRoot, "vite.config.ts"));

assert.ok(existsSync(join(appRoot, "public", "assets", "brand-logo.svg")));
// The renderer reads the logo path from brand.ts so a rename cannot leave a stale asset reference behind.
for (const source of [index, brand]) assert.ok(source.includes(logo));
assert.match(main, /src="\$\{BRAND\.logo\}"/);
assert.match(about, /src="\$\{escapeHtml\(logo\)\}"/);
for (const source of [index, brand, about, main]) {
  assert.ok(!source.includes('"/assets/'), "absolute asset paths break file:// loading in packaged builds");
  assert.ok(!source.includes("synthv-toolbox-logo"), "the pre-rename logo asset no longer exists");
}
assert.match(vite, /base:\s*["']\.\/["']/);

console.log("Renderer logo asset paths are file-protocol safe.");
