import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const main = fs.readFileSync(path.join(root, "src/PiDesktop.Tauri/src/main.ts"), "utf8");
const styles = fs.readFileSync(path.join(root, "src/PiDesktop.Tauri/src/styles.css"), "utf8");

test("Copilot exposes the active provider and model in its conversation header", () => {
  const renderCopilot = main.slice(main.indexOf("function renderCopilot"), main.indexOf("function renderAiProviderSettings"));
  assert.match(renderCopilot, /data-open-ai-provider-picker/);
  assert.match(renderCopilot, /activeProvider/);
  assert.match(renderCopilot, /activeProvider\?\.displayName|activeProvider\.displayName/);
  assert.match(renderCopilot, /activeProvider\?\.model|activeProvider\.model/);
});

test("Edit and Solo remain selectable inside the conversation", () => {
  const renderCopilot = main.slice(main.indexOf("function renderCopilot"), main.indexOf("function renderAiProviderSettings"));
  assert.match(renderCopilot, /data-agent-work-mode="edit"/);
  assert.match(renderCopilot, /data-agent-work-mode="solo"/);
  assert.match(renderCopilot, /agentWorkMode/);
});

test("composer uses an inner shell and compact textarea", () => {
  const renderCopilot = main.slice(main.indexOf("function renderCopilot"), main.indexOf("function renderAiProviderSettings"));
  assert.match(renderCopilot, /class="composer-shell"/);
  assert.match(renderCopilot, /class="composer-toolbar"/);
  const textarea = renderCopilot.match(/<textarea[^>]*class="[^"]*composer[^"]*"[^>]*>|<textarea[^>]*>/)?.[0] ?? "";
  const rows = textarea.match(/\brows="(\d+)"/)?.[1];
  assert.ok(rows, "composer textarea must declare rows");
  assert.ok(Number(rows) <= 3, `composer textarea rows must be <= 3, got ${rows}`);
});

test("dark history panel uses theme tokens and no fixed light rgba", () => {
  const panel = styles.match(/\.sessions-panel\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(panel, "sessions-panel styles must exist");
  assert.doesNotMatch(panel, /rgba\(243\s*,\s*243\s*,\s*243/);
  assert.match(panel, /var\(--[a-z-]+\)/);
});

test("messages and composer have bounded readable widths", () => {
  const relevant = styles.match(/\.(?:messages|chat-messages|composer)(?:[-\w]*)\s*\{[^}]*\}/g)?.join("\n") ?? "";
  assert.match(relevant, /max-width\s*:/);
  assert.match(relevant, /margin(?:-inline)?\s*:/);
});

test("mobile layout includes Copilot-specific responsive rules", () => {
  assert.match(styles, /@media[^{}]*\([^)]*(?:max-width|min-width)[^)]*\)[^{]*\{[\s\S]*\.copilot/);
});
