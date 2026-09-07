import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripTypeScriptTypes } from "node:module";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, "src", "PiDesktop.Tauri", "src", "main.ts"), "utf8");
const start = source.indexOf("async function refresh(): Promise<void>");
const end = source.indexOf("async function refreshAccountUsage", start);
const refresh = stripTypeScriptTypes(source.slice(start, end));

const context = {
  app: undefined,
  lyricProjects: [],
  synthvProcesses: [],
  synthvShortcutProfile: undefined,
  bridgeSession: undefined,
  mediaTasks: [],
  tuningProfiles: [],
  httpApiStatus: undefined,
  page: "bridge",
  api: {
    bootstrap: async () => ({ bridgeConnected: true }),
    listLyricProjects: async () => [],
    listSynthvProcesses: async () => [],
    synthvShortcutProfile: async () => ({ bridgeStart: "F13" }),
    bridgeSessionStatus: async () => { throw new Error("stale heartbeat"); },
    mediaTasks: async () => [],
    listTuningProfiles: async () => [],
    getHttpApiStatus: async () => ({ enabled: false }),
  },
};

await Function("context", `with (context) { return (async () => { ${refresh}; await refresh(); return { app, bridgeSession }; })(); }`)(context)
  .then((result) => {
    assert.equal(result.app.bridgeConnected, true);
    assert.equal(result.bridgeSession.connected, false);
    assert.equal(result.bridgeSession.instanceOwnership, "unverified");
  });

console.log("Bridge instance refresh fallback passed.");
