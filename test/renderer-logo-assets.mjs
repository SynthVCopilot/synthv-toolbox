import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appRoot = join(root, "src", "PiDesktop.Tauri");
const logo = "./assets/synthv-toolbox-logo.svg";
const read = (path) => readFileSync(path, "utf8");
const index = read(join(appRoot, "index.html"));
const about = read(join(appRoot, "src", "about.ts"));
const main = read(join(appRoot, "src", "main.ts"));
const vite = read(join(appRoot, "vite.config.ts"));

assert.ok(existsSync(join(appRoot, "public", "assets", "synthv-toolbox-logo.svg")));
for (const source of [index, about, main]) {
  assert.ok(source.includes(logo));
  assert.ok(!source.includes('"/assets/synthv-toolbox-logo.svg"'));
}
assert.match(vite, /base:\s*["']\.\/["']/);

console.log("Renderer logo asset paths are file-protocol safe.");
