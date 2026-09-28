import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { EXECUTOR_BUILD_ID, PUBLIC_MCP_TOOL_NAMES } from "../src/build-info.js";
import { loadConfig, type BridgeConfig } from "../src/config.js";
import { createEmbeddedBridge } from "../src/embedded.js";
import { parseBridgeRequest } from "../src/protocol.js";
import { createServer } from "../src/server.js";
import {
  commandPolicyActionNames,
  commandPolicyFor,
} from "../src/v3-command-policy.js";

async function writeJsonAtomically(
  filePath: string,
  value: unknown,
): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function createTempConfig(
  overrides: NodeJS.ProcessEnv = {},
): Promise<{ directory: string; config: BridgeConfig }> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-embedded-bridge-test-"),
  );
  const config = loadConfig(
    {
      SYNTHV_AGENT_BRIDGE_DIR: directory,
      SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "2000",
      SYNTHV_AGENT_BRIDGE_POLL_MS: "5",
      SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "3000",
      SYNTHV_AGENT_BRIDGE_STATUS_STALE_MS: "5000",
      ...overrides,
    },
    directory,
  );
  return { directory, config };
}

async function writeFreshHeartbeat(config: BridgeConfig): Promise<void> {
  await fs.mkdir(config.paths.directory, { recursive: true });
  await writeJsonAtomically(config.paths.statusFile, {
    protocolVersion: 3,
    state: "running",
    updatedAtEpochMs: Date.now(),
    bridgeVersion: "0.3.1",
    executorBuildId: EXECUTOR_BUILD_ID,
    host: { osType: "Linux" },
    projectFile: "embedded-parity-test.svp",
    ipcDirectory: config.paths.directory,
  });
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function serveOneRequest(
  config: BridgeConfig,
  buildResult: (payload: Record<string, unknown>) => unknown,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      await fs.rename(config.paths.requestFile, config.paths.processingFile);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the embedded-bridge test IPC request");
      }
      await sleep(5);
    }
  }
  const request = parseBridgeRequest(
    JSON.parse(await fs.readFile(config.paths.processingFile, "utf8")),
  );
  await writeJsonAtomically(config.paths.responseFile, {
    v: 3,
    id: request.requestId,
    t: request.traceId,
    b: EXECUTOR_BUILD_ID,
    r: buildResult(request.payload as Record<string, unknown>),
  });
  await fs.rm(config.paths.processingFile, { force: true });
  return request.payload as Record<string, unknown>;
}

function stripTraceId(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripTraceId);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const { traceId: _traceId, ...rest } = value as Record<string, unknown>;
  return rest;
}

test("embedded bridge exposes the six public tools in protocol order", async () => {
  const { directory, config } = await createTempConfig();
  const bridge = createEmbeddedBridge({ config, clientLabel: "embedded-test" });
  try {
    assert.deepEqual(
      bridge.tools.map((tool) => tool.name),
      [...PUBLIC_MCP_TOOL_NAMES],
    );
  } finally {
    await bridge.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("embedded inputSchema deep-equals the MCP listTools schema minus $schema", async () => {
  const { directory, config } = await createTempConfig();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(config);
  const client = new Client({ name: "parity-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const bridge = createEmbeddedBridge({ config, clientLabel: "embedded-test" });
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [...PUBLIC_MCP_TOOL_NAMES].sort(),
    );
    for (const tool of bridge.tools) {
      const mcpTool = listed.tools.find((entry) => entry.name === tool.name);
      assert.ok(mcpTool, `MCP server did not list ${tool.name}`);
      const mcpSchema = { ...(mcpTool?.inputSchema as Record<string, unknown>) };
      delete mcpSchema.$schema;
      assert.deepEqual(tool.inputSchema, mcpSchema, `inputSchema mismatch for ${tool.name}`);
    }
  } finally {
    await client.close();
    await server.close();
    await bridge.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("embedded call fills zod defaults the same way the MCP server does", async () => {
  const { directory, config } = await createTempConfig();
  await writeFreshHeartbeat(config);
  const bridge = createEmbeddedBridge({ config, clientLabel: "embedded-test" });
  try {
    const served = serveOneRequest(config, () => ({
      tracks: [],
      totalCount: 0,
    }));
    const query = bridge.tools.find((tool) => tool.name === "sv_query");
    assert.ok(query);
    const result = await query?.call({ action: "list_tracks", args: {} });
    const payload = await served;
    assert.equal(payload.offset, 0);
    assert.equal(payload.limit, 128);
    assert.equal(result?.isError, false);
  } finally {
    await bridge.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("embedded call rejects invalid input before touching IPC", async () => {
  const { directory, config } = await createTempConfig();
  const bridge = createEmbeddedBridge({ config, clientLabel: "embedded-test" });
  try {
    const command = bridge.tools.find((tool) => tool.name === "sv_command");
    assert.ok(command);
    const result = await command?.call({});
    assert.equal(result?.isError, true);
    const parsed = JSON.parse(result?.text ?? "{}") as {
      readonly phase?: string;
      readonly error?: { readonly code?: string };
    };
    assert.equal(parsed.error?.code, "INVALID_ARGUMENT");
    assert.equal(parsed.phase, "accepted");
    await assert.rejects(fs.access(config.paths.requestFile));
  } finally {
    await bridge.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("embedded and MCP produce equal results (traceId aside) for the same fake-host sv_command", async () => {
  const commandArgs = { action: "add_track", args: { name: "Parity Track" } };
  const fakeResult = {
    action: "add_track",
    outcome: "changed",
    changedCount: 1,
    undoRecords: 1,
    verified: true,
    trackIndex: 4,
  };

  const embeddedFixture = await createTempConfig();
  await writeFreshHeartbeat(embeddedFixture.config);
  const bridge = createEmbeddedBridge({
    config: embeddedFixture.config,
    clientLabel: "embedded-test",
  });
  let embeddedText: string;
  try {
    const served = serveOneRequest(embeddedFixture.config, () => fakeResult);
    const command = bridge.tools.find((tool) => tool.name === "sv_command");
    assert.ok(command);
    const result = await command?.call(commandArgs);
    await served;
    assert.equal(result?.isError, false);
    embeddedText = result?.text ?? "";
  } finally {
    await bridge.close();
    await fs.rm(embeddedFixture.directory, { recursive: true, force: true });
  }

  const mcpFixture = await createTempConfig();
  await writeFreshHeartbeat(mcpFixture.config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(mcpFixture.config);
  const client = new Client({ name: "parity-test", version: "1.0.0" });
  let mcpText: string;
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const served = serveOneRequest(mcpFixture.config, () => fakeResult);
    const callResult = await client.callTool({ name: "sv_command", arguments: commandArgs });
    await served;
    const content = (
      callResult as {
        readonly content: readonly { readonly type: string; readonly text?: string }[];
      }
    ).content;
    mcpText = content.find((entry) => entry.type === "text")?.text ?? "";
  } finally {
    await client.close();
    await server.close();
    await fs.rm(mcpFixture.directory, { recursive: true, force: true });
  }

  assert.deepEqual(
    stripTraceId(JSON.parse(embeddedText)),
    stripTraceId(JSON.parse(mcpText)),
  );
});

test("classify reports the documented category table", async () => {
  const { directory, config } = await createTempConfig();
  const bridge = createEmbeddedBridge({ config, clientLabel: "embedded-test" });
  try {
    assert.deepEqual(
      bridge.classify("sv_command", { action: "edit_notes", args: {} }),
      { category: "projectWrite", risk: "normal" },
    );
    assert.deepEqual(
      bridge.classify("sv_ui", { action: "get_selection", args: {} }),
      { category: "read", risk: "normal" },
    );
    assert.deepEqual(
      bridge.classify("sv_ui", { action: "set_selection", args: {} }),
      { category: "uiChange", risk: "normal" },
    );
    assert.deepEqual(
      bridge.classify("sv_status", { operation: "reload" }),
      { category: "executorControl", risk: "high" },
    );
    assert.deepEqual(
      bridge.classify("sv_status", { operation: "bridge" }),
      { category: "read", risk: "normal" },
    );
    for (const name of ["sv_query", "sv_describe", "sv_review"]) {
      assert.deepEqual(bridge.classify(name, {}), {
        category: "read",
        risk: "normal",
      });
    }
  } finally {
    await bridge.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("classify risk is derived from the command policy catalog, never a name list", async () => {
  const { directory, config } = await createTempConfig();
  const bridge = createEmbeddedBridge({ config, clientLabel: "embedded-test" });
  try {
    let sawDelete = false;
    let sawTransaction = false;
    for (const action of commandPolicyActionNames()) {
      const policy = commandPolicyFor(action);
      const { risk } = bridge.classify("sv_command", { action, args: {} });
      if (policy.category === "delete") {
        sawDelete = true;
        assert.equal(risk, "high", `${action} deletes content and must be high risk`);
      } else if (policy.category === "transaction") {
        sawTransaction = true;
        assert.equal(risk, "high", `${action} is a transaction and must be high risk`);
      } else if (policy.category === "edit") {
        assert.equal(risk, "normal", `${action} is an ordinary edit and must stay normal risk`);
      }
    }
    // The policy catalog must actually contain delete/transaction actions for
    // this test to exercise the branch it claims to guard.
    assert.ok(sawDelete);
    assert.ok(sawTransaction);

    assert.equal(
      bridge.classify("sv_command", {
        action: "clone_group_reference",
        args: { sharedGroupPolicy: "allowAllReferences" },
      }).risk,
      "high",
    );
    assert.equal(
      bridge.classify("sv_command", {
        action: "clone_group_reference",
        args: { sharedGroupPolicy: "reject" },
      }).risk,
      "normal",
    );
  } finally {
    await bridge.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
