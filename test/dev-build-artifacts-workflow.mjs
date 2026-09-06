import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
assert.match(workflow, /name: Apply development version from source commit/);
assert.match(workflow, /id: version/);
assert.match(workflow, /set-dev-version\.mjs "\$\{\{ github\.sha \}\}"/);
assert.match(workflow, /bundles: nsis/);
assert.match(workflow, /bundles: app,dmg/);
assert.match(workflow, /name: Clear previous Windows bundle output/);
assert.match(workflow, /Remove-Item -LiteralPath \$bundlePath -Recurse -Force/);
assert.match(workflow, /Bundle path must remain inside the desktop target directory/);
assert.match(workflow, /name: Clear previous macOS bundle output/);
assert.match(workflow, /case "\$bundle_path" in "\$target_root"\/\*\) ;; \*\) exit 1 ;; esac/);
assert.match(workflow, /rm -rf "\$bundle_path"/);
assert.match(workflow, /target: x86_64-pc-windows-msvc/);
assert.match(workflow, /target: universal-apple-darwin/);
assert.match(workflow, /actions\/cache@v5/);
assert.doesNotMatch(workflow, /actions\/cache@v4/);
assert.equal((workflow.match(/actions\/upload-artifact@v4/g) ?? []).length, 1);
assert.match(workflow, /name: synthv-toolbox-\$\{\{ steps\.version\.outputs\.version \}\}-\$\{\{ matrix\.target \}\}/);
assert.match(workflow, /synthv-toolbox-\$\{\{ steps\.version\.outputs\.version \}\}-\$\{\{ matrix\.target \}\}\.app\.zip/);
assert.match(workflow, /synthv-toolbox-\$\{\{ steps\.version\.outputs\.version \}\}-\$\{\{ matrix\.target \}\}\.dmg/);
assert.match(workflow, /synthv-toolbox-\$\{\{ steps\.version\.outputs\.version \}\}-\$\{\{ matrix\.target \}\}-nsis\.exe/);
assert.match(workflow, /synthv-toolbox-artifacts\/\$\{\{ matrix\.target \}\}/);
assert.match(workflow, /dmg_path="\$\(find[\s\S]*?cp "\$dmg_path"/);
assert.match(workflow, /Expected one NSIS bundle, found \$\(\$installers\.Count\)/);
assert.match(workflow, /test "\$dmg_count" -eq 1/);
assert.match(workflow, /test "\$app_count" -eq 1/);
assert.match(workflow, /plutil -extract CFBundleShortVersionString raw/);
assert.match(workflow, /test "\$app_version" = "\$\{\{ steps\.version\.outputs\.version \}\}"/);
assert.equal((workflow.match(/if-no-files-found: error/g) ?? []).length, 1);
assert.equal((workflow.match(/retention-days: 14/g) ?? []).length, 1);
assert.match(workflow, /name: Upload development build artifact/);

console.log("Development build artifact workflow contracts passed.");
execFileSync(process.execPath, [join(root, "test", "dev-build-version.mjs")], { stdio: "inherit" });
