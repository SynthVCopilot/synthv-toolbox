import { cp, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = resolve(desktopRoot, "../../packages/agent-runtime");
const temporaryRoot = resolve(tmpdir());
const entries = ["dist", "node_modules", "package.json"];

export function resourceStageParent(platform, desktopPath, temporaryPath) {
  const desktop = resolve(desktopPath);
  const temporary = resolve(temporaryPath);
  if (platform !== "win32" || parse(desktop).root.toLowerCase() === parse(temporary).root.toLowerCase()) return temporary;
  return parse(desktop).root;
}

const stageParent = resourceStageParent(process.platform, desktopRoot, temporaryRoot);

function isOwnedStage(path) {
  const relativeStage = relative(stageParent, resolve(path));
  return relativeStage && !relativeStage.startsWith("..") && !isAbsolute(relativeStage)
    && /^svtb-runtime-[a-zA-Z0-9]+$/.test(relativeStage);
}

async function assertExists(path) {
  try { await stat(path); } catch { throw new Error(`Agent Runtime build input is missing: ${path}`); }
}

export async function createResourceStage() {
  for (const entry of entries) await assertExists(join(runtimeRoot, entry));
  const stageRoot = await mkdtemp(join(stageParent, "svtb-runtime-"));
  try {
    for (const entry of entries) await cp(join(runtimeRoot, entry), join(stageRoot, entry), { recursive: true, dereference: true });
    const resources = {};
    for (const entry of entries) resources[`../../../packages/agent-runtime/${entry}`] = null;
    for (const entry of entries) resources[join(stageRoot, entry).replaceAll("\\", "/")] = entry === "dist" ? "agent-runtime" : `agent-runtime/${entry}`;
    const configPath = join(stageRoot, "tauri.resources.conf.json");
    await writeFile(configPath, `${JSON.stringify({ bundle: { resources } }, null, 2)}\n`);
    return { configPath, stageRoot, runtimeRoot, entries };
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupResourceStage(stageRoot) {
  if (!isOwnedStage(stageRoot)) throw new Error(`Refusing to remove resource stage outside the temporary directory: ${stageRoot}`);
  await rm(stageRoot, { recursive: true, force: true });
}
