import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const componentDirectory = resolve(scriptDirectory, "../src-tauri/components/synthv-agent-bridge");
const bridgeEntries = [
  resolve(componentDirectory, "dist/src/cli.js"),
  resolve(componentDirectory, "dist/legacy-sv1/src/cli.js"),
];
const buildDependencies = [
  resolve(componentDirectory, "node_modules/typescript/bin/tsc"),
  resolve(componentDirectory, "node_modules/@types/node/package.json"),
];
const npmCli = process.env.npm_execpath ?? resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");

function run(args) {
  const result = spawnSync(process.execPath, [npmCli, "--prefix", componentDirectory, ...args], {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (process.env.CI === "true" && bridgeEntries.every((entry) => existsSync(entry))) {
  process.exit(0);
}

if (!buildDependencies.every((entry) => existsSync(entry))) {
  run(["ci", "--include=dev", "--no-audit", "--no-fund"]);
}
run(["run", "build"]);
