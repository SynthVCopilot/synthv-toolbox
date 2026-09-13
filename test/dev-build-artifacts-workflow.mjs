import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (filename) => readFileSync(join(root, filename), "utf8").replace(/\r\n/g, "\n");
const release = read(".github/workflows/desktop.yml");
const development = read(".github/workflows/ffmpeg-verify.yml");
const prepare = read(".github/workflows/prepare-desktop.yml");
const packageJson = JSON.parse(read("src/PiDesktop.Tauri/package.json"));

for (const workflow of [release, development]) {
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /npm ci --no-audit --no-fund/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /npm exec --prefix src\/PiDesktop\.Tauri -- electron-builder --config electron-builder\.yml/);
  assert.doesNotMatch(workflow, /cargo |tauri |tauri-action|gh release|download-artifact|nightly-release/);
}

assert.match(release, /tags: \["v\*"\]/);
assert.match(release, /GH_TOKEN: \$\{\{ github\.token \}\}/);
assert.match(release, /--publish always/);
assert.match(release, /name: Validate code-signing environment/);
assert.match(release, /CSC_LINK: \$\{\{ secrets\.CSC_LINK \}\}/);
assert.match(release, /CSC_KEY_PASSWORD: \$\{\{ secrets\.CSC_KEY_PASSWORD \}\}/);
assert.match(release, /CSC_NAME: \$\{\{ secrets\.CSC_NAME \}\}/);
assert.match(release, /Missing code-signing environment/);
assert.match(release, /target: --win/);
assert.match(release, /target: --mac/);
assert.match(development, /pull_request:/);
assert.match(development, /branches: \[main\]/);
assert.match(development, /--publish never/);
assert.match(development, /name: Publish nightly update metadata/);
assert.match(development, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
assert.match(development, /--config\.publish\.channel=nightly/);
assert.match(development, /--config\.publish\.releaseType=prerelease/);
assert.match(development, /--publish always/);
assert.match(development, /actions\/upload-artifact@v4/);
assert.match(prepare, /^name: Prepare Electron Desktop Build/m);
assert.match(prepare, /src\/PiDesktop\.Tauri\/components\/synthv-agent-bridge/);
assert.match(prepare, /npm run build:electron/);
assert.match(prepare, /test\/electron-ai-service\.mjs/);
assert.match(prepare, /test\/electron-http-mcp-server\.mjs/);
assert.doesNotMatch(prepare, /cargo|tauri|src-tauri|rust-toolchain|setup-python/);
assert.match(release, /npm exec --prefix src\/PiDesktop\.Tauri -- electron-builder --config electron-builder\.yml/);
assert.equal(packageJson.scripts.tauri, undefined);
assert.equal(packageJson.scripts["prepare:bundled-node"], undefined);
assert.equal(packageJson.scripts["build:electron"], "npm run build:renderer && npm run build:host");
assert.match(packageJson.scripts["build:host"], /electron\/tsconfig\.json/);
assert.match(packageJson.scripts["test:contracts"], /electron-http-mcp-server\.mjs/);

console.log("Electron Builder workflow contracts passed.");
