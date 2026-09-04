import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const main = readFileSync(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");

function functionBody(name) {
  const start = main.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
  const next = main.indexOf("\nfunction ", start + 1);
  return main.slice(start, next === -1 ? main.length : next);
}

const copilot = functionBody("renderCopilot");
const settings = functionBody("renderSettings");
const providerSettings = functionBody("renderAiProviderSettings");

// Provider/model selection is a dialog with searchable, clickable options.
assert.match(providerSettings, /data-open-ai-provider-picker/);
assert.match(main, /role="dialog"[\s\S]*aria-modal="true"[\s\S]*aria-labelledby=/);
assert.match(main, /type="search"/);
assert.match(main, /data-choose-ai-provider/);
assert.match(main, /data-select-ai-provider-model/);
assert.doesNotMatch(copilot, /<select[^>]+name="model"/);

// Edit/Solo are controls in the conversation header, not a settings panel.
assert.match(copilot, /data-agent-work-mode="edit"/);
assert.match(copilot, /data-agent-work-mode="solo"/);
assert.doesNotMatch(settings, /Agent 工作模式/);

// Existing backend contracts remain the only persistence path for these choices.
assert.match(main, /selectAiProvider\([^,]+, model\)/);
assert.match(main, /setAgentWorkMode\(agentWorkMode\)/);

// The picker must expose an accessible close action as well as modal semantics.
assert.match(main, /data-close-ai-provider-picker/);
assert.match(main, /aria-label="(?:关闭|Close)[^"]*"/);

console.log("Conversation model picker contracts passed.");
