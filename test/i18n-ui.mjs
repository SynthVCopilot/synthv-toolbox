import assert from "node:assert/strict";
import fs from "node:fs";

const srcDir = new URL("../src/PiDesktop.Tauri/src/", import.meta.url);
const i18n = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/i18n.ts", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");
const shell = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/vue/shell.ts", import.meta.url), "utf8");

assert.match(i18n, /createI18n/);
assert.match(i18n, /localStorage\.getItem\(storageKey\) === "en" \? "en" : fallbackLocale/);
assert.match(i18n, /localStorage\.setItem\(storageKey, next\)/);
assert.match(i18n, /document\.documentElement\.lang = next/);
assert.match(i18n, /"zh-CN"[\s\S]*connections:[\s\S]*localService/);
assert.match(i18n, /en:[\s\S]*connections:[\s\S]*localService/);
assert.match(shell, /\.use\(i18n\)\.mount\(element\)/);
assert.match(main, /mountFluentSelect\("language-select-host", "language-select", t\("settings\.language"\), locale\(\), \[/);
assert.match(main, /value: "zh-CN", label: t\("settings\.chinese"\)/);
assert.match(main, /value: "en", label: t\("settings\.english"\)/);
assert.match(main, /setLocale\(value === "en" \? "en" : "zh-CN"\)[\s\S]*render\(\)/);

const i18nCopilot = fs.readFileSync(new URL("../src/PiDesktop.Tauri/src/i18nCopilot.ts", import.meta.url), "utf8");
const zhCopilot = i18nCopilot.slice(i18nCopilot.indexOf('addMessages("zh-CN"'), i18nCopilot.indexOf('addMessages("en"'));
const enCopilot = i18nCopilot.slice(i18nCopilot.indexOf('addMessages("en"'));
const agentRunCopilotKeys = [
  "stop", "stopping",
  "phaseStarting", "phaseWaitingModel", "phaseThinking", "phaseWriting", "phaseRunningTools", "phaseCompacting", "phaseRetrying", "phaseCancelling", "phaseEnded",
  "roundChip", "retryChip", "toolRunning", "toolAwaitingApproval", "toolSucceeded", "toolFailed", "earlierTools", "pendingInputLabel",
  "budgetTurns", "budgetTokens", "categoryProjectWrite", "categoryUiChange", "categoryExecutorControl",
  "approvalConversation", "approvalCountdown", "approvalApproved", "approvalDenied",
  "riskHigh", "resolutionExecuted", "resolutionExecutedFailed", "resolutionDenied", "resolutionExpired", "resolutionCancelled",
  "toolNameSvCommand", "toolNameSvUi", "toolNameSvStatus", "toolNameSvQuery", "toolNameSvDescribe", "toolNameSvReview",
];
for (const key of agentRunCopilotKeys) {
  assert.match(zhCopilot, new RegExp(`"${key}":`), `zh-CN is missing copilot.${key}`);
  assert.match(enCopilot, new RegExp(`"${key}":`), `en is missing copilot.${key}`);
}
assert.match(zhCopilot, /"agentTranscripts":/);
assert.match(enCopilot, /"agentTranscripts":/);
assert.match(zhCopilot, /"agentTranscriptsDescription":/);
assert.match(enCopilot, /"agentTranscriptsDescription":/);

// The approvals UI moved from per-file approval cards to sv_* tool-call approvals (agent_approvals),
// so no code or dictionary should still carry the retired fileApproval/fileApproved/fileDenied keys.
assert.doesNotMatch(main, /copilot\.fileApproval\b/);
for (const name of fs.readdirSync(srcDir)) {
  if (!/^i18n.*\.ts$/.test(name)) continue;
  const source = fs.readFileSync(new URL(name, srcDir), "utf8");
  assert.doesNotMatch(source, /"fileApproval":/, `${name} still has fileApproval`);
  assert.doesNotMatch(source, /"fileApproved":/, `${name} still has fileApproved`);
  assert.doesNotMatch(source, /"fileDenied":/, `${name} still has fileDenied`);
}

console.log("I18n UI contracts passed.");
