import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const yaml = createRequire(path.join(root, "src/PiDesktop.Tauri/node_modules/electron-updater/package.json"))("js-yaml");
const load = (name) => yaml.load(readFileSync(path.join(root, ".github/workflows", name), "utf8"));
const workflows = Object.fromEntries(["ffmpeg-verify.yml", "prepare-desktop.yml", "desktop.yml", "desktop-windows.yml", "desktop-macos-publish.yml"].map((name) => [name, load(name)]));
const packageScripts = JSON.parse(readFileSync(path.join(root, "src/PiDesktop.Tauri/package.json"), "utf8")).scripts;

const development = workflows["ffmpeg-verify.yml"];
const { verify } = development.jobs;
const nightlyRelease = development.jobs["prepare-nightly-release"];
const nightlyPublish = development.jobs["publish-nightly"];
const runs = (step) => step.run ?? "";
const stepIndex = (job, pattern) => job.steps.findIndex((step) => pattern.test(runs(step)));
const writes = (permissions) => Object.values(permissions ?? {}).includes("write");
const PUSH_TO_MAIN = "github.event_name == 'push' && github.ref == 'refs/heads/main'";

describe("development build workflow", () => {
  test("verification runs for pull requests and main with read-only permissions and no credentials", () => {
    assert.ok("pull_request" in development.on && development.on.push.branches.includes("main"));
    assert.equal(writes(development.permissions), false);
    assert.equal(writes(verify.permissions), false);
    assert.equal(verify.if, undefined, "verification must not depend on the event");
    assert.doesNotMatch(JSON.stringify(verify), /github\.token|secrets\.|GH_TOKEN|--publish always|gh release/);
    for (const step of verify.steps.filter((entry) => /electron-builder/.test(runs(entry)))) assert.match(runs(step), /--publish never/);
  });

  test("verification tests the built application before packaging it", () => {
    const build = stepIndex(verify, /npm run build:electron/);
    const contract = stepIndex(verify, /npm run test:contract/);
    const flow = stepIndex(verify, /npm run test:flow/);
    const packaging = stepIndex(verify, /electron-builder/);
    assert.ok(build >= 0 && build < contract && contract < packaging && build < flow && flow < packaging);
  });

  test("nightly publishing runs only for pushes to main, after verification", () => {
    assert.equal(nightlyRelease.if, PUSH_TO_MAIN);
    assert.equal(nightlyPublish.if, PUSH_TO_MAIN);
    assert.equal(nightlyRelease.needs, "verify");
    assert.equal(nightlyPublish.needs, "prepare-nightly-release");
  });

  test("only the nightly jobs may write, and only the nightly publish job uploads release assets", () => {
    const writers = Object.entries(development.jobs).filter(([, job]) => writes(job.permissions)).map(([name]) => name).sort();
    assert.deepEqual(writers, ["prepare-nightly-release", "publish-nightly"]);
    const publishing = Object.entries(development.jobs).filter(([, job]) => job.steps.some((step) => /--publish always/.test(runs(step)))).map(([name]) => name);
    assert.deepEqual(publishing, ["publish-nightly"]);
    const publishStep = nightlyPublish.steps.find((step) => /--publish always/.test(runs(step)));
    assert.match(runs(publishStep), /--config\.publish\.channel=nightly/);
    assert.match(runs(publishStep), /--config\.publish\.releaseType=prerelease/);
  });

  test("the nightly publish job checks that the package and update metadata reached the release", () => {
    const validation = nightlyPublish.steps.find((step) => /Validate published nightly assets/.test(step.name ?? ""));
    assert.ok(validation, "a validation step follows publishing");
    assert.ok(nightlyPublish.steps.indexOf(validation) > nightlyPublish.steps.findIndex((step) => /--publish always/.test(runs(step))));
    assert.ok(nightlyPublish.strategy.matrix.include.every((entry) => entry.asset_suffix && entry.update_metadata));
  });
});

describe("workflow commands", () => {
  const steps = Object.entries(workflows).flatMap(([file, workflow]) => Object.values(workflow.jobs).flatMap((job) => (job.steps ?? []).map((step) => ({ file, run: runs(step) }))));

  test("every npm script a workflow runs exists", () => {
    for (const { file, run } of steps) {
      for (const [, script] of run.matchAll(/npm run ([\w:-]+)/g)) assert.ok(script in packageScripts, `${file} runs missing script ${script}`);
    }
  });

  test("every repository script a workflow runs exists", () => {
    for (const { file, run } of steps) {
      for (const [, script] of run.matchAll(/\bnode ((?:\.github|src|test|scripts)[\w./-]+\.mjs)/g)) assert.ok(existsSync(path.join(root, script)), `${file} runs missing file ${script}`);
    }
  });

  test("workflows do not use the retired Tauri toolchain", () => {
    for (const [file, workflow] of Object.entries(workflows)) assert.doesNotMatch(JSON.stringify(workflow), /cargo |tauri|rust-toolchain/, file);
  });
});
