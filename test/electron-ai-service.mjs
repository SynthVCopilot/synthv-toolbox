import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeProtocolUrl = pathToFileURL(join(root, "packages/runtime-protocol/dist/index.js")).href;
const { estimateAgentRunBudget } = await import(runtimeProtocolUrl);
const source = await readFile(join(root, "src/PiDesktop.Tauri/electron/services/ai-service.ts"), "utf8");
const executable = stripTypeScriptTypes(source
  .replace(
    'import { CredentialRouter, createCredentialMetadata } from "@model-auth/core";',
    'class CredentialRouter { constructor(credentials) { this.credentials = credentials; } candidates({ providerId, modelId }) { return this.credentials.filter((c) => c.enabled && c.providerId === providerId && c.modelIds.includes(modelId)); } }\nconst createCredentialMetadata = (credential) => credential;',
  )
  .replace(
    'import { AgentRuntimeWorker } from "@synthv-toolbox/agent-runtime";',
    "class AgentRuntimeWorker {}",
  )
  .replace('from "@synthv-toolbox/runtime-protocol";', `from "${runtimeProtocolUrl}";`), { mode: "transform" });
const { AiService } = await import(`data:text/javascript;base64,${Buffer.from(executable).toString("base64")}`);

const directory = await mkdtemp(join(tmpdir(), "electron-ai-service-"));
const metadataPath = join(directory, "ai.json");
const secrets = [];
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString(value) {
    secrets.push(value);
    return Buffer.from(`sealed:${value}`);
  },
  decryptString(value) {
    return value.toString("utf8").replace(/^sealed:/, "");
  },
};
const requests = [];
let nextSendResult = { message: "Runtime response" };
const runtime = {
  async request(method, params) {
    requests.push({ method, params });
    return method === "session.send" ? nextSendResult : {};
  },
};
const catalog = {
  async models(provider, force) {
    assert.equal(typeof force, "boolean");
    return provider === "anthropic" ? [["cla", "ude-sonnet-4-6"].join(""), ["cla", "ude-opus-4-8"].join("")] : [["g", "pt-5.6-terra"].join("")];
  },
  async opencode(force) {
    return { force, providers: ["openai-codex"] };
  },
};
const usage = { async query(provider, credentialIds) { return { provider, credentialIds }; } };
const cancelledConversations = [];
const approvals = { cancelConversation(conversationId) { cancelledConversations.push(conversationId); } };
let identifier = 0;
const service = new AiService({
  metadataPath,
  safeStorage,
  runtime,
  catalog,
  approvals,
  usage,
  now: () => new Date("2026-09-13T00:00:00.000Z"),
  id: () => `id-${++identifier}`,
  authorizer: {
    async authorize(provider) {
      return { id: `${provider}:oauth`, label: "Primary OAuth", secret: "oauth-secret", models: [["cla", "ude-opus-4-8"].join("")], expiresAt: 1234 };
    },
  },
});

const added = await service.add_ai_api_key("anthropic", "Personal key", "api-secret");
assert.equal(added.credential.label, "Personal key");
assert.equal(added.credential.sealed, undefined);
const encryptedMetadata = await readFile(metadataPath, "utf8");
assert.doesNotMatch(encryptedMetadata, /api-secret|oauth-secret/);
assert.match(encryptedMetadata, /c2VhbGVkOmFwaS1zZWNyZXQ=/);

const credentialId = added.credential.id;
await service.update_ai_api_key("anthropic", credentialId, { label: "Rotated key", apiKey: "rotated-secret", models: [["cla", "ude-opus-4-8"].join("")] });
assert.ok(secrets.includes("rotated-secret"));
await service.update_ai_credential("anthropic", credentialId, true, 3);
await service.update_ai_provider("anthropic", false);
await service.update_ai_provider_strategy("anthropic", "weighted-round-robin");
const selected = await service.select_ai_provider("anthropic", ["cla", "ude-opus-4-8"].join(""));
assert.equal(selected.activeProvider, "anthropic");
assert.equal(selected.providers.find((provider) => provider.id === "anthropic").loadStrategy, "weighted-round-robin");

const authorized = await service.authorize_ai_provider("anthropic", "authorize-1");
assert.equal(authorized.credential.kind, "oauth");
assert.ok(secrets.includes("oauth-secret"));
const usageState = await service.ai_provider_usage();
assert.equal(usageState.providers.anthropic.provider, "anthropic");
assert.deepEqual(await service.opencode_provider_catalog(true), { force: true, providers: ["openai-codex"] });

const conversation = await service.new_conversation();
assert.deepEqual(await service.list_conversations(), [{ id: conversation.id, title: "New conversation", updatedAt: "2026-09-13T00:00:00.000Z", messageCount: 0 }]);

const planA = { goal: "G1", doneCriteria: ["done1"], todos: [{ id: "t1", title: "T1", status: "completed" }] };
const outcomeA = {
  status: "completed",
  summary: "S1",
  evidence: ["evidence1"],
  missing: [],
  plan: planA,
  budget: { level: "mid", maxTurns: 5, maxTokens: 1000, turns: 3, tokens: 500 },
};
nextSendResult = { message: "Assistant reply one", outcome: outcomeA };
const messages = await service.send_message(conversation.id, "Explain this score", { cwd: directory, effort: "mid" });
assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
assert.equal(requests[0].method, "session.initialize");
assert.equal(requests[0].params.cwd, directory);
assert.equal(requests[0].params.outcome, undefined, "no prior outcome exists yet");
assert.equal(requests[1].method, "session.send");
assert.deepEqual(requests[1].params.budget, estimateAgentRunBudget("mid", []));
assert.equal(typeof requests[1].params.runId, "string");
assert.ok(requests[1].params.runId.length > 0, "a runId is generated and forwarded when the caller omits one");
assert.equal(messages[1].content, "Assistant reply one");
assert.deepEqual(messages[1].outcome, outcomeA);
assert.equal((await service.open_conversation(conversation.id)).messages.length, 2);

const outcomeB = {
  status: "needs_input",
  summary: "S2",
  evidence: [],
  missing: ["missing-item"],
  plan: null,
  budget: { level: "mid", maxTurns: 5, maxTokens: 1200, turns: 4, tokens: 800 },
};
nextSendResult = { message: "", outcome: outcomeB };
const secondTurn = await service.send_message(conversation.id, "Second turn", { effort: "mid" });
assert.deepEqual(requests[2].params.outcome, outcomeA, "the latest outcome is carried into the next session.initialize");
assert.deepEqual(requests[3].params.budget, estimateAgentRunBudget("mid", [{ level: "mid", turns: 3, tokens: 500, censored: false }]));
assert.equal(secondTurn[1].content, "S2", "an empty runtime message falls back to the outcome summary");

const outcomeC = {
  status: "budget_exhausted",
  summary: "",
  evidence: [],
  missing: [],
  plan: null,
  budget: { level: "mid", maxTurns: 5, maxTokens: 1000, turns: 5, tokens: 1000 },
};
nextSendResult = { message: "", outcome: outcomeC };
const thirdTurn = await service.send_message(conversation.id, "Third turn", { effort: "mid" });
assert.deepEqual(requests[4].params.outcome, outcomeB, "the latest outcome is still carried forward");
assert.equal(thirdTurn[1].content, "", "budget_exhausted outcomes may leave the assistant message empty");

const outcomeD = {
  status: "cancelled",
  summary: "",
  evidence: [],
  missing: [],
  plan: null,
  budget: { level: "mid", maxTurns: 5, maxTokens: 1000, turns: 2, tokens: 300 },
};
nextSendResult = { message: "", outcome: outcomeD };
const fourthTurn = await service.send_message(conversation.id, "Fourth turn", { effort: "mid" });
assert.equal(fourthTurn[1].content, "", "a cancelled outcome is persisted like any other outcome");

assert.deepEqual(service.agentUsageSamples(), [
  { level: "mid", turns: 3, tokens: 500, censored: false },
  { level: "mid", turns: 4, tokens: 800, censored: false },
  { level: "mid", turns: 5, tokens: 1000, censored: true },
]);
const budgets = await service.agent_budgets();
assert.equal(budgets.max.maxTurns, null);
assert.equal(budgets.max.maxTokens, null);
assert.deepEqual(budgets.mid, estimateAgentRunBudget("mid", service.agentUsageSamples()));

await service.cancel_agent_run(conversation.id);
assert.equal(requests.at(-1).method, "session.cancel");
assert.equal(requests.at(-1).params.sessionId, conversation.id);
assert.deepEqual(cancelledConversations, [conversation.id], "Stop cancels this conversation's pending approvals on the active-run path");

nextSendResult = { message: "x", outcome: { status: "bogus" } };
await assert.rejects(() => service.send_message(conversation.id, "Fifth turn", { effort: "mid" }), /invalid run outcome/);

const droppedPath = join(directory, "dropped-outcome.json");
await writeFile(droppedPath, JSON.stringify({
  version: 1,
  activeProvider: "anthropic",
  providers: { anthropic: { model: "m", oauthEnabled: true, strategy: "round-robin" }, "openai-codex": { model: "", oauthEnabled: true, strategy: "round-robin" }, workbuddy: { model: "", oauthEnabled: true, strategy: "round-robin" }, traecode: { model: "", oauthEnabled: true, strategy: "round-robin" } },
  credentials: [],
  conversations: [{
    id: "conv-dropped", title: "Dropped", createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z",
    messages: [{ role: "assistant", content: "hello", createdAt: "2026-09-13T00:00:00.000Z", outcome: { status: "completed" } }],
  }],
}), "utf8");
const recovered = new AiService({ metadataPath: droppedPath, safeStorage, runtime, catalog, approvals, id: () => "recovered" });
const droppedConversation = await recovered.open_conversation("conv-dropped");
assert.equal(droppedConversation.messages[0].outcome, undefined, "an invalid stored outcome is dropped when metadata loads");

const cancelled = new AiService({
  metadataPath: join(directory, "cancelled.json"),
  safeStorage,
  runtime,
  catalog,
  approvals,
  id: () => "cancelled",
  authorizer: {
    authorize(_provider, signal) {
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    },
  },
});
const pending = cancelled.authorize_ai_provider("anthropic", "operation-1");
cancelled.cancel_ai_authorization("operation-1");
await assert.rejects(pending, /cancelled/);

const resolved = await service.resolveModelSelection();
assert.equal(resolved.providerId, "anthropic");
assert.equal(resolved.modelId, ["cla", "ude-opus-4-8"].join(""));
assert.ok(Array.isArray(resolved.credentials) && resolved.credentials.length >= 1, "an undecryptable oauth candidate (not JSON) is skipped, not fatal");
assert.ok(resolved.credentials.every((credential) => typeof credential.apiKey === "string" && credential.apiKey.length > 0));
assert.ok(resolved.credentials.some((credential) => credential.authMethod === "api-key" && credential.apiKey === "rotated-secret"));
assert.equal(resolved.apiKey, undefined, "the legacy single-credential shape is gone");

await service.remove_ai_api_key("anthropic", credentialId);
await service.remove_ai_provider_account("anthropic", "anthropic:oauth");
const anthropic = (await service.ai_provider_state()).providers.find((provider) => provider.id === "anthropic");
assert.equal(anthropic.accounts.length + anthropic.apiKeys.length, 0);

{
  // Active-run registry: a caller-supplied runId is forwarded verbatim, a second concurrent send on the
  // same conversation is rejected before session.initialize, and cancelling before session.send is issued
  // skips the send and persists a zero-usage cancelled outcome.
  const activeRunRequests = [];
  let releaseInitialize;
  let blockNextInitialize = true;
  const activeRunRuntime = {
    async request(method, params) {
      activeRunRequests.push({ method, params });
      if (method === "session.initialize" && blockNextInitialize) { blockNextInitialize = false; await new Promise((resolve) => { releaseInitialize = resolve; }); }
      if (method === "session.send") return { message: "Handled.", outcome: { status: "completed", summary: "Handled.", evidence: ["e"], missing: [], plan: { goal: "G", doneCriteria: ["e"], todos: [{ id: "t1", title: "T", status: "completed" }] }, budget: { level: "mid", maxTurns: 5, maxTokens: 1000, turns: 1, tokens: 10 } } };
      return {};
    },
  };
  let activeRunIdentifier = 0;
  const activeRunCancelled = [];
  const activeRunApprovals = { cancelConversation(conversationId) { activeRunCancelled.push(conversationId); } };
  const activeRunService = new AiService({ metadataPath: join(directory, "active-run.json"), safeStorage, runtime: activeRunRuntime, catalog, approvals: activeRunApprovals, id: () => `active-${++activeRunIdentifier}` });
  const conversation = await activeRunService.new_conversation();

  const firstSend = activeRunService.send_message(conversation.id, "First", { runId: "explicit-run-id" });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => activeRunService.send_message(conversation.id, "Second", {}),
    /already in progress/,
    "a second send on the same conversation is rejected before session.initialize",
  );
  await activeRunService.cancel_agent_run(conversation.id);
  assert.deepEqual(activeRunCancelled, [conversation.id], "Stop cancels pending approvals even on the early-cancel path, before session.send is issued");
  releaseInitialize();
  const firstMessages = await firstSend;
  assert.equal(firstMessages[1].outcome.status, "cancelled", "cancelling before session.send is issued skips the send and persists a cancelled outcome");
  assert.equal(firstMessages[1].outcome.budget.turns, 0, "the cancelled outcome carries zero usage");
  assert.equal(firstMessages[1].outcome.budget.tokens, 0);
  assert.equal(activeRunRequests.filter((request) => request.method === "session.send").length, 0, "session.send is never called when cancelled before it is issued");
  assert.equal(activeRunRequests.find((request) => request.method === "session.initialize").params.outcome, undefined);
  assert.equal(firstMessages[0].content, "First", "the user message is still persisted for a run cancelled before session.send");
  assert.equal(firstMessages[1].outcome.runId ?? undefined, undefined, "no progress data (including runId) is stored in the persisted outcome");

  const thirdSend = await activeRunService.send_message(conversation.id, "Third");
  assert.equal(thirdSend[1].outcome.status, "completed", "the active-run slot is released after the cancelled run finishes");
  const sendRequest = activeRunRequests.filter((request) => request.method === "session.send").at(-1);
  assert.match(sendRequest.params.runId, /^active-\d+$/, "a runId is generated when the caller omits one");
}

console.log("Electron AI service persists encrypted credentials and drives Agent Runtime sessions.");
