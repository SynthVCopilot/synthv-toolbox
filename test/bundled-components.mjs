import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(join(root, "src", "PiDesktop.Tauri", "src-tauri", "tauri.conf.json"), "utf8"));
const resources = config.bundle.resources;

for (const path of [
  "components/pi-audio/pi_audio.py",
  "components/pi-audio/requirements.txt",
  "components/cvrs/cvrs.py",
  "components/vocal-separation/separate.py",
  "components/vocal-separation/requirements.txt",
]) {
  assert.equal(resources[path], path);
}

console.log("Bundled component contracts passed.");
