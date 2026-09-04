import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = readFileSync(join(root, ".github", "workflows", "ffmpeg-verify.yml"), "utf8").replace(
  /\r\n/g,
  "\n",
);

assert.match(workflow, /^name: Toolbox Dev Build\n/);
assert.match(workflow, /^on:\n  pull_request:\n  push:\n    branches: \[main\]\n  workflow_dispatch:\n/m);
assert.equal((workflow.match(/npm run tauri build/g) ?? []).length, 1);
assert.match(workflow, /bundles: nsis/);
assert.match(workflow, /bundles: app,dmg/);
assert.match(workflow, /target: x86_64-pc-windows-msvc/);
assert.match(workflow, /target: universal-apple-darwin/);
assert.equal((workflow.match(/actions\/upload-artifact@v4/g) ?? []).length, 1);
assert.match(workflow, /name: synthv-toolbox-dev-\$\{\{ matrix\.target \}\}/);
assert.match(workflow, /synthv-toolbox-dev-\$\{\{ matrix\.target \}\}\.app\.zip/);
assert.match(workflow, /synthv-toolbox-dev-\$\{\{ matrix\.target \}\}\.dmg/);
assert.match(workflow, /synthv-toolbox-dev-\$\{\{ matrix\.target \}\}-nsis\.exe/);
assert.match(workflow, /synthv-toolbox-artifacts\/\$\{\{ matrix\.target \}\}/);
assert.match(workflow, /dmg_path="\$\(find[\s\S]*?cp "\$dmg_path"/);
assert.equal((workflow.match(/if-no-files-found: error/g) ?? []).length, 1);
assert.equal((workflow.match(/retention-days: 14/g) ?? []).length, 1);
assert.match(workflow, /name: Upload development build artifact/);

console.log("Development build artifact workflow contracts passed.");
