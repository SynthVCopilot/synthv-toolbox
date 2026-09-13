import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appRoot = join(root, "src", "PiDesktop.Tauri");
const packageJson = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
const main = readFileSync(join(appRoot, "src", "main.ts"), "utf8");

assert.match(packageJson.dependencies["@platform-kit/fluent"], /platform-kit-fluent-0\.2\.1\.tgz$/);
assert.match(main, /import \{ FluentSelect \} from "@platform-kit\/fluent\/vue"/);
assert.match(main, /import "@platform-kit\/fluent\/style\.css"/);
assert.match(main, /mountFluentSelect\("language-select-host"/);
assert.match(main, /mountFluentSelect\("update-channel-host"/);

console.log("Platform Kit Fluent selects are wired into settings controls.");
