#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const testDirectories = [path.resolve("dist", "tests"), path.resolve("dist", "test")];
const testFiles = (await Promise.all(testDirectories.map(async (testDirectory) =>
  readdir(testDirectory).catch(() => []).then((names) => names
    .filter((fileName) => fileName.endsWith(".test.js"))
    .sort()
    .map((fileName) => path.join(testDirectory, fileName)),
  ),
))).flat();

if (testFiles.length === 0) {
  console.error(`No compiled test files were found in ${testDirectories.join(", ")}`);
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ["--test", ...testFiles], {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}
