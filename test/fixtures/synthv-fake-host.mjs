import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const bridgeDirectory = fileURLToPath(new URL("../../src/PiDesktop.Tauri/components/synthv-agent-bridge/", import.meta.url));
const { EXECUTOR_BUILD_ID } = await import(pathToFileURL(join(bridgeDirectory, "dist/src/build-info.js")).href);

const SERVER_NAME = "synthv-agent-bridge";
const PROTOCOL_VERSION = 3;
const HEARTBEAT_INTERVAL_MS = 1_000;
const POLL_INTERVAL_MS = 10;

function paths(ipcDirectory) {
  const prefix = join(ipcDirectory, SERVER_NAME);
  return {
    requestFile: `${prefix}.request.json`,
    processingFile: `${prefix}.processing.json`,
    responseFile: `${prefix}.response.json`,
    statusFile: `${prefix}.status.json`,
  };
}

async function writeJsonAtomically(filePath, value) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporary, filePath);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stands in for the real SynthV Lua executor: writes a status heartbeat, claims request -> processing,
 * and answers with a correlated response (or leaves it claimed, unanswered, when claimOnly is set).
 */
export async function startFakeHost({ ipcDirectory, handler, claimOnly = false }) {
  const filePaths = paths(ipcDirectory);
  await mkdir(ipcDirectory, { recursive: true });

  let stopped = false;
  const writeHeartbeat = () => writeJsonAtomically(filePaths.statusFile, {
    protocolVersion: PROTOCOL_VERSION,
    state: "running",
    updatedAtEpochMs: Date.now(),
    bridgeVersion: "0.3.1",
    executorBuildId: EXECUTOR_BUILD_ID,
    host: { osType: process.platform === "darwin" ? "Darwin" : process.platform === "win32" ? "Windows" : "Linux" },
    projectFile: "fake-host-test.svp",
    ipcDirectory,
  });
  await writeHeartbeat();
  const heartbeatTimer = setInterval(() => { void writeHeartbeat(); }, HEARTBEAT_INTERVAL_MS);

  const claimedRequestIds = new Set();

  const loop = (async () => {
    while (!stopped) {
      let raw;
      try {
        await rename(filePaths.requestFile, filePaths.processingFile);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      try {
        raw = JSON.parse(await readFile(filePaths.processingFile, "utf8"));
      } catch {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      claimedRequestIds.add(raw.id);
      if (claimOnly) continue; // Leave the processing file in place: claimed, never answered.
      const outcome = await handler(raw.a, raw.p ?? {}, raw);
      const isError = Boolean(outcome && typeof outcome === "object" && "e" in outcome);
      await writeJsonAtomically(filePaths.responseFile, {
        v: PROTOCOL_VERSION,
        id: raw.id,
        t: raw.t,
        b: EXECUTOR_BUILD_ID,
        ...(isError ? { e: outcome.e } : { r: outcome }),
      });
      await rm(filePaths.processingFile, { force: true });
    }
  })();

  return {
    claimedRequestIds,
    async stop() {
      stopped = true;
      clearInterval(heartbeatTimer);
      await loop;
    },
  };
}
