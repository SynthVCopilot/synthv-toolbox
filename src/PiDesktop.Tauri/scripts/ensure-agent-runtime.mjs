import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const protocolDirectory = resolve(repositoryRoot, "packages/runtime-protocol");
const runtimeDirectory = resolve(repositoryRoot, "packages/agent-runtime");
const npmCli = process.env.npm_execpath ?? resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");

function npm(directory, args) {
  const result = spawnSync(process.execPath, [npmCli, "--prefix", directory, ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function installIfNeeded(directory, marker) {
  if (!existsSync(resolve(directory, marker))) {
    npm(directory, ["ci", "--include=dev", "--no-audit", "--no-fund"]);
  }
}

installIfNeeded(protocolDirectory, "node_modules/typescript/bin/tsc");
npm(protocolDirectory, ["run", "build"]);
installIfNeeded(runtimeDirectory, "node_modules/@earendil-works/pi-coding-agent/package.json");
npm(runtimeDirectory, ["run", "build"]);
