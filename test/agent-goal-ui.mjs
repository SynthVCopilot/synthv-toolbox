import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire, stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const main = fs.readFileSync(path.join(root, "src/PiDesktop.Tauri/src/main.ts"), "utf8");
const styles = fs.readFileSync(path.join(root, "src/PiDesktop.Tauri/src/styles.css"), "utf8");
const i18nCopilot = fs.readFileSync(path.join(root, "src/PiDesktop.Tauri/src/i18nCopilot.ts"), "utf8");
const apiSource = fs.readFileSync(path.join(root, "src/PiDesktop.Tauri/src/api.ts"), "utf8");
const require = createRequire(new URL("../src/PiDesktop.Tauri/package.json", import.meta.url));
const { parse } = require("@babel/parser");
const { createI18n } = require("vue-i18n");
const { JSDOM } = require("jsdom");

test("the conversation header exposes an effort segmented group next to Edit/Solo", () => {
  const section = main.slice(main.indexOf("const AGENT_EFFORT_ORDER"), main.indexOf("function agentTodoStatusLabel"));
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

test("status chips cover all five run statuses", () => {
  assert.match(main, /function renderAgentStatusChip/);
  for (const status of ["completed", "needs_input", "budget_exhausted", "incomplete", "cancelled"]) {
    assert.match(styles, new RegExp(`\\.agent-status-${status}\\b`));
  }
});

test("the goal, live-run and approvals slots render inside the messages/chat panel, not swallowed elsewhere", () => {
  const renderCopilot = main.slice(main.indexOf("function renderCopilot"), main.indexOf("function usageValue"));
  assert.match(renderCopilot, /<div class="messages"><div id="agent-goal-slot">/);
  assert.match(renderCopilot, /<div id="agent-live-run">/);
  assert.match(renderCopilot, /<div id="agent-approvals-slot"/);
  assert.match(styles, /\.agent-goal-card[^{]*\{[^}]*position:\s*sticky/);
  assert.match(styles, /\.agent-goal-card[^{]*\{[^}]*max-height/);
});

test("#agent-live-run is the last child of .messages, after the conversation history, so streaming never covers earlier turns", () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = {
    id: "c", title: "Chat",
    messages: [{ role: "user", content: "first" }, { role: "assistant", content: "second" }, { role: "user", content: "third" }],
  };
  state.liveRunId = "run-1";
  state.liveRun = { sessionId: "c", runId: "run-1", seq: 1, phase: "writing", round: 1, text: "streaming", plan: null, tools: [], toolCount: 0, budget: { level: "mid", maxTurns: 10, maxTokens: 1000, turns: 1, tokens: 5 }, retry: null, pendingInput: null };
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  const messagesEl = dom.window.document.querySelector(".messages");
  assert.equal(messagesEl.lastElementChild.id, "agent-live-run", "the live-run slot must be the last child of .messages, after every earlier turn");
  assert.equal(messagesEl.firstElementChild.id, "agent-goal-slot", "the sticky goal card stays the first child");
});

test("no fileApprovals / agentFileApprovals reference remains", () => {
  for (const source of [main, apiSource]) {
    assert.doesNotMatch(source, /fileApprovals/);
    assert.doesNotMatch(source, /AgentFileApproval/);
    assert.doesNotMatch(source, /agentFileApprovals/);
    assert.doesNotMatch(source, /data-approve-file|data-deny-file/);
  }
});

test("the composer shows a stop button while an agent run is in flight, disables it and labels it Stopping while cancelling", () => {
  assert.match(main, /let agentRunInFlight/);
  assert.match(main, /let agentRunCancelling/);
  assert.match(main, /data-cancel-agent-run/);
  assert.match(main, /api\.cancelAgentRun\(conversation\.id\)/);
  assert.match(main, /hasAttribute\("data-cancel-agent-run"\)\)\s*\{\s*void cancelAgentRun\(\);\s*return;\s*\}/);
  const composerAction = main.slice(main.indexOf("function renderComposerAction"), main.indexOf("function renderComposerAction") + 900);
  assert.match(composerAction, /t\("copilot\.stopping"\)/);
  assert.match(composerAction, /agentRunCancelling \? "disabled" : ""/);
  assert.match(main, /<span id="agent-composer-action">\$\{composerActionHtml\}<\/span>/, "the composer action is its own patchable slot, so Stop never triggers a full render");
});

test("sendPrompt generates a run id and clears live-run state when the run ends", () => {
  const sendPrompt = main.slice(main.indexOf("async function sendPrompt"), main.indexOf("async function decideApproval"));
  assert.match(sendPrompt, /const runId = crypto\.randomUUID\(\);/);
  assert.match(sendPrompt, /liveRunId = runId;/);
  assert.match(sendPrompt, /api\.sendMessage\(conversation!?\.id,\s*input,\s*runId\)/);
  assert.match(sendPrompt, /finally\s*\{[\s\S]*liveRunId = undefined;[\s\S]*liveRun = undefined;/);
});

test("Approve and Deny buttons call decideApproval with the approval id, directly and not through run()", () => {
  assert.match(main, /target\.dataset\.approveAgent\)\s*\{\s*void decideApproval\(target\.dataset\.approveAgent,\s*true,\s*target\)/);
  assert.match(main, /target\.dataset\.denyAgent\)\s*\{\s*void decideApproval\(target\.dataset\.denyAgent,\s*false,\s*target\)/);
});

test("the header actions wrap instead of overflowing at the desktop minimum width", () => {
  const rule = styles.match(/\.chat-header-actions\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(rule, /flex-wrap:\s*wrap/);
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

test("live-run and approval styles exist and use theme custom properties", () => {
  for (const selector of [".agent-live", ".agent-budget-meter", ".agent-approval", ".agent-approval-category-projectWrite"]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = styles.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? "";
    assert.ok(rule, `${selector} styles must exist`);
  }
  for (const marker of [".agent-tool-activity-running", ".agent-tool-activity-succeeded", ".agent-tool-activity-failed"]) {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(styles, new RegExp(`${escaped}\\s+\\.agent-tool-activity-marker`), `${marker} marker styles must exist`);
  }
});

test("every new copilot i18n key exists in both zh-CN and en", () => {
  const zh = i18nCopilot.slice(i18nCopilot.indexOf('addMessages("zh-CN"'), i18nCopilot.indexOf('addMessages("en"'));
  const en = i18nCopilot.slice(i18nCopilot.indexOf('addMessages("en"'));
  const keys = [
    "effortGroup", "effortLow", "effortMid", "effortHigh", "effortMax", "effortTitle", "effortNoLimit",
    "currentGoal", "goalProgress", "doneCriteria", "todoPending", "todoInProgress", "todoCompleted", "todoCancelled",
    "statusCompleted", "statusNeedsInput", "statusBudgetExhausted", "statusIncomplete", "statusCancelled", "stop", "stopping",
    "budgetUsage", "usedOfLimit", "usedNoLimit", "missingInfo", "evidence",
    "phaseStarting", "phaseWaitingModel", "phaseThinking", "phaseWriting", "phaseRunningTools", "phaseCompacting", "phaseRetrying", "phaseCancelling", "phaseEnded",
    "roundChip", "retryChip", "toolRunning", "toolAwaitingApproval", "toolSucceeded", "toolFailed", "earlierTools", "pendingInputLabel",
    "budgetTurns", "budgetTokens", "categoryProjectWrite", "categoryUiChange", "categoryExecutorControl",
    "approvalConversation", "approvalCountdown", "approvalApproved", "approvalDenied",
    "riskHigh", "resolutionExecuted", "resolutionExecutedFailed", "resolutionDenied", "resolutionExpired", "resolutionCancelled",
    "toolNameSvCommand", "toolNameSvUi", "toolNameSvStatus", "toolNameSvQuery", "toolNameSvDescribe", "toolNameSvReview",
  ];
  for (const key of keys) {
    assert.match(zh, new RegExp(`"${key}":`), `zh-CN is missing copilot.${key}`);
    assert.match(en, new RegExp(`"${key}":`), `en is missing copilot.${key}`);
  }
});

// --- Dynamic rendering and patching behaviour, executed against the real implementation. ---

const i18n = createI18n({ legacy: false, locale: "en", fallbackLocale: "zh-CN", messages: {} });
const addMessages = (language, messages) => i18n.global.mergeLocaleMessage(language, messages);
const readSrc = (name) => fs.readFileSync(path.join(root, "src/PiDesktop.Tauri/src", name), "utf8");
for (const name of ["i18nCommon.ts", "i18nCopilot.ts"]) {
  vm.runInNewContext(readSrc(name).replace(/^import .*;\r?\n/gm, ""), { addMessages });
}
const t = (key, params = {}) => {
  assert.ok(i18n.global.te(key), `Missing ${i18n.global.locale.value} message: ${key}`);
  return i18n.global.t(key, params);
};

const functionNames = new Set([
  "escapeHtml", "formatError",
  "agentEffortBudgetLabel", "agentEffortLabel", "renderAgentEffortGroup",
  "agentTodoStatusLabel", "renderAgentGoalCard", "renderAgentStatusChip", "latestAgentPlanMessage",
  "agentToolDisplayName", "agentToolActivityStatusLabel", "agentRunPhaseLabel", "agentApprovalCategoryLabel", "agentApprovalRiskLabel",
  "agentApprovalResolutionLabel", "formatApprovalCountdown", "approvalFailureSummary",
  "renderToolActivity", "renderApprovalResolution", "currentConversationResolutions", "renderApprovalResolutionsSlot",
  "agentBudgetUsageTextFromBudget", "renderAgentBudgetMeter", "renderLiveRunPanel",
  "renderAgentGoalSlot", "renderLiveRunSlot", "renderComposerAction", "approvalConversationTitle", "renderApprovalCard", "renderApprovalsSlot", "renderApprovalsSlotDiffKey",
  "tickApprovalCountdowns", "patchSlot", "applyLiveRunPatch", "patchLiveRun", "toastHtml", "scheduleToastDismiss", "patchToast",
  "renderCopilot", "agentBudgetUsageText", "renderMessage",
  "listenForAgentRunProgress", "listenForAgentApprovals", "decideApproval", "cancelAgentRun",
  "sendPrompt", "withAiProviderStateRefresh",
]);
const constNames = new Set(["AGENT_EFFORT_ORDER", "AGENT_EFFORT_COVERAGE", "AGENT_TOOL_DISPLAY_NAME_KEYS", "AGENT_RUN_PHASE_KEYS"]);
const ast = parse(main, { sourceType: "module", plugins: ["typescript"] });
const nodes = ast.program.body.filter((node) => {
  if (node.type === "FunctionDeclaration") return functionNames.has(node.id.name);
  if (node.type === "VariableDeclaration") return node.declarations.length === 1 && constNames.has(node.declarations[0].id.name);
  return false;
});
nodes.sort((a, b) => a.start - b.start);

// The Approve/Deny wiring lives in the single document click listener, not a named function, so it
// is sliced out by its literal boundaries and executed alongside the extracted declarations.
const clickHandlerStart = main.indexOf('document.addEventListener("click", (event) => {');
const clickHandlerEnd = main.indexOf("\nfunction svpRoutePlanFromPayload");
assert.ok(clickHandlerStart > -1 && clickHandlerEnd > clickHandlerStart, "click handler boundaries must be found");
const clickHandlerSource = main.slice(clickHandlerStart, clickHandlerEnd);

const implementations = nodes.map((node) => main.slice(node.start, node.end)).join("\n") + "\n" + clickHandlerSource;
for (const name of [...functionNames]) assert.match(implementations, new RegExp(`\\b${name}\\b`), `extraction missed ${name}`);

const flushMicrotasks = () => new Promise((resolve) => queueMicrotask(resolve));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function freshState(overrides = {}) {
  const listeners = {};
  const defaultDom = overrides.document ? undefined : new JSDOM("<div id=\"root\"></div>");
  const state = {
    t, locale: () => i18n.global.locale.value, icon: () => "",
    page: "copilot", busy: false,
    conversation: undefined, conversations: [], approvalsSnapshot: { pending: [], recent: [] }, notice: "", error: "",
    agentRunInFlight: false, agentRunCancelling: false,
    liveRunId: undefined, liveRun: undefined, liveRunLastSeq: 0,
    patchRafHandle: undefined, lastSlotHtml: new Map(),
    toastSignature: "", toastDismissTimer: undefined,
    activeAiProvider: () => undefined, aiProviderDisplayName: (provider) => provider.displayName,
    api: undefined,
    app: { agentWorkMode: "edit" },
    crypto: { randomUUID: (() => { let n = 0; return () => `test-run-${++n}`; })() },
    hasDesktopBridge: () => true,
    listenDesktop: async (event, callback) => { listeners[event] = callback; },
    listeners,
    window: {
      requestAnimationFrame: (callback) => { queueMicrotask(callback); return ++state.rafHandleCounter; },
      setTimeout: (...args) => setTimeout(...args),
      clearTimeout: (handle) => clearTimeout(handle),
    },
    rafHandleCounter: 0,
    // Records toast patches so tests can assert the slot the real ShellController.updateToast owns,
    // without pulling in Vue's AppShell mount.
    toastPatches: [],
    shellController: { updateToast: (noticeHtml, errorHtml) => state.toastPatches.push({ noticeHtml, errorHtml }) },
    // A lightweight stand-in for the real render(): the real one drives the whole app shell and is
    // out of scope here, but sendPrompt/run/decideApproval all call it, so the copilot page must
    // still re-render for the approvals/live-run assertions to observe anything.
    render: () => {
      if (!state.document) return;
      const rootEl = state.document.getElementById("root");
      if (rootEl && state.page === "copilot") rootEl.innerHTML = state.renderCopilot();
    },
    // Not extracted from main.ts: mirrors the real run()'s busy/render bookkeeping closely enough
    // for the approvals wiring this stub exists to exercise.
    run: async (task) => {
      state.busy = true;
      state.render();
      try { await task(); } finally { state.busy = false; state.render(); }
    },
    document: overrides.document ?? defaultDom?.window.document,
    ...overrides,
  };
  vm.createContext(state);
  vm.runInContext(stripTypeScriptTypes(implementations, { mode: "strip" }), state);
  return state;
}

test("the goal slot shows the live plan while in flight and the persisted plan afterwards", () => {
  const state = freshState();
  const plan = { goal: "Live goal", doneCriteria: ["a"], todos: [{ id: "1", title: "Step", status: "in_progress" }] };
  state.liveRunId = "run-1";
  state.liveRun = { sessionId: "s", runId: "run-1", seq: 1, phase: "writing", round: 1, text: "", plan, tools: [], toolCount: 0, budget: { level: "mid", maxTurns: 10, maxTokens: 1000, turns: 1, tokens: 10 }, retry: null, pendingInput: null };
  const inFlightHtml = state.renderAgentGoalSlot();
  assert.match(inFlightHtml, /Live goal/);
  state.liveRunId = undefined;
  state.liveRun = undefined;
  state.conversation = { id: "c", title: "Chat", messages: [{ role: "assistant", content: "done", outcome: { status: "completed", summary: "done", evidence: [], missing: [], plan: { goal: "Persisted goal", doneCriteria: [], todos: [] }, budget: { level: "mid", maxTurns: 10, maxTokens: 1000, turns: 2, tokens: 20 } } }] };
  const persistedHtml = state.renderAgentGoalSlot();
  assert.match(persistedHtml, /Persisted goal/);
  assert.doesNotMatch(persistedHtml, /Live goal/);
});

test("renderLiveRunPanel escapes text, tool summaries and tool names, and renders phase/round/budget", () => {
  const state = freshState();
  const view = {
    sessionId: "s", runId: "run-1", seq: 3, phase: "running_tools", round: 2,
    text: "<script>alert(1)</script>",
    plan: null,
    tools: [{ id: "call-1", name: "sv_command", status: "running", round: 2, summary: "<b>evil</b>" }],
    toolCount: 5,
    budget: { level: "mid", maxTurns: 10, maxTokens: 1000, turns: 3, tokens: 300 },
    retry: null, pendingInput: null,
  };
  const html = state.renderLiveRunPanel(view);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<b>evil<\/b>/);
  assert.match(html, /^<div class="agent-live">/, "the panel must carry the class styles.css targets");
  assert.match(html, /agent-phase-running_tools/);
  assert.match(html, new RegExp(t("copilot.roundChip", { round: 2 }).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /agent-tool-earlier/);
  assert.match(html, /agent-budget-meter/);
});

test("a pushed agent.run.progress event for the current runId patches #agent-live-run; foreign runId and stale seq are ignored", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = { id: "c", title: "Chat", messages: [] };
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  state.liveRunId = "run-1";
  state.liveRunLastSeq = 0;
  await state.listenForAgentRunProgress();
  const push = (overrides) => state.listeners["agent.run.progress"]({
    sessionId: "c", runId: "run-1", seq: 1, phase: "writing", round: 1, text: "hello",
    plan: null, tools: [], toolCount: 0, budget: { level: "mid", maxTurns: 10, maxTokens: 1000, turns: 1, tokens: 5 },
    retry: null, pendingInput: null, ...overrides,
  });
  push({});
  await flushMicrotasks();
  assert.match(dom.window.document.getElementById("agent-live-run").innerHTML, /hello/);
  push({ runId: "other-run", text: "should not appear" });
  await flushMicrotasks();
  assert.doesNotMatch(dom.window.document.getElementById("agent-live-run").innerHTML, /should not appear/);
  push({ seq: 1, text: "stale seq should not appear" });
  await flushMicrotasks();
  assert.doesNotMatch(dom.window.document.getElementById("agent-live-run").innerHTML, /stale seq/);
  push({ seq: 2, text: "fresher text" });
  await flushMicrotasks();
  assert.match(dom.window.document.getElementById("agent-live-run").innerHTML, /fresher text/);
});

test("approvals patching: cards render with a pre-filled countdown, Approve/Deny targets and preview element, foreign-conversation title shows, empty list removes the card", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = { id: "current", title: "Current chat", messages: [] };
  state.conversations = [{ id: "other", title: "Other chat", messageCount: 1, updatedAt: "2026-01-01" }];
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  await state.listenForAgentApprovals();
  const approval = { id: "a1", conversationId: "other", runId: "run-1", toolCallId: "tc1", tool: "sv_command", action: "delete_notes", category: "projectWrite", risk: "high", preview: "{\"action\":\"delete_notes\",\"noteIds\":[\"n1\",\"n2\"]}", createdAtUtc: "2026-01-01T00:00:00Z", expiresAtUtc: "2026-01-01T00:02:00Z" };
  state.listeners["agent.approvals.changed"]({ pending: [approval], recent: [] });
  await flushMicrotasks();
  const slot = dom.window.document.getElementById("agent-approvals-slot");
  assert.match(slot.innerHTML, /data-approval-id="a1"/);
  assert.match(slot.innerHTML, /data-approve-agent="a1"/);
  assert.match(slot.innerHTML, /data-deny-agent="a1"/);
  assert.match(slot.innerHTML, /Other chat/);
  assert.match(slot.innerHTML, /agent-approval-category-projectWrite/, "the category must render");
  assert.match(slot.innerHTML, /agent-approval-risk-high/, "the risk badge must render");
  const previewEl = slot.querySelector(".agent-approval-preview");
  assert.ok(previewEl, "the preview element must exist");
  assert.match(previewEl.textContent, /noteIds/, "the preview element itself must carry the parsed payload, not just the action paragraph");
  const countdownEl = slot.querySelector(".agent-approval-countdown");
  assert.ok(countdownEl, "the countdown element must exist");
  assert.equal(countdownEl.textContent, state.formatApprovalCountdown(approval.expiresAtUtc), "the countdown must be pre-filled on first render, not blank");
  assert.notEqual(countdownEl.textContent, "", "the countdown must never render blank");
  state.listeners["agent.approvals.changed"]({ pending: [], recent: [] });
  await flushMicrotasks();
  assert.doesNotMatch(dom.window.document.getElementById("agent-approvals-slot").innerHTML, /data-approval-id/);
});

test("an approval card for an unknown conversation shows a generic label and triggers a conversations refresh", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = { id: "current", title: "Current chat", messages: [] };
  state.conversations = [];
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  let listCalls = 0;
  let resolveList;
  const listPromise = new Promise((resolve) => { resolveList = resolve; });
  state.api = { listConversations: async () => { listCalls += 1; return listPromise; } };
  await state.listenForAgentApprovals();
  const approval = { id: "a1", conversationId: "other", runId: "run-1", toolCallId: "tc1", tool: "sv_command", action: "delete_notes", category: "projectWrite", risk: "high", preview: "{}", createdAtUtc: "2026-01-01T00:00:00Z", expiresAtUtc: "2026-01-01T00:02:00Z" };
  state.listeners["agent.approvals.changed"]({ pending: [approval], recent: [] });
  await flushMicrotasks();
  // Before the refresh resolves, the conversation is still unknown: the generic label must show rather than no label at all.
  assert.match(dom.window.document.getElementById("agent-approvals-slot").innerHTML, new RegExp(t("copilot.approvalOtherConversation")), "an approval for a conversation not yet in the sidebar list must still show a foreign-conversation label, never look like it belongs to the open chat");
  assert.equal(listCalls, 1, "an unknown conversationId must trigger exactly one conversations refresh");
  resolveList([{ id: "other", title: "Other chat", messageCount: 1, updatedAt: "2026-01-01" }]);
  await listPromise;
  await flushMicrotasks();
  assert.deepEqual(state.conversations, [{ id: "other", title: "Other chat", messageCount: 1, updatedAt: "2026-01-01" }]);
});

test("a countdown-only tick updates the countdown text in place without replacing the Approve button node", () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = { id: "c", title: "Chat", messages: [] };
  const approval = { id: "a1", conversationId: "c", runId: "r1", toolCallId: "tc1", tool: "sv_command", action: "delete_notes", category: "projectWrite", risk: "high", preview: "{}", createdAtUtc: "2026-01-01T00:00:00Z", expiresAtUtc: "2026-01-01T00:02:00Z" };
  state.approvalsSnapshot = { pending: [approval], recent: [] };
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  const approveButton = dom.window.document.querySelector('[data-approve-agent="a1"]');
  const countdownEl = dom.window.document.querySelector(".agent-approval-countdown");
  assert.ok(approveButton && countdownEl);
  // Simulate a second passing: only the countdown's own formatted text changes, nothing structural.
  const realFormat = state.formatApprovalCountdown;
  state.formatApprovalCountdown = (expiresAtUtc) => `${realFormat(expiresAtUtc)}-ticked`;
  state.applyLiveRunPatch();
  assert.equal(dom.window.document.querySelector('[data-approve-agent="a1"]'), approveButton, "the Approve button node identity must survive a countdown-only tick");
  assert.equal(dom.window.document.querySelector(".agent-approval-countdown"), countdownEl, "the countdown span node identity is preserved");
  assert.match(countdownEl.textContent, /-ticked$/, "the countdown text is updated in place");
});

test("a patch leaves nodes outside the three slots untouched", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = {
    id: "c", title: "Chat",
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "done", outcome: { status: "completed", summary: "done", evidence: ["proof"], missing: [], plan: { goal: "g", doneCriteria: ["c1"], todos: [] }, budget: { level: "mid", maxTurns: 10, maxTokens: 1000, turns: 1, tokens: 5 } } }],
  };
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  const details = dom.window.document.querySelector(".agent-outcome-evidence");
  assert.ok(details, "an outcome <details> element must be present outside the patched slots");
  details.open = true;
  const sentinelMessage = dom.window.document.querySelector(".message.user");
  sentinelMessage.dataset.sentinel = "kept";
  const textNode = sentinelMessage.querySelector("p").firstChild;
  const range = dom.window.document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, 2);
  const selection = dom.window.document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  state.liveRunId = "run-1";
  state.liveRun = { sessionId: "c", runId: "run-1", seq: 1, phase: "writing", round: 1, text: "streaming", plan: null, tools: [], toolCount: 0, budget: { level: "mid", maxTurns: 10, maxTokens: 1000, turns: 1, tokens: 5 }, retry: null, pendingInput: null };
  state.applyLiveRunPatch();
  assert.equal(dom.window.document.querySelector(".agent-outcome-evidence"), details, "the details node identity is preserved");
  assert.equal(details.open, true, "the open <details> stays open across a patch");
  assert.equal(dom.window.document.querySelector(".message.user"), sentinelMessage, "message nodes outside the slots keep their identity");
  assert.equal(sentinelMessage.dataset.sentinel, "kept");
  assert.match(dom.window.document.getElementById("agent-live-run").innerHTML, /streaming/);
  assert.equal(dom.window.document.getSelection().toString(), "hi".slice(0, 2), "a pre-existing text selection outside the slots survives the patch");
});

test("Approve calls decide_agent_approval with the id and sets a notice, without re-fetching the list itself (the push owns that)", async () => {
  const state = freshState();
  const decideCalls = [];
  const fetchCalls = [];
  state.approvalsSnapshot = { pending: [{ id: "a1", conversationId: "c", runId: "r1", toolCallId: "tc1", tool: "sv_command", action: "delete_notes", category: "projectWrite", risk: "high", preview: "{}", createdAtUtc: "2026-01-01T00:00:00Z", expiresAtUtc: "2026-01-01T00:02:00Z" }], recent: [] };
  state.api = {
    decideAgentApproval: async (id, approve) => { decideCalls.push({ id, approve }); },
    agentApprovals: async () => { fetchCalls.push(true); return { pending: [], recent: [] }; },
  };
  await state.decideApproval("a1", true);
  assert.deepEqual(decideCalls, [{ id: "a1", approve: true }]);
  assert.equal(fetchCalls.length, 0, "decideApproval must not re-fetch the snapshot itself; the agent.approvals.changed push does");
  assert.equal(state.notice, t("copilot.approvalApproved"));
  assert.equal(state.toastPatches.at(-1).noticeHtml.includes(t("copilot.approvalApproved")), true, "the toast slot must be patched so the notice is actually shown, not just set in state");

  await state.decideApproval("a2", false);
  assert.deepEqual(decideCalls[1], { id: "a2", approve: false });
  assert.equal(state.notice, t("copilot.approvalDenied"));
});

test("a failed decideApproval call reports the error via a toast patch, re-enables the card's buttons, and does not throw", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = { id: "c", title: "Chat", messages: [] };
  state.approvalsSnapshot = { pending: [{ id: "a1", conversationId: "c", runId: "r1", toolCallId: "tc1", tool: "sv_command", action: "delete_notes", category: "projectWrite", risk: "high", preview: "{}", createdAtUtc: "2026-01-01T00:00:00Z", expiresAtUtc: "2026-01-01T00:02:00Z" }], recent: [] };
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  const approveButton = dom.window.document.querySelector('[data-approve-agent="a1"]');
  // formatError's `instanceof Error` check is realm-sensitive: the thrown error must come from the
  // vm context's own Error constructor, not this file's, or it falls through to JSON.stringify's "{}".
  const contextError = vm.runInContext('new Error("boom")', state);
  state.api = { decideAgentApproval: async () => { throw contextError; } };
  await state.decideApproval("a1", true, approveButton);
  assert.match(state.error, /boom/);
  assert.equal(state.toastPatches.at(-1).errorHtml.includes("boom"), true, "the toast slot must be patched with the error, not left for the next full render");
  assert.equal(approveButton.disabled, false, "the button must be re-enabled since the approval is still pending after a failed decision");
});

test("the toast dismissal timer after decideApproval clears the toast without ever calling render", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = freshState();
  let renderCalls = 0;
  state.render = () => { renderCalls += 1; };
  state.approvalsSnapshot = { pending: [{ id: "a1", conversationId: "c", runId: "r1", toolCallId: "tc1", tool: "sv_command", action: "delete_notes", category: "projectWrite", risk: "high", preview: "{}", createdAtUtc: "2026-01-01T00:00:00Z", expiresAtUtc: "2026-01-01T00:02:00Z" }], recent: [] };
  state.api = { decideAgentApproval: async () => {} };
  await state.decideApproval("a1", true);
  assert.equal(state.toastPatches.at(-1).noticeHtml.includes(state.notice), true, "the approval notice must show first");
  t.mock.timers.tick(4200);
  await flushMicrotasks();
  assert.equal(renderCalls, 0, "the toast timeout must never trigger a full render, or Approve/Deny/Stop would reset scroll, <details> and selection 4.2s later");
  assert.equal(state.notice, "", "the notice clears once the timeout fires");
  assert.equal(state.toastPatches.at(-1).noticeHtml, "", "the toast slot itself must be cleared, not just the state field");
});

test("clicking the real Approve button dispatches through the document click handler, disables the card's buttons immediately, and does not call run()", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = { id: "c", title: "Chat", messages: [] };
  state.approvalsSnapshot = { pending: [{ id: "a1", conversationId: "c", runId: "r1", toolCallId: "tc1", tool: "sv_command", action: "delete_notes", category: "projectWrite", risk: "high", preview: "{}", createdAtUtc: "2026-01-01T00:00:00Z", expiresAtUtc: "2026-01-01T00:02:00Z" }], recent: [] };
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  await state.listenForAgentApprovals();
  const decideCalls = [];
  let runCalls = 0;
  const realRun = state.run;
  state.run = (task) => { runCalls += 1; return realRun(task); };
  state.api = {
    // Mirrors the real IPC round trip: the broker's decide() emits agent.approvals.changed
    // synchronously, before decideAgentApproval's own response reaches the renderer.
    decideAgentApproval: async (id, approve) => {
      decideCalls.push({ id, approve });
      state.listeners["agent.approvals.changed"]?.({ pending: [], recent: [] });
    },
  };
  const approveButton = dom.window.document.querySelector('[data-approve-agent="a1"]');
  const denyButton = dom.window.document.querySelector('[data-deny-agent="a1"]');
  assert.ok(approveButton, "the Approve button must exist in the rendered card");
  approveButton.click();
  assert.equal(approveButton.disabled, true, "the clicked button is disabled synchronously, before the API call settles");
  assert.equal(denyButton.disabled, true, "its sibling Deny button is disabled too, so the same card cannot be decided twice");
  await settle();
  assert.deepEqual(decideCalls, [{ id: "a1", approve: true }], "the real click handler must invoke decideApproval, not a test double");
  assert.equal(runCalls, 0, "Approve must not go through run(), which would force a full render");
  assert.equal(state.notice, t("copilot.approvalApproved"));
  assert.doesNotMatch(dom.window.document.getElementById("agent-approvals-slot").innerHTML, /data-approval-id="a1"/, "the card must be gone once the agent.approvals.changed push removes it");
});

test("clicking the real Deny button dispatches through the document click handler", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = { id: "c", title: "Chat", messages: [] };
  state.approvalsSnapshot = { pending: [{ id: "a1", conversationId: "c", runId: "r1", toolCallId: "tc1", tool: "sv_command", action: "delete_notes", category: "projectWrite", risk: "high", preview: "{}", createdAtUtc: "2026-01-01T00:00:00Z", expiresAtUtc: "2026-01-01T00:02:00Z" }], recent: [] };
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  const decideCalls = [];
  state.api = {
    decideAgentApproval: async (id, approve) => {
      decideCalls.push({ id, approve });
      state.listeners["agent.approvals.changed"]?.({ pending: [], recent: [] });
    },
  };
  const denyButton = dom.window.document.querySelector('[data-deny-agent="a1"]');
  assert.ok(denyButton, "the Deny button must exist in the rendered card");
  denyButton.click();
  await settle();
  assert.deepEqual(decideCalls, [{ id: "a1", approve: false }]);
  assert.equal(state.notice, t("copilot.approvalDenied"));
});

test("Stop patches only the composer action button, not a full render", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = { id: "c", title: "Chat", messages: [] };
  state.agentRunInFlight = true;
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  let runCalls = 0;
  const realRun = state.run;
  state.run = (task) => { runCalls += 1; return realRun(task); };
  const details = dom.window.document.querySelector(".messages");
  const sentinel = dom.window.document.createElement("div");
  sentinel.dataset.sentinel = "kept";
  details.appendChild(sentinel);
  state.api = { cancelAgentRun: async () => {} };
  await state.cancelAgentRun();
  assert.equal(runCalls, 0, "Stop must not go through run(), which would force a full render");
  assert.equal(dom.window.document.querySelector('[data-sentinel="kept"]'), sentinel, "nodes outside the composer slot survive Stop");
  assert.match(dom.window.document.getElementById("agent-composer-action").innerHTML, /data-cancel-agent-run/);
});

test("a failed cancelAgentRun call reports the error via a toast patch, without a full render", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = { id: "c", title: "Chat", messages: [] };
  state.agentRunInFlight = true;
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  let runCalls = 0;
  const realRun = state.run;
  state.run = (task) => { runCalls += 1; return realRun(task); };
  const contextError = vm.runInContext('new Error("stop failed")', state);
  state.api = { cancelAgentRun: async () => { throw contextError; } };
  await state.cancelAgentRun();
  assert.equal(runCalls, 0, "Stop's error path must not go through run() either");
  assert.match(state.error, /stop failed/);
  assert.equal(state.toastPatches.at(-1).errorHtml.includes("stop failed"), true, "the toast slot must be patched so the error is actually shown");
  assert.equal(state.agentRunCancelling, false, "cancelling flag resets so Stop can be pressed again");
});

test("an agent.approvals.changed push renders during an in-flight run, with category, preview and risk", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = { id: "c", title: "Chat", messages: [] };
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  await state.listenForAgentApprovals();
  state.agentRunInFlight = true;
  state.liveRunId = "run-1";
  state.liveRun = { sessionId: "c", runId: "run-1", seq: 1, phase: "running_tools", round: 1, text: "", plan: null, tools: [], toolCount: 0, budget: { level: "mid", maxTurns: 10, maxTokens: 1000, turns: 0, tokens: 0 }, retry: null, pendingInput: null };
  const approval = { id: "a1", conversationId: "c", runId: "run-1", toolCallId: "tc1", tool: "sv_command", action: "delete_notes", category: "projectWrite", risk: "high", preview: "{\"action\":\"delete_notes\"}", createdAtUtc: "2026-01-01T00:00:00Z", expiresAtUtc: "2026-01-01T00:02:00Z" };
  state.listeners["agent.approvals.changed"]({ pending: [approval], recent: [] });
  await flushMicrotasks();
  const html = dom.window.document.getElementById("agent-approvals-slot").innerHTML;
  assert.match(html, /data-approval-id="a1"/, "a card must render while sendPrompt's run is still in flight");
  assert.match(html, /agent-approval-category-projectWrite/);
  assert.match(html, /delete_notes/);
  assert.match(html, /agent-approval-risk-high/);
});

test("a resolved approval's tool row shows the outcome directly, instead of a separate duplicate resolution row", () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = { id: "c", title: "Chat", messages: [] };
  state.liveRunId = "run-1";
  state.liveRun = {
    sessionId: "c", runId: "run-1", seq: 2, phase: "running_tools", round: 1, text: "",
    plan: null,
    tools: [{ id: "tc1", name: "sv_command", status: "awaiting_approval", round: 1, summary: "delete_notes" }],
    toolCount: 1,
    budget: { level: "mid", maxTurns: 10, maxTokens: 1000, turns: 1, tokens: 5 },
    retry: null, pendingInput: null,
  };
  state.approvalsSnapshot = {
    pending: [],
    recent: [{ id: "r1", conversationId: "c", runId: "run-1", toolCallId: "tc1", tool: "sv_command", action: "delete_notes", outcome: "executed", ok: true, summary: "done", resolvedAtUtc: "2026-01-01T00:00:00Z" }],
  };
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  const liveRun = dom.window.document.getElementById("agent-live-run");
  const rows = liveRun.querySelectorAll('[data-tool-call-id="tc1"]');
  assert.equal(rows.length, 1, "the resolved call must render as exactly one row, not a tool row plus a separate resolution row");
  assert.match(rows[0].outerHTML, new RegExp(t("copilot.resolutionExecuted")), "the merged row must show the resolution's outcome, not the stale awaiting_approval status");
  assert.doesNotMatch(liveRun.innerHTML, /agent-tool-activity-awaiting_approval/, "the stale awaiting_approval status must not remain alongside the resolution");
});

test("denied/expired/cancelled resolutions never show the broker's English summary sentence; a failed execution shows only the extracted bridge error code", () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = { id: "c", title: "Chat", messages: [] };
  const base = { conversationId: "c", runId: "r1", toolCallId: "tc1", tool: "sv_command", action: "delete_notes", resolvedAtUtc: "2026-01-01T00:00:00Z" };
  state.approvalsSnapshot = {
    pending: [],
    recent: [
      { ...base, id: "r-denied", outcome: "denied", ok: false, summary: "The user denied this call." },
      { ...base, id: "r-failed", outcome: "executed", ok: false, summary: JSON.stringify({ phase: "mutated", wrote: true, undoRequired: true, retry: "query_again", error: { code: "BRIDGE_TIMEOUT", message: "no response" } }) },
    ],
  };
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  const liveRun = dom.window.document.getElementById("agent-live-run");
  const deniedRow = liveRun.querySelector('[data-approval-resolution-id="r-denied"]');
  assert.doesNotMatch(deniedRow.outerHTML, /denied this call/, "the broker's English sentence for the model must never reach a localized card");
  const failedRow = liveRun.querySelector('[data-approval-resolution-id="r-failed"]');
  assert.match(failedRow.outerHTML, /BRIDGE_TIMEOUT/, "a failed execution shows the extracted bridge error code");
  assert.doesNotMatch(failedRow.outerHTML, /query_again|undoRequired/, "the raw envelope JSON must not leak into the card, only the extracted code");
});

test("resolved approvals render inside #agent-live-run with the right outcome label, for every outcome", () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = { id: "c", title: "Chat", messages: [] };
  const base = { conversationId: "c", runId: "r1", tool: "sv_command", action: "delete_notes", resolvedAtUtc: "2026-01-01T00:00:00Z" };
  state.approvalsSnapshot = {
    pending: [],
    recent: [
      { ...base, id: "r-executed-ok", outcome: "executed", ok: true, summary: "done" },
      { ...base, id: "r-executed-failed", outcome: "executed", ok: false, summary: "bridge error" },
      { ...base, id: "r-denied", outcome: "denied", ok: false, summary: "" },
      { ...base, id: "r-expired", outcome: "expired", ok: false, summary: "" },
      { ...base, id: "r-cancelled", outcome: "cancelled", ok: false, summary: "" },
    ],
  };
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  const liveRun = dom.window.document.getElementById("agent-live-run");
  for (const id of ["r-executed-ok", "r-executed-failed", "r-denied", "r-expired", "r-cancelled"]) {
    assert.match(liveRun.innerHTML, new RegExp(`data-approval-resolution-id="${id}"`), `${id} must render`);
  }
  assert.match(liveRun.innerHTML, new RegExp(t("copilot.resolutionExecuted")));
  assert.match(liveRun.innerHTML, new RegExp(t("copilot.resolutionExecutedFailed")));
  assert.match(liveRun.innerHTML, new RegExp(t("copilot.resolutionDenied")));
  assert.match(liveRun.innerHTML, new RegExp(t("copilot.resolutionExpired")));
  assert.match(liveRun.innerHTML, new RegExp(t("copilot.resolutionCancelled")));
});

test("a foreign conversation's resolution is not rendered, but one from a previous run in this conversation still is (an approval can outlive its run)", () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = { id: "c", title: "Chat", messages: [] };
  state.liveRunId = "r2";
  const base = { tool: "sv_command", action: "delete_notes", resolvedAtUtc: "2026-01-01T00:00:00Z", outcome: "executed", ok: true, summary: "done" };
  state.approvalsSnapshot = {
    pending: [],
    recent: [
      { ...base, id: "r-foreign", conversationId: "other", runId: "r2" },
      { ...base, id: "r-previous-run", conversationId: "c", runId: "r1" },
      { ...base, id: "r-current", conversationId: "c", runId: "r2" },
    ],
  };
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  const liveRun = dom.window.document.getElementById("agent-live-run");
  assert.doesNotMatch(liveRun.innerHTML, /data-approval-resolution-id="r-foreign"/, "a foreign conversation's resolution must not render");
  assert.match(liveRun.innerHTML, /data-approval-resolution-id="r-previous-run"/, "a resolution from an earlier run in this same conversation must still render");
  assert.match(liveRun.innerHTML, /data-approval-resolution-id="r-current"/, "the current run's own resolution must render");
});

test("a full render resyncs the approvals cache so a later empty push removes a stale card", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = { id: "c", title: "Chat", messages: [] };
  await state.listenForAgentApprovals();
  // An empty push caches the empty-list diff key for the slot before any approval exists.
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  state.listeners["agent.approvals.changed"]({ pending: [], recent: [] });
  await flushMicrotasks();
  // A pending approval now exists; a full render (entering the page, opening a conversation, any run() action)
  // embeds it directly, bypassing patchSlot, so the cache must be resynced here or the next patch is skipped.
  const approval = { id: "a1", conversationId: "c", runId: "run-1", toolCallId: "tc1", tool: "sv_command", action: "delete_notes", category: "projectWrite", risk: "high", preview: "{}", createdAtUtc: "2026-01-01T00:00:00Z", expiresAtUtc: "2026-01-01T00:02:00Z" };
  state.approvalsSnapshot = { pending: [approval], recent: [] };
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  assert.match(dom.window.document.getElementById("agent-approvals-slot").innerHTML, /data-approval-id="a1"/);
  // The approval expires; the push carries an empty list again. Without a resynced cache this patch is
  // skipped because it would (wrongly) match the stale cache from before the full render.
  state.approvalsSnapshot = { pending: [], recent: [] };
  state.listeners["agent.approvals.changed"]({ pending: [], recent: [] });
  await flushMicrotasks();
  assert.doesNotMatch(dom.window.document.getElementById("agent-approvals-slot").innerHTML, /data-approval-id/, "the stale card must be removed");
});

test("a full render resyncs the goal-slot cache so run 2's blank plan is not skipped as a false cache match", () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = { id: "c", title: "Chat", messages: [] };
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  const runningView = (runId) => ({ sessionId: "c", runId, seq: 1, phase: "starting", round: 1, text: "", plan: null, tools: [], toolCount: 0, budget: { level: "mid", maxTurns: 10, maxTokens: 1000, turns: 0, tokens: 0 }, retry: null, pendingInput: null });
  // Run 1 starts with no plan yet; the patch caches the blank slot.
  state.liveRunId = "run-1";
  state.liveRun = runningView("run-1");
  state.applyLiveRunPatch();
  assert.equal(dom.window.document.getElementById("agent-goal-slot").innerHTML, "");
  // Run 1 ends and persists a plan; a full render (e.g. re-entering the page) embeds it directly.
  state.liveRunId = undefined;
  state.liveRun = undefined;
  state.conversation.messages = [{ role: "assistant", content: "done", outcome: { status: "completed", summary: "done", evidence: [], missing: [], plan: { goal: "Run 1 goal", doneCriteria: [], todos: [] }, budget: { level: "mid", maxTurns: 10, maxTokens: 1000, turns: 1, tokens: 5 } } }];
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  assert.match(dom.window.document.getElementById("agent-goal-slot").innerHTML, /Run 1 goal/);
  // Run 2 starts before its own update_plan call; the goal slot must blank out rather than keep
  // showing run 1's plan, matching what a full render would produce at this same instant.
  state.liveRunId = "run-2";
  state.liveRun = runningView("run-2");
  state.applyLiveRunPatch();
  assert.equal(dom.window.document.getElementById("agent-goal-slot").innerHTML, "", "run 1's stale plan must not survive the start of run 2");
});

test("sendPrompt keeps agentRunInFlight true while api.sendMessage is pending, and an approvals push still renders during that window", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const state = freshState({ document: dom.window.document });
  state.conversation = { id: "c", title: "Chat", messages: [] };
  dom.window.document.getElementById("root").innerHTML = state.renderCopilot();
  await state.listenForAgentApprovals();
  state.activeAiProvider = () => ({ connected: true, accounts: [], apiKeys: [], model: "test-model" });
  let resolveSend;
  state.api = {
    sendMessage: () => new Promise((resolve) => { resolveSend = resolve; }),
    listConversations: async () => [],
    agentApprovals: async () => ({ pending: [], recent: [] }),
    agentBudgets: async () => ({}),
  };
  const promptPromise = state.sendPrompt("do something");
  await flushMicrotasks();
  assert.equal(state.agentRunInFlight, true, "the run must be marked in-flight while sendMessage's promise is still pending");
  assert.ok(state.liveRunId, "a live run id must be assigned before the send resolves");
  const approval = { id: "a1", conversationId: "c", runId: state.liveRunId, toolCallId: "tc1", tool: "sv_command", action: "delete_notes", category: "projectWrite", risk: "high", preview: "{}", createdAtUtc: "2026-01-01T00:00:00Z", expiresAtUtc: "2026-01-01T00:02:00Z" };
  state.listeners["agent.approvals.changed"]({ pending: [approval], recent: [] });
  await flushMicrotasks();
  assert.match(dom.window.document.getElementById("agent-approvals-slot").innerHTML, /data-approval-id="a1"/, "an approval pushed while the run is in flight must still render");
  resolveSend([]);
  await promptPromise;
  assert.equal(state.agentRunInFlight, false, "the run must clear in-flight once sendMessage resolves");
  assert.equal(state.liveRunId, undefined, "the live run id must clear once the run ends");
});

console.log("Agent goal UI contracts passed.");
