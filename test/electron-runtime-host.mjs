import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = readFileSync(new URL("../src/PiDesktop.Tauri/electron/services/runtime-host.ts", import.meta.url), "utf8");

test("Electron runtime host keeps privileged MCP tools server-assigned", () => {
  assert.match(source, /toolbox_internal/);
  assert.match(source, /toolbox_advanced/);
  assert.match(source, /"permission" in args/);
  assert.match(source, /mcpInternalFunctionsEnabled/);
  assert.match(source, /mcpAdvancedFunctionsEnabled/);
  assert.match(source, /pluginInternalFunctionsEnabled/);
  assert.match(source, /pluginAdvancedFunctionsEnabled/);
  assert.match(source, /Plugin host requests require pluginId/);
  assert.match(source, /pluginPermissionLevel\(manifest, permission\) === "none"/);
});

test("A real ElectronRuntimeHost resolves the model through AiService and drives an agent session end to end", async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const tauriRoot = join(root, "src/PiDesktop.Tauri");
  const runtimeProtocolUrl = pathToFileURL(join(root, "packages/runtime-protocol/dist/index.js")).href;
  const agentRuntimeUrl = pathToFileURL(join(root, "packages/agent-runtime/dist/index.js")).href;
  const modelAuthCoreUrl = pathToFileURL(join(tauriRoot, "node_modules/@model-auth/core/dist/index.js")).href;

  const loadModule = async (relativePath, extraReplacements = []) => {
    const raw = await readFile(join(tauriRoot, relativePath), "utf8");
    let text = raw
      .replace('from "@synthv-toolbox/runtime-protocol";', `from "${runtimeProtocolUrl}";`)
      .replace('from "@synthv-toolbox/agent-runtime";', `from "${agentRuntimeUrl}";`)
      .replace('from "@model-auth/core";', `from "${modelAuthCoreUrl}";`);
    for (const [search, replace] of extraReplacements) text = text.replace(search, replace);
    const executable = stripTypeScriptTypes(text, { mode: "transform" });
    return import(`data:text/javascript;base64,${Buffer.from(executable).toString("base64")}`);
  };

  const { AiService } = await loadModule("electron/services/ai-service.ts");
  const { ElectronRuntimeHost } = await loadModule("electron/services/runtime-host.ts");

  const directory = await mkdtemp(join(tmpdir(), "electron-runtime-host-"));
  const secrets = new Map();
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const token = Buffer.from(`sealed:${secrets.size}`);
      secrets.set(token.toString("base64"), value);
      return token;
    },
    decryptString(value) {
      const found = secrets.get(value.toString("base64"));
      if (found === undefined) throw new Error("Unknown sealed credential in test stub.");
      return found;
    },
  };
  const catalog = {
    async models() { return [["cla", "ude-opus-4-8"].join("")]; },
    async opencode() { return {}; },
  };

  const runtimeHost = new ElectronRuntimeHost(
    join(directory, "runtime"),
    { invoke: () => { throw new Error("not used in this test"); }, resolveModel: () => ai.resolveModelSelection() },
    {
      async create() {
        return {
          async prompt(input, budget) {
            return {
              message: `Handled: ${input}`,
              outcome: { status: "completed", summary: "Done.", evidence: ["Replied to the prompt."], missing: [], plan: null, budget: { ...budget, turns: 1, tokens: 100 } },
            };
          },
          dispose() {},
        };
      },
    },
  );
  const ai = new AiService({
    metadataPath: join(directory, "ai.json"),
    safeStorage,
    runtime: { async request() { throw new Error("not used in this test"); } },
    catalog,
    id: () => `id-${Math.random()}`,
  });

  await ai.add_ai_api_key("anthropic", "Test key", "test-api-key");
  await ai.select_ai_provider("anthropic", ["cla", "ude-opus-4-8"].join(""));

  const initResult = await runtimeHost.initializeAgentSession("session-1");
  assert.ok(initResult && typeof initResult === "object");

  const sendResult = await runtimeHost.sendAgentMessage("session-1", "Hello there");
  assert.equal(sendResult.accepted, true);
  assert.equal(sendResult.message, "Handled: Hello there");
  assert.equal(sendResult.outcome.status, "completed");
});
