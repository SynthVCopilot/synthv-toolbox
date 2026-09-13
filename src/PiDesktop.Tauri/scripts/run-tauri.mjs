import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { run as runTauri } from "@tauri-apps/cli";
import { cleanupResourceStage, createResourceStage } from "./stage-agent-runtime.mjs";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(desktopRoot);
const args = process.argv.slice(2);
const [subcommand, ...arguments_] = args;

function buildRuntime() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(desktopRoot, "scripts", "ensure-agent-runtime.mjs")], { cwd: desktopRoot, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

if (!["build", "bundle"].includes(subcommand) || arguments_.some((argument) => ["--help", "-h", "--version", "-V"].includes(argument))) {
  await runTauri(args, "tauri");
  process.exit(0);
}

const buildExitCode = await buildRuntime();
if (buildExitCode !== 0) process.exit(buildExitCode);
const resourceStage = await createResourceStage();
try {
  await runTauri([subcommand, ...arguments_, "--config", resourceStage.configPath], "tauri");
} finally {
  await cleanupResourceStage(resourceStage.stageRoot);
}
