import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/PiDesktop.Tauri/src/styles.css", import.meta.url), "utf8");

assert.ok(source.includes('class="tool-tabs"'), "category navigation should use the compact tool tabs");
assert.ok(source.includes('aria-current="page"'), "selected tool should expose current navigation state");
assert.ok(!source.includes("workflow-tool-tabs"), "workflow renderer must not add a second tool switcher");
assert.ok(!source.includes("data-close-workflow"), "tool workspaces must not have a close-to-catalog action");
assert.ok(!styles.includes(".workflow-tool-tab"), "old workflow tab card styles should be removed");
assert.ok(styles.includes("overflow-x: auto") && styles.includes("border-bottom-color: var(--primary)"), "tool navigation should remain a compact horizontal strip");

assert.ok(source.includes('historyLoadState: "idle" | "loading" | "ready" | "error"'), "history needs an independent load state");
assert.ok(source.includes("historyLoadState = \"error\""), "history failures should be visible on the history page");
assert.ok(source.includes("historyLoadError = \"\""), "successful history refresh should clear a previous error");
assert.ok(source.includes("generation !== historyRefreshGeneration || page !== \"history\""), "late history responses must be ignored after leaving the page");
assert.ok(source.includes("最近发现"), "backup discovery timestamp should not be presented as a check timestamp");
assert.ok(source.includes('if (page === "import" && activeWorkflow === "audio-preparation") refreshAudioRuntimeStatus();'), "default audio entry should initialize its runtime status");

console.log("Automatic history and direct tool workspace UI contracts passed.");
