import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EXECUTOR_BUILD_ID } from "../src/build-info.js";
import { loadConfig, type BridgeConfig } from "../src/config.js";
import { createEmbeddedBridge, type EmbeddedBridge } from "../src/embedded.js";
import { parseBridgeRequest } from "../src/protocol.js";
import { WriterLedger } from "../src/writer-ledger.js";

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function createTempConfig(): Promise<{ directory: string; config: BridgeConfig }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synthv-writer-ledger-test-"));
  const config = loadConfig(
    {
      SYNTHV_AGENT_BRIDGE_DIR: directory,
      SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "2000",
      SYNTHV_AGENT_BRIDGE_POLL_MS: "5",
      SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "3000",
      SYNTHV_AGENT_BRIDGE_STATUS_STALE_MS: "5000",
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
    projectFile: "writer-ledger-test.svp",
    ipcDirectory: config.paths.directory,
  });
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function serveOneRequest(
  config: BridgeConfig,
  buildResult: (payload: Record<string, unknown>) => unknown,
  captureLock?: (lock: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    if (captureLock !== undefined) {
      try {
        const lockRaw = await fs.readFile(config.paths.lockFile, "utf8");
        captureLock(JSON.parse(lockRaw) as Record<string, unknown>);
      } catch {
        // The lock file may not exist yet; keep polling for the request instead.
      }
    }
    try {
      await fs.rename(config.paths.requestFile, config.paths.processingFile);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the writer-ledger test IPC request");
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

async function readWritersFromStatus(bridge: EmbeddedBridge): Promise<{
  readonly self: { readonly client: string; readonly pid: number };
  readonly lastWrite: { readonly client: string; readonly pid: number; readonly action: string } | null;
  readonly lastWriteByOtherClient: boolean;
}> {
  const statusTool = bridge.tools.find((tool) => tool.name === "sv_status");
  assert.ok(statusTool);
  const result = await statusTool?.call({ operation: "bridge" });
  assert.equal(result?.isError, false);
  const parsed = JSON.parse(result?.text ?? "{}") as {
    readonly writers?: {
      readonly self: { readonly client: string; readonly pid: number };
      readonly lastWrite: { readonly client: string; readonly pid: number; readonly action: string } | null;
      readonly lastWriteByOtherClient: boolean;
    };
  };
  assert.ok(parsed.writers);
  return parsed.writers as never;
}

test("WriterLedger records and reports self vs. other-client writes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synthv-writer-ledger-unit-"));
  try {
    const filePath = path.join(directory, "writer.json");
    const ledger = new WriterLedger(filePath, () => "unit-test-client");

    const initial = await ledger.status();
    assert.equal(initial.lastWrite, null);
    assert.equal(initial.lastWriteByOtherClient, false);
    assert.equal(initial.self.client, "unit-test-client");
    assert.equal(initial.self.pid, process.pid);

    await ledger.record("edit_notes");
    const afterSelfWrite = await ledger.status();
    assert.equal(afterSelfWrite.lastWrite?.action, "edit_notes");
    assert.equal(afterSelfWrite.lastWriteByOtherClient, false);

    const otherLedger = new WriterLedger(filePath, () => "other-client");
    const seenByOther = await otherLedger.status();
    assert.equal(seenByOther.lastWriteByOtherClient, true);
    assert.equal(seenByOther.lastWrite?.client, "unit-test-client");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("sv_status bridge reports writers across two clients sharing one IPC directory", async () => {
  const { directory, config } = await createTempConfig();
  await writeFreshHeartbeat(config);
  const clientA = createEmbeddedBridge({ config, clientLabel: "client-a" });
  const clientB = createEmbeddedBridge({ config, clientLabel: "client-b" });
  try {
    const beforeA = await readWritersFromStatus(clientA);
    assert.equal(beforeA.lastWrite, null);
    assert.equal(beforeA.lastWriteByOtherClient, false);

    let observedLock: Record<string, unknown> | undefined;
    const served = serveOneRequest(
      config,
      () => ({
        action: "add_track",
        outcome: "changed",
        changedCount: 1,
        undoRecords: 1,
        verified: true,
        trackIndex: 1,
      }),
      (lock) => {
        observedLock = lock;
      },
    );
    const commandA = clientA.tools.find((tool) => tool.name === "sv_command");
    assert.ok(commandA);
    const result = await commandA?.call({ action: "add_track", args: {} });
    await served;
    assert.equal(result?.isError, false);
    assert.equal(observedLock?.client, "client-a");

    const afterA = await readWritersFromStatus(clientA);
    assert.equal(afterA.lastWrite?.client, "client-a");
    assert.equal(afterA.lastWrite?.action, "add_track");
    assert.equal(afterA.lastWriteByOtherClient, false);

    const afterB = await readWritersFromStatus(clientB);
    assert.equal(afterB.lastWrite?.client, "client-a");
    assert.equal(afterB.lastWriteByOtherClient, true);
  } finally {
    await clientA.close();
    await clientB.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a non-read sv_ui action records a write; a read sv_ui action does not", async () => {
  const { directory, config } = await createTempConfig();
  await writeFreshHeartbeat(config);
  const bridge = createEmbeddedBridge({ config, clientLabel: "ui-client" });
  try {
    const ui = bridge.tools.find((tool) => tool.name === "sv_ui");
    assert.ok(ui);

    const servedRead = serveOneRequest(config, () => ({ selection: { notes: [] } }));
    const readResult = await ui?.call({ action: "get_selection", args: {} });
    await servedRead;
    assert.equal(readResult?.isError, false);
    const afterRead = await readWritersFromStatus(bridge);
    assert.equal(afterRead.lastWrite, null);

    const servedWrite = serveOneRequest(config, () => ({ selection: { notes: [] } }));
    const writeResult = await ui?.call({
      action: "set_selection",
      args: { scope: "pianoRoll", operation: "clear", kind: "all" },
    });
    await servedWrite;
    assert.equal(writeResult?.isError, false);
    const afterWrite = await readWritersFromStatus(bridge);
    assert.equal(afterWrite.lastWrite?.action, "set_selection");
  } finally {
    await bridge.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
