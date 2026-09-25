import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const main = fs.readFileSync(path.join(root, "src/PiDesktop.Tauri/src/main.ts"), "utf8");
const styles = fs.readFileSync(path.join(root, "src/PiDesktop.Tauri/src/styles.css"), "utf8");
const i18nCopilot = fs.readFileSync(path.join(root, "src/PiDesktop.Tauri/src/i18nCopilot.ts"), "utf8");

test("the conversation header exposes an effort segmented group next to Edit/Solo", () => {
  const section = main.slice(main.indexOf("const AGENT_EFFORT_ORDER"), main.indexOf("function usageValue"));
  assert.match(section, /data-agent-effort="\$\{level\}"/);
  assert.match(section, /\["low", "mid", "high", "max"\]/);
  assert.match(section, /chat-effort-mode/);
  assert.match(section, /aria-pressed/);
  assert.match(section, /renderAgentEffortGroup\(\)/);
});

test("clicking an effort button calls setAgentEffort and updates app state", () => {
  const handler = main.slice(main.indexOf("const agentWorkMode = target.dataset.agentWorkMode"), main.indexOf("const agentWorkMode = target.dataset.agentWorkMode") + 800);
  assert.match(handler, /target\.dataset\.agentEffort/);
  assert.match(handler, /api\.setAgentEffort\(agentEffort\)/);
  assert.match(handler, /app = await api\.setAgentEffort/);
});

test("a current-goal card renders the goal, done criteria, and todo list with status markers", () => {
  assert.match(main, /function renderAgentGoalCard/);
  assert.match(main, /agent-goal-card/);
  assert.match(main, /agent-goal-criteria/);
  assert.match(main, /agent-goal-todos/);
  assert.match(main, /agent-todo-\$\{todo\.status\}/);
  assert.match(main, /renderAgentGoalCard\(goalMessage\.outcome\.plan, goalMessage\.outcome\.status\)/);
});

test("renderMessage shows a status chip and budget usage, and escapes outcome fields", () => {
  const renderMessage = main.slice(main.indexOf("function renderMessage"), main.indexOf("async function loadFfmpegConfiguration"));
  assert.match(renderMessage, /renderAgentStatusChip\(outcome\.status\)/);
  assert.match(renderMessage, /agentBudgetUsageText\(outcome\)/);
  assert.match(renderMessage, /escapeHtml\(outcome\.summary\)/);
  assert.match(renderMessage, /outcome\.missing\.map\(\(item\) => `<li>\$\{escapeHtml\(item\)\}<\/li>`\)/);
  assert.match(renderMessage, /message\.content \? `<p>\$\{escapeHtml\(message\.content\)\}<\/p>` : ""/);
});

test("status chips cover all four run statuses", () => {
  assert.match(main, /function renderAgentStatusChip/);
  for (const status of ["completed", "needs_input", "budget_exhausted", "incomplete"]) {
    assert.match(styles, new RegExp(`\\.agent-status-${status}\\b`));
  }
});

test("todo status markers use CSS shapes, not emoji or unicode icons", () => {
  const card = styles.match(/\.agent-todo[^{]*\{[^}]*\}/g)?.join("\n") ?? "";
  assert.ok(card, "todo styles must exist");
  assert.doesNotMatch(styles, /\.agent-todo[\s\S]{0,400}content:\s*["'][•●✓✗]/);
  assert.match(styles, /\.agent-todo-marker/);
  assert.match(styles, /\.agent-todo-completed \.agent-todo-marker/);
  assert.match(styles, /\.agent-todo-cancelled \.agent-todo-title[^{]*\{[^}]*text-decoration:\s*line-through/);
});

test("status chip and goal card styles use theme custom properties", () => {
  const chip = styles.match(/\.agent-status-completed\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(chip, "agent-status-completed styles must exist");
  assert.match(chip, /var\(--[a-z-]+\)/);
  const card = styles.match(/\.agent-goal-card\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(card, /var\(--[a-z-]+\)/);
});

test("sendPrompt passes the open conversation id to sendMessage", () => {
  const sendPrompt = main.slice(main.indexOf("async function sendPrompt"), main.indexOf("async function refreshAiProviderSummary"));
  assert.match(sendPrompt, /api\.sendMessage\(conversation!?\.id,\s*input\)/);
});

test("every new copilot i18n key exists in both zh-CN and en", () => {
  const zh = i18nCopilot.slice(i18nCopilot.indexOf('addMessages("zh-CN"'), i18nCopilot.indexOf('addMessages("en"'));
  const en = i18nCopilot.slice(i18nCopilot.indexOf('addMessages("en"'));
  const keys = [
    "effortGroup", "effortLow", "effortMid", "effortHigh", "effortMax", "effortTitle", "effortNoLimit",
    "currentGoal", "goalProgress", "doneCriteria", "todoPending", "todoInProgress", "todoCompleted", "todoCancelled",
    "statusCompleted", "statusNeedsInput", "statusBudgetExhausted", "statusIncomplete",
    "budgetUsage", "usedOfLimit", "usedNoLimit", "missingInfo", "evidence",
  ];
  for (const key of keys) {
    assert.match(zh, new RegExp(`"${key}":`), `zh-CN is missing copilot.${key}`);
    assert.match(en, new RegExp(`"${key}":`), `en is missing copilot.${key}`);
  }
});

console.log("Agent goal UI contracts passed.");
