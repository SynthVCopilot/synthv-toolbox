import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicationPlan, mergeVersionsIndex, parseChangesTsv } from "../.github/scripts/nightly-release.mjs";

const sha = "0123456789abcdef0123456789abcdef01234567";
const common = {
  developmentVersion: "0.1.6-dev.0123456",
  sha,
  runId: 42,
  stableTag: "v0.1.5",
  sourceCommittedAtUtc: "2026-09-06T20:00:00+00:00",
  isAncestor: () => true,
};

assert.deepEqual(parseChangesTsv("First change\t0123456\nSecond change\tabcdef0\n"), [
  { title: "First change", commit: "0123456" },
  { title: "Second change", commit: "abcdef0" },
]);
assert.deepEqual(parseChangesTsv("Title\twith tab\t0123456\n"), [{ title: "Title\twith tab", commit: "0123456" }]);
assert.throws(() => parseChangesTsv("Broken\\t0123456\n"), /Invalid nightly change record/);
const fixtureDirectory = mkdtempSync(join(tmpdir(), "nightly-release-"));
const changesFixture = join(fixtureDirectory, "changes.tsv");
writeFileSync(changesFixture, "CLI title\t0123456\n");
assert.deepEqual(JSON.parse(execFileSync(process.execPath, [".github/scripts/nightly-release.mjs", "changes", changesFixture], { encoding: "utf8" })), [{ title: "CLI title", commit: "0123456" }]);

const initial = createPublicationPlan(common);
assert.throws(() => createPublicationPlan({ ...common, developmentVersion: "0.1.6-dev.abcdef0" }), /must identify/);
assert.equal(initial.publish, true);
assert.equal(initial.version, common.developmentVersion);
assert.equal(initial.commit, "0123456");
assert.equal(initial.range, `v0.1.5..${sha}`);
assert.equal(createPublicationPlan({ ...common, previous: { commit: sha, runId: 41 } }).reason, "current-commit-already-published");
assert.equal(createPublicationPlan({ ...common, previous: { commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd", runId: 99 } }).reason, "older-workflow-run");
assert.equal(createPublicationPlan({ ...common, previous: { commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd", runId: 41 }, isAncestor: () => false }).reason, "obsolete-or-divergent-commit");
assert.equal(createPublicationPlan({ ...common, previous: { commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd", runId: 41 } }).range, `abcdefabcdefabcdefabcdefabcdefabcdefabcd..${sha}`);

const firstBuild = { version: common.developmentVersion, commit: "0123456", sourceCommittedAtUtc: common.sourceCommittedAtUtc, publishedAtUtc: "2026-09-06T21:00:00Z", runId: 42, releaseUrl: "https://example.test/release", changes: [], assets: [{ name: "setup.exe", url: "https://example.test/setup.exe", sha256: "a".repeat(64), size: 123 }] };
const firstIndex = mergeVersionsIndex(undefined, firstBuild);
assert.deepEqual(firstIndex, { schemaVersion: 1, channel: "nightly", latest: "0123456", builds: [firstBuild] });
assert.equal(mergeVersionsIndex(firstIndex, firstBuild), firstIndex);
const nextBuild = { ...firstBuild, version: "0.1.7-dev.abcdef0", commit: "abcdef0", runId: 43 };
const nextIndex = mergeVersionsIndex(firstIndex, nextBuild);
assert.deepEqual(nextIndex.builds, [firstBuild, nextBuild]);
assert.equal(nextIndex.latest, "abcdef0");
assert.throws(() => mergeVersionsIndex(nextIndex, { ...nextBuild, runId: 41 }), /different details/);

console.log("Nightly release planner contracts passed.");
