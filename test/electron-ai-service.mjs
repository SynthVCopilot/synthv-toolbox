import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(root, "src/PiDesktop.Tauri/electron/services/ai-service.ts"), "utf8");
const executable = stripTypeScriptTypes(source
  .replace(
    'import { CredentialRouter, createCredentialMetadata } from "@model-auth/core";',
    'class CredentialRouter { constructor(credentials) { this.credentials = credentials; } }\nconst createCredentialMetadata = (credential) => credential;',
  )
  .replace(
    'import { AgentRuntimeWorker } from "../../../../packages/agent-runtime/src/index.js";',
    "class AgentRuntimeWorker {}",
  ), { mode: "transform" });
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
const runtime = {
  async request(method, params) {
    requests.push({ method, params });
    return method === "session.send" ? { message: "Runtime response" } : {};
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
let identifier = 0;
const service = new AiService({
  metadataPath,
  safeStorage,
  runtime,
  catalog,
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
const messages = await service.send_message(conversation.id, "Explain this score", directory);
assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
assert.equal(requests[0].method, "session.initialize");
assert.deepEqual(requests[0].params.model, { provider: "anthropic", model: ["cla", "ude-opus-4-8"].join("") });
assert.equal(requests[1].method, "session.send");
assert.equal((await service.open_conversation(conversation.id)).messages.length, 2);

const cancelled = new AiService({
  metadataPath: join(directory, "cancelled.json"),
  safeStorage,
  runtime,
  catalog,
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

await service.remove_ai_api_key("anthropic", credentialId);
await service.remove_ai_provider_account("anthropic", "anthropic:oauth");
assert.equal((await service.ai_provider_state()).providers.find((provider) => provider.id === "anthropic").credentials.length, 0);

console.log("Electron AI service persists encrypted credentials and drives Agent Runtime sessions.");
