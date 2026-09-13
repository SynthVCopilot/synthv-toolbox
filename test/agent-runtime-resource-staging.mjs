import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { cleanupResourceStage, createResourceStage } from "../src/PiDesktop.Tauri/scripts/stage-agent-runtime.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, "src", "PiDesktop.Tauri");
const config = JSON.parse(readFileSync(join(desktop, "src-tauri", "tauri.conf.json"), "utf8"));
const source = "../../../packages/agent-runtime/node_modules";
assert.equal(config.bundle.resources[source], "agent-runtime/node_modules");
for (const path of ["../../../packages/agent-runtime/dist", source, "../../../packages/agent-runtime/package.json"]) {
  assert.ok(config.bundle.resources[path].startsWith("agent-runtime"));
}

const tauriRunner = readFileSync(join(desktop, "scripts", "run-tauri.mjs"), "utf8");
assert.match(tauriRunner, /\["build", "bundle"\]/);
assert.match(tauriRunner, /\.\.\.arguments_, "--config", resourceStage\.configPath/);
assert.match(tauriRunner, /finally/);
assert.match(tauriRunner, /import \{ run as runTauri \} from "@tauri-apps\/cli"/);
assert.match(tauriRunner, /arguments_\.some/);
const plan = await createResourceStage();
try {
assert.ok(existsSync(join(plan.runtimeRoot, "node_modules")));
assert.ok(existsSync(join(plan.stageRoot, "node_modules")));
const stagedConfig = JSON.parse(readFileSync(plan.configPath, "utf8"));
const stagedSource = resolve(plan.stageRoot, "node_modules").replaceAll("\\", "/");
assert.equal(stagedConfig.bundle.resources[stagedSource], "agent-runtime/node_modules");
assert.ok(Object.keys(stagedConfig.bundle.resources).some((path) => path === stagedSource));
for (const entry of ["dist", "node_modules", "package.json"]) {
  assert.equal(stagedConfig.bundle.resources[`../../../packages/agent-runtime/${entry}`], null);
}

const mergedResources = { ...config.bundle.resources };
for (const [resource, destination] of Object.entries(stagedConfig.bundle.resources)) {
  if (destination === null) delete mergedResources[resource];
  else mergedResources[resource] = destination;
}
for (const entry of ["dist", "node_modules", "package.json"]) {
  assert.equal(mergedResources[`../../../packages/agent-runtime/${entry}`], undefined);
}
assert.equal(mergedResources[stagedSource], "agent-runtime/node_modules");

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const longest = files(join(plan.stageRoot, "node_modules")).sort((a, b) => b.length - a.length)[0];
assert.ok(longest.length < 260, `staged source path is too long: ${longest.length}`);
assert.match(plan.stageRoot, /svtb-runtime-[a-zA-Z0-9]+$/);

const makensis = "C:/Users/User/AppData/Local/tauri/NSIS/makensis.exe";
if (process.platform === "win32" && existsSync(makensis)) {
  const temporary = mkdtempSync(join(tmpdir(), "tauri-resource-nsis-"));
  try {
    const script = join(temporary, "resource.nsi");
    writeFileSync(script, `OutFile "${join(temporary, "resource.exe").replaceAll("\\", "\\\\")}"\nSection\nFile /oname=runtime-resource "${longest.replaceAll("\\", "\\\\")}"\nSectionEnd\n`);
    execFileSync(makensis, [script], { stdio: "inherit" });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
} finally {
  await cleanupResourceStage(plan.stageRoot);
}
assert.ok(!existsSync(plan.stageRoot));

console.log("Agent Runtime resource staging contracts passed.");
