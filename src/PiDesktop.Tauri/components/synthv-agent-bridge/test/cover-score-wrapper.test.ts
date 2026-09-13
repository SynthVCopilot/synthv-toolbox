import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("Cover score wrapper reuses the maintained parser and supplies portable lyrics", async () => {
  const source = await readFile(
    path.join(root, "scripts", "cover-score-notes.mjs"),
    "utf8",
  );
  assert.match(source, /importScoreSnapshotMonophonic/u);
  assert.match(source, /defaultLyric: "la"/u);
  assert.doesNotMatch(source, /function parseMidi/u);
});
