import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const main = await readFile(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");
assert.match(main, /registerModelAuthElement\(\)/);
assert.match(main, /<model-auth-dialog>/);
assert.match(main, /data-open-ai-provider-picker/);
assert.match(main, /reconnect-oauth/);
assert.match(main, /runModelAuthOperation/);
assert.doesNotMatch(main, /data-choose-ai-provider/);
assert.doesNotMatch(main, /data-select-ai-provider-model/);
console.log("Conversation model picker contracts passed.");
