import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = mkdtempSync(join(tmpdir(), "synthv-toolbox-dev-version-"));
const desktop = join(fixture, "src", "PiDesktop.Tauri");
const output = join(fixture, "github-output.txt");

function write(relative, contents) {
  const filename = join(fixture, relative);
  const directory = dirname(filename);
  if (directory !== fixture) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(filename, contents);
}

try {
  write("src/PiDesktop.Tauri/package.json", JSON.stringify({ version: "1.2.3" }));
  write("src/PiDesktop.Tauri/package-lock.json", JSON.stringify({
    version: "1.2.3",
    packages: { "": { version: "1.2.3" } },
  }));
  write("src/PiDesktop.Tauri/src-tauri/tauri.conf.json", JSON.stringify({ version: "1.2.3" }));
  write("src/PiDesktop.Tauri/src-tauri/Cargo.toml", "[package]\nname = \"fixture\"\nversion = \"1.2.3\"\n");

  execFileSync(process.execPath, [join(root, ".github", "scripts", "set-dev-version.mjs"), "AbC1234f", fixture], {
    env: { ...process.env, GITHUB_OUTPUT: output },
  });

  const version = "1.2.3-dev.abc1234";
  assert.equal(JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")).version, version);
  assert.equal(JSON.parse(readFileSync(join(desktop, "package-lock.json"), "utf8")).version, version);
  assert.equal(JSON.parse(readFileSync(join(desktop, "package-lock.json"), "utf8")).packages[""].version, version);
  assert.equal(JSON.parse(readFileSync(join(desktop, "src-tauri", "tauri.conf.json"), "utf8")).version, version);
  assert.match(readFileSync(join(desktop, "src-tauri", "Cargo.toml"), "utf8"), /version = "1\.2\.3-dev\.abc1234"/);
  assert.equal(readFileSync(output, "utf8"), `version=${version}\n`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log("Development build version contracts passed.");
