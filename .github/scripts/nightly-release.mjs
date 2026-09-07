import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function requireValue(value, message) {
  if (!value) throw new Error(message);
  return value;
}

export function parseChangesTsv(input) {
  return input
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.lastIndexOf("\t");
      const title = line.slice(0, separator);
      const commit = line.slice(separator + 1);
      if (separator < 1 || !/^[0-9a-f]{7}$/i.test(commit)) {
        throw new Error(`Invalid nightly change record: ${line}`);
      }
      return { title, commit: commit.toLowerCase() };
    });
}

export function createPublicationPlan({ developmentVersion, sha, runId, previous, stableTag, sourceCommittedAtUtc, isAncestor }) {
  const version = requireValue(developmentVersion, "Development version is required");
  const versionMatch = /^(\d+\.\d+\.\d+)-dev\.([0-9a-f]{7})$/i.exec(version);
  if (!versionMatch) throw new Error(`Unexpected development version: ${version}`);
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`Expected a full commit SHA: ${sha}`);
  if (versionMatch[2].toLowerCase() !== sha.slice(0, 7).toLowerCase()) {
    throw new Error("Development version must identify the published source commit");
  }
  if (!/^\d+$/.test(String(runId))) throw new Error(`Expected a numeric workflow run id: ${runId}`);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(sourceCommittedAtUtc ?? "")) {
    throw new Error("Expected an RFC3339 source commit timestamp");
  }

  const result = {
    publish: true,
    baseVersion: versionMatch[1],
    tag: `v${versionMatch[1]}-nightly`,
    version,
    commit: sha.slice(0, 7).toLowerCase(),
    sourceCommittedAtUtc,
    range: stableTag ? `${stableTag}..${sha}` : sha,
  };
  if (!previous?.commit) return result;
  if (previous.commit === sha) return { publish: false, reason: "current-commit-already-published" };
  if (Number(runId) <= Number(previous.runId ?? 0)) return { publish: false, reason: "older-workflow-run" };
  if (!isAncestor(previous.commit, sha)) return { publish: false, reason: "obsolete-or-divergent-commit" };
  return { ...result, range: `${previous.commit}..${sha}` };
}

export function parseVersionsIndex(value) {
  if (value?.schemaVersion !== 1 || value?.channel !== "nightly" || !Array.isArray(value.builds)) {
    throw new Error("Invalid nightly versions index");
  }
  const commits = new Set();
  for (const build of value.builds) {
    if (!/^[0-9a-f]{7}$/i.test(build?.commit ?? "") || commits.has(build.commit.toLowerCase())) {
      throw new Error("Nightly versions index must contain unique short commit hashes");
    }
    commits.add(build.commit.toLowerCase());
  }
  if (!commits.has(value.latest?.toLowerCase())) {
    throw new Error("Nightly versions index latest must identify a build");
  }
  return value;
}

export function mergeVersionsIndex(index, build) {
  const current = index ? parseVersionsIndex(index) : { schemaVersion: 1, channel: "nightly", latest: "", builds: [] };
  if (!/^[0-9a-f]{7}$/i.test(build?.commit ?? "")) throw new Error("Nightly build must have a short commit hash");
  const existing = current.builds.find((entry) => entry.commit.toLowerCase() === build.commit.toLowerCase());
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(build)) throw new Error("Nightly build commit already exists with different details");
    return current;
  }
  return { schemaVersion: 1, channel: "nightly", latest: build.commit.toLowerCase(), builds: [...current.builds, build] };
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function latestStableTag(sha) {
  const tags = git("tag", "--merged", sha, "-l", "v[0-9]*", "--sort=-version:refname").split("\n");
  return tags.find((tag) => /^v\d+\.\d+\.\d+$/.test(tag)) ?? "";
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "changes") {
    const filename = requireValue(args[0], "Changes TSV path is required");
    process.stdout.write(`${JSON.stringify(parseChangesTsv(readFileSync(filename, "utf8")))}\n`);
    return;
  }
  if (command === "merge") {
    const [indexPath, buildPath] = args;
    const index = indexPath && existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : undefined;
    process.stdout.write(`${JSON.stringify(mergeVersionsIndex(index, JSON.parse(readFileSync(buildPath, "utf8"))))}\n`);
    return;
  }
  if (command !== "plan") throw new Error("Usage: nightly-release.mjs plan <version> <sha> <run-id> <versions-json>");
  const [developmentVersion, sha, runId, versionsPath] = args;
  let previous;
  if (versionsPath && existsSync(versionsPath)) {
    const index = parseVersionsIndex(JSON.parse(readFileSync(versionsPath, "utf8")));
    const latest = index.builds.find((entry) => entry.commit.toLowerCase() === index.latest.toLowerCase());
    previous = { commit: git("rev-parse", `${latest.commit}^{commit}`), runId: latest.runId };
  }
  const plan = createPublicationPlan({
    developmentVersion,
    sha,
    runId,
    previous,
    stableTag: latestStableTag(sha),
    sourceCommittedAtUtc: git("show", "-s", "--format=%cI", sha),
    isAncestor: (ancestor, descendant) => {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
  });
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
