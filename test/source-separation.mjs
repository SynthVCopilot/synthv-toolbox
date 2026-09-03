import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rustRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src-tauri");
const webRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src");
const read = (path) => readFileSync(path, "utf8");
const components = read(join(rustRoot, "src", "components.rs"));
const workflows = read(join(rustRoot, "src", "workflows.rs"));
const agent = read(join(rustRoot, "src", "audio_capture.rs"));
const separator = read(join(rustRoot, "components", "vocal-separation", "separate.py"));
const requirements = read(join(rustRoot, "components", "vocal-separation", "requirements.txt"));
const features = read(join(webRoot, "featureCatalog.ts"));

assert.match(components, /"vocal-separation"/);
assert.match(components, /"separation"/);
assert.match(requirements, /demucs==4\.0\.1/);
assert.match(requirements, /torch==2\.7\.1/);
assert.match(separator, /--two-stems/);
assert.match(separator, /htdemucs/);
assert.match(separator, /vocals\.wav/);
assert.match(separator, /instrumental\.wav/);
assert.match(workflows, /pub fn separate_audio/);
assert.match(agent, /separate_vocals_and_instrumental/);
assert.match(features, /id: "source-separation"/);

console.log("Source separation contracts passed.");
