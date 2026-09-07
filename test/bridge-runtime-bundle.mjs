import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const component = join(root, "src", "PiDesktop.Tauri", "src-tauri", "components", "synthv-agent-bridge");
await mkdir(join(root, "test", ".tmp"), { recursive: true });
const runtime = await mkdtemp(join(root, "test", ".tmp", "synthv-agent-bridge-runtime-"));
const bundledEntries = ["dist/src/cli.js", "dist/legacy-sv1/src/cli.js", "dist/src/score-import.js"];
const notices = await readFile(join(component, "dist", "THIRD_PARTY_NOTICES.txt"), "utf8");
assert.match(notices, /@modelcontextprotocol\/sdk 1\.29\.0/u);
assert.match(notices, /zod 4\.4\.3/u);

try {
  for (const entry of bundledEntries) {
    await mkdir(dirname(join(runtime, entry)), { recursive: true });
    await cp(join(component, entry), join(runtime, entry));
  }
  await cp(join(component, "package.json"), join(runtime, "package.json"));
  await cp(join(component, "scripts"), join(runtime, "scripts"), { recursive: true });
  await cp(join(component, "synthv"), join(runtime, "synthv"), { recursive: true });
  await cp(join(component, "src"), join(runtime, "src"), { recursive: true });
  await cp(join(component, "tsconfig.json"), join(runtime, "tsconfig.json"));
  await cp(join(component, "dist", "src", "build-info.js"), join(runtime, "dist", "src", "build-info.js"));
  await cp(join(component, "dist", "src", "generated-build-metadata.js"), join(runtime, "dist", "src", "generated-build-metadata.js"));

  for (const entry of bundledEntries) {
    const source = await readFile(join(runtime, entry), "utf8");
    assert.doesNotMatch(source, /from ["'](?:@modelcontextprotocol\/sdk|zod)["']/u);
  }

  const scoreImport = await import(pathToFileURL(join(runtime, "dist", "src", "score-import.js")).href);
  const fixture = join(runtime, "one-note.mid");
  await writeFile(fixture, Buffer.from([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 12, 0, 0x90, 60, 100, 0x60, 0x80, 60, 0, 0, 0xff, 0x2f, 0,
  ]));
  const inspection = await scoreImport.inspectLocalScore(fixture);
  assert.equal(inspection.format, "midi");
  assert.equal(inspection.tracks[0].noteCount, 1);

  for (const entry of bundledEntries.slice(0, 2)) {
    await verifyMcpHandshake(join(runtime, entry), join(runtime, "ipc"));
  }

  const target = join(runtime, "SynthV Scripts");
  const environment = { SYNTHV_AGENT_BRIDGE_DIR: join(runtime, "ipc") };
  await runNode(join(runtime, "scripts", "install-synthv-bridge.mjs"), ["--target", target, "--no-reload"], environment);
  const doctor = await runNode(join(runtime, "scripts", "doctor.mjs"), ["--target", target, "--json"], environment);
  assert.equal(JSON.parse(doctor.stdout).ok, true, doctor.stderr);
} finally {
  await rm(runtime, { recursive: true, force: true });
}

console.log("Bridge runtime bundle contract passed.");

function runNode(entry, argumentsList, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...argumentsList], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${entry} failed with exit code ${code}: ${stdout}\n${stderr}`));
      }
    });
  });
}

function verifyMcpHandshake(entry, ipcDirectory) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, SYNTHV_AGENT_BRIDGE_DIR: ipcDirectory },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let stderr = "";
    let settled = false;
    let initialized = false;
    const timeout = setTimeout(() => finish(new Error(`${entry} did not complete the MCP handshake: ${stderr}`)), 5_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const lines = output.split("\n");
      output = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line);
        if (message.id === 1) {
          assert.equal(message.error, undefined, `initialize failed: ${JSON.stringify(message.error)}`);
          initialized = true;
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
        }
        if (message.id === 2) {
          assert.equal(message.error, undefined, `tools/list failed: ${JSON.stringify(message.error)}`);
          const tools = message.result?.tools;
          assert.ok(Array.isArray(tools) && tools.length > 0, "tools/list must expose Bridge tools");
          if (!entry.includes("legacy-sv1")) {
            assert.deepEqual(tools.map((tool) => tool.name), ["sv_status", "sv_describe", "sv_query", "sv_command", "sv_ui", "sv_review"]);
          }
          finish();
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", finish);
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`${entry} exited before the MCP handshake (code ${code}, signal ${signal}): ${stderr}`));
    });

    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "runtime-smoke", version: "1" } },
    })}\n`);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const closeTimeout = setTimeout(() => {
        child.kill("SIGKILL");
        complete();
      }, 1_000);
      child.once("close", () => {
        clearTimeout(closeTimeout);
        complete();
      });
      child.kill();
      function complete() {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      }
    }
  });
}
