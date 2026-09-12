import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "packages", "runtime-protocol");
const outputDirectory = join(root, "test", ".tmp", "runtime-protocol");
const tsc = join(root, "src", "PiDesktop.Tauri", "node_modules", "typescript", "bin", "tsc");

if (!existsSync(tsc)) throw new Error("TypeScript compiler is unavailable. Install frontend dependencies before running this test.");
rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
execFileSync(process.execPath, [tsc, "-p", join(packageRoot, "tsconfig.json"), "--outDir", outputDirectory], { stdio: "inherit" });
writeFileSync(join(outputDirectory, "package.json"), '{"type":"module"}\n');
const protocol = await import(`${pathToFileURL(join(outputDirectory, "index.js")).href}?contract=${Date.now()}`);

test("negotiates the highest protocol version in the shared range", () => {
  assert.equal(
    protocol.negotiateProtocolVersion({ min: "1.0", max: "1.3" }, { min: "1.2", max: "2.0" }),
    "1.3",
  );
  assert.equal(
    protocol.negotiateProtocolVersion({ min: "1.0", max: "1.1" }, { min: "1.2", max: "1.3" }),
    undefined,
  );
});

test("round trips a single JSONL request and rejects multiple lines", () => {
  const request = {
    kind: "request",
    id: "host-1",
    protocolVersion: "1.0",
    method: protocol.RUNTIME_HELLO_METHOD,
    params: { runtimeId: "pi", protocol: { min: "1.0", max: "1.0" } },
  };
  const line = protocol.encodeJsonl(request);
  assert.equal(line.endsWith("\n"), true);
  assert.deepEqual(protocol.parseJsonl(line.trimEnd()), request);
  assert.throws(() => protocol.parseJsonl(`${line}${line}`), /exactly one line/);
});

test("accepts a GUI-capable plugin manifest only when its contributions are safe", () => {
  const manifest = {
    schemaVersion: 1,
    id: "com.example.auto-tune",
    name: "Auto Tune",
    version: "1.2.3",
    hostApi: { min: "1.0", max: "1.1" },
    backend: { entry: "backend/index.js" },
    pages: [{ id: "workbench", title: "Tune Workbench", entry: "ui/index.html" }],
    actions: [{ id: "run", location: "project.toolbar", title: "Auto tune", whenCapability: "project.edit" }],
    permissions: ["agent.tools", "project.read", "project.write"],
  };
  const validated = protocol.validatePluginManifest(manifest);
  assert.deepEqual(validated, manifest);
  assert.equal(protocol.isHostApiCompatible(validated), true);
  assert.equal(protocol.validatePluginManifest({ ...manifest, pages: [{ ...manifest.pages[0], entry: "../ui/index.html" }] }), undefined);
  assert.equal(protocol.validatePluginManifest({ ...manifest, permissions: ["host.root"] }), undefined);
});
