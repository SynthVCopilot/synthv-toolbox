import assert from "node:assert/strict";
import "./voice-license-ui.mjs";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/voiceCatalog.ts", import.meta.url), "utf8");
const { findVoiceMetadata } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: "transform" })).toString("base64")}`);
const orphan = { id: "00000000-0000-4000-8000-000000000001", name: null, imageDataUrl: "data:image/png;base64,fixture" };
const named = { id: "00000000-0000-4000-8000-000000000002", name: "Fixture Voice 2" };
const catalog = [orphan, named];

assert.equal(findVoiceMetadata("Official Voice", [orphan.id], catalog), orphan, "official product ID can resolve image-only metadata");
assert.equal(findVoiceMetadata(" fixture   voice ２ ", [], catalog), named, "case, whitespace and equivalent Unicode formatting normalize");
assert.equal(findVoiceMetadata("Fixture Voice", [], catalog), undefined, "different generations do not share artwork by guessed names");
assert.equal(findVoiceMetadata(named.name, [orphan.id], catalog), orphan, "official IDs take priority over names");
assert.equal(findVoiceMetadata(named.name, ["missing-product"], catalog), undefined, "known product IDs cannot match a different product by name");
assert.equal(findVoiceMetadata(named.name, [], [named, { ...named, id: "different-product" }]), undefined, "ambiguous names do not pick arbitrary artwork");
assert.equal(findVoiceMetadata("Official Voice", [orphan.id, named.id], catalog), undefined, "multiple licensed products sharing a name require an unambiguous image");
console.log("Voice catalog matching passed.");
