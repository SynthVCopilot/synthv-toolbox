import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// The Runtime, its build tooling, and CI must never branch on an MCP client
// brand. Brand names may appear as *data* — a discovered config file name, or
// prose in docs/ telling a user how to register the server — but never as a
// code path. This test locks in that boundary; docs/ and examples/ are
// deliberately out of scope.
const NEUTRAL_DIRECTORIES = ["src", "synthv", "scripts", ".github"];

const SCANNED_EXTENSIONS = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".lua",
  ".yml",
  ".yaml",
]);

// "cursor" is intentionally absent: it collides with the ordinary parsing term
// used throughout score-import.ts and the Lua bridge.
const CLIENT_BRANDS = [
  "codex",
  "claude",
  "cline",
  "windsurf",
  "copilot",
  "chatgpt",
  "anthropic",
  "openai",
  "gemini",
];

// Match a brand only at an identifier boundary so camelCase words that merely
// contain a brand substring (decodeXmlEntities, pageCursor) are not flagged.
const brandPattern = new RegExp(
  `(^|[^a-z])(${CLIENT_BRANDS.join("|")})([^a-z]|$)`,
  "iu",
);

async function collectFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      files.push(...(await collectFiles(entryPath)));
      continue;
    }
    if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files;
}

test("the Runtime and its tooling contain no MCP client brand coupling", async () => {
  // npm test runs from the repository root, matching doctor.test.ts.
  const repositoryRoot = process.cwd();

  const offenders: string[] = [];
  let scannedFiles = 0;

  for (const directory of NEUTRAL_DIRECTORIES) {
    for (const filePath of await collectFiles(
      path.join(repositoryRoot, directory),
    )) {
      scannedFiles += 1;
      const contents = await readFile(filePath, "utf8");
      contents.split(/\r?\n/u).forEach((line, index) => {
        if (brandPattern.test(line)) {
          const relativePath = path
            .relative(repositoryRoot, filePath)
            .split(path.sep)
            .join("/");
          offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`);
        }
      });
    }
  }

  assert.ok(scannedFiles > 0, "brand scan matched no files at all");
  assert.deepEqual(
    offenders,
    [],
    `client brand coupling found in neutral directories:\n${offenders.join("\n")}`,
  );
});
