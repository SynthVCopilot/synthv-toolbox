#!/usr/bin/env node
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const targetIndex = args.indexOf("--target");
const target = targetIndex >= 0 ? args[targetIndex + 1] : process.env.SYNTHV_SV1_SCRIPTS_DIR;
if (!target) {
  console.error("Usage: npm run install:sv1-legacy -- --target <SV1 scripts directory>");
  process.exitCode = 2;
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = path.join(root, "legacy-sv1", "synthv", "SynthVAgentBridgeSV1Legacy.lua");
  const destination = path.join(path.resolve(target), "SynthV Agent Bridge SV1 Legacy");
  const output = path.join(destination, "SynthVAgentBridgeSV1Legacy.lua");
  await mkdir(destination, { recursive: true });
  const staged = `${output}.${process.pid}.tmp`;
  await cp(source, staged);
  const expected = await readFile(source, "utf8");
  if ((await readFile(staged, "utf8")) !== expected) throw new Error("Staged SV1 legacy executor verification failed.");
  await rename(staged, output).catch(async () => { await rm(output, { force: true }); await rename(staged, output); });
  await writeFile(path.join(destination, "INSTALLATION.txt"), "Run Scripts > Rescan in Synthesizer V Studio Pro 1.11.2, then start SynthV Agent Bridge SV1 Legacy.\n", "utf8");
  console.log(`Installed SV1 legacy Bridge at ${output}`);
}
