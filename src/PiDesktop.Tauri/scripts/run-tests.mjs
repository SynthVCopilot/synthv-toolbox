// Runs every *.test.mjs under the given directories, one process per file, and reports all failures.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, relative, resolve } from "node:path";
import process from "node:process";

const SKIPPED_DIRECTORIES = new Set(["_lib", "fixtures", "node_modules"]);
const FILE_TIMEOUT_MS = 10 * 60_000;

let concurrency = Math.min(2, availableParallelism());
const roots = [];
for (const argument of process.argv.slice(2)) {
  const option = /^--concurrency=(\d+)$/.exec(argument);
  if (option) concurrency = Math.max(1, Number(option[1]));
  else roots.push(resolve(argument));
}
if (roots.length === 0) {
  console.error("Usage: node scripts/run-tests.mjs [--concurrency=N] <directory>...");
  process.exit(2);
}

function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : discover(path);
    return entry.name.endsWith(".test.mjs") ? [path] : [];
  });
}

const files = roots.flatMap(discover).sort();
if (files.length === 0) {
  console.error("No *.test.mjs files found.");
  process.exit(2);
}

function runFile(file) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", file], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => { output += `\nTimed out after ${FILE_TIMEOUT_MS / 1000}s\n`; child.kill(); }, FILE_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      const tests = Number(/^ℹ tests (\d+)$/m.exec(output)?.[1] ?? 0);
      done({ file, ok: code === 0, output, tests, seconds: (Date.now() - started) / 1000 });
    });
  });
}

const results = [];
const queue = [...files];
await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, async () => {
  while (queue.length > 0) {
    const result = await runFile(queue.shift());
    results.push(result);
    console.log(`${result.ok ? "PASS" : "FAIL"} ${relative(process.cwd(), result.file)} (${result.seconds.toFixed(1)}s)`);
  }
}));

const failed = results.filter((result) => !result.ok);
for (const result of failed) console.log(`\n===== ${relative(process.cwd(), result.file)} =====\n${result.output.trimEnd()}`);
const tests = results.reduce((sum, result) => sum + result.tests, 0);
console.log(`\n${files.length - failed.length}/${files.length} files passed (${tests} node:test cases).`);
process.exit(failed.length > 0 ? 1 : 0);
