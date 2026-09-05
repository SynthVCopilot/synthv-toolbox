import assert from "node:assert/strict";
import { instanceProjectTitle } from "../src/PiDesktop.Tauri/src/sv2Instances.ts";

assert.equal(instanceProjectTitle("[*] Song.svp — Synthesizer V Studio 2 Pro 2.3.0"), "[*] Song.svp");
assert.equal(instanceProjectTitle("Project.svp - Synthesizer V Studio 2 Pro"), "Project.svp");
assert.equal(instanceProjectTitle(undefined), "未命名工程");
console.log("SV2 instance title formatting passed.");
