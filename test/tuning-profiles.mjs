import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rustRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src-tauri");
const webRoot = join(repositoryRoot, "src", "PiDesktop.Tauri", "src");
const read = (path) => readFileSync(path, "utf8");
const profiles = read(join(rustRoot, "src", "tuning_profiles.rs"));
const workflows = read(join(rustRoot, "src", "workflows.rs"));
const bridge = read(join(rustRoot, "src", "bridge_workflows.rs"));
const commands = read(join(rustRoot, "src", "commands.rs"));
const agent = read(join(rustRoot, "src", "audio_capture.rs"));
const audio = read(join(rustRoot, "components", "pi-audio", "pi_audio.py"));
const features = read(join(webRoot, "featureCatalog.ts"));
const main = read(join(webRoot, "main.ts"));

assert.match(audio, /source-style/);
assert.match(audio, /SOURCE_STYLE_ANALYSIS_SECONDS = 45/);
assert.match(audio, /vibrato_rate_hz/);
assert.match(audio, /breathiness_proxy/);
assert.match(workflows, /pub fn source_style/);
assert.match(profiles, /pub struct TuningProfile/);
assert.match(profiles, /tuning-profiles/);
assert.match(profiles, /normalized_voice_name/);
assert.match(profiles, /pub fn record_outcome/);
assert.match(profiles, /improvement\.abs\(\) \* 0\.25/);
assert.match(bridge, /pub async fn apply_tuning_profile/);
assert.match(bridge, /"action": "apply_group_tuning"/);
assert.match(commands, /pub async fn learn_tuning_profile/);
assert.match(commands, /pub async fn apply_tuning_profile/);
assert.match(agent, /name: "learn_tuning_from_source"/);
assert.match(agent, /name: "apply_learned_tuning"/);
assert.match(features, /id: "tuning-learning"/);
assert.match(main, /id="tuning-learn-form"/);

console.log("Tuning profile contracts passed.");
