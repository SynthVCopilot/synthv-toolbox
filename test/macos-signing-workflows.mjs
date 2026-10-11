import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (filename) => readFileSync(path.join(root, filename), "utf8").replace(/\r\n/g, "\n");
const yaml = createRequire(path.join(root, "src/PiDesktop.Tauri/node_modules/electron-updater/package.json"))("js-yaml");

const releaseText = read(".github/workflows/desktop.yml");
const publishText = read(".github/workflows/desktop-macos-publish.yml");
const nightlyText = read(".github/workflows/ffmpeg-verify.yml");
const builderText = read("electron-builder.yml");
const release = yaml.load(releaseText);
const publish = yaml.load(publishText);
const builder = yaml.load(builderText);

const stepsOf = (job) => job.steps.map((step, index) => ({ ...step, index }));
const runs = (step) => step.run ?? "";

// The center treats a repository as eligible while an active workflow on the default branch creates or uploads a release (center github.ts).
const CENTER_RELEASE_STEP = /^(?:(?:if|then|else|do|!)\s+)*(?:[A-Z_][A-Z0-9_]*=\S+\s+)*gh\s+release\s+(?:create|upload)\b/;
// The center matches the policy's required_job against the job name with this pattern (center policy.ts).
const REQUIRED_JOB = /^[\w-]{1,100}$/;

describe("Desktop Release workflow", () => {
  test("keeps the stable tag trigger and nothing else", () => {
    assert.deepEqual(release.on, { push: { tags: ["v*"] } });
    assert.deepEqual(release.permissions, {});
  });

  test("carries no code-signing secrets", () => {
    assert.doesNotMatch(releaseText, /CSC_(LINK|KEY_PASSWORD|NAME)|Validate code-signing environment/);
    assert.deepEqual(Object.keys(release.jobs).sort(), ["macos-source", "windows"]);
  });

  test("Windows is built unsigned and published by electron-builder", () => {
    const job = release.jobs.windows;
    assert.equal(job["runs-on"], "windows-latest");
    assert.deepEqual(job.permissions, { contents: "write" });
    const publishStep = stepsOf(job).find((step) => /electron-builder/.test(runs(step)));
    assert.match(runs(publishStep), /--win --publish always/);
    assert.equal(publishStep.env.GH_TOKEN, "${{ github.token }}");
  });

  test("macos-source is a single non-matrix job the center can match by name", () => {
    const job = release.jobs["macos-source"];
    assert.ok(job, "job id macos-source");
    assert.equal(job.name, "macos-source");
    assert.match(job.name, REQUIRED_JOB);
    assert.equal(job.strategy, undefined);
    assert.equal(job["runs-on"], "macos-14");
    assert.deepEqual(job.permissions, { contents: "read" });
  });

  test("macos-source builds unsigned, submits, and ends after the upload", () => {
    const steps = stepsOf(release.jobs["macos-source"]);
    const find = (pattern) => steps.find((step) => pattern.test(runs(step)) || pattern.test(step.uses ?? ""));
    const build = find(/npm run build:electron/);
    const pack = find(/electron-builder/);
    const bundle = find(/submit-macos\.mjs prepare/);
    const submit = find(/submit-macos\.mjs submit/);
    const upload = find(/upload-artifact/);
    assert.ok(build.index < pack.index && pack.index < bundle.index && bundle.index < submit.index && submit.index < upload.index);
    assert.match(runs(pack), /--mac/);
    assert.match(runs(pack), /--publish never/);
    assert.doesNotMatch(runs(pack), /--publish always/);
    assert.equal(pack.env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
    assert.equal(upload.with.name, "signing-request");
    assert.equal(steps.at(-1).index, upload.index, "the job stops once the request is handed over");
  });

  test("only the submit step receives the signing key and the center address", () => {
    const steps = stepsOf(release.jobs["macos-source"]);
    for (const step of steps) {
      const secrets = JSON.stringify(step.env ?? {});
      if (/submit-macos\.mjs submit/.test(runs(step))) {
        assert.match(secrets, /secrets\.SIGNING_API_KEY/);
        assert.match(secrets, /vars\.SIGNING_URL/);
      } else {
        assert.doesNotMatch(secrets, /secrets\./);
      }
    }
    assert.equal((releaseText.match(/secrets\./g) ?? []).length, 1);
  });

  test("the request carries the tag version and the exact commit", () => {
    const steps = stepsOf(release.jobs["macos-source"]);
    for (const step of steps.filter((entry) => /submit-macos\.mjs/.test(runs(entry)))) {
      assert.equal(step.env.INPUT_TAG, "${{ github.ref_name }}");
      assert.equal(step.env.INPUT_SOURCE_SHA, "${{ github.sha }}");
    }
  });

  test("reruns are refused", () => {
    const first = release.jobs["macos-source"].steps[0];
    assert.equal(first.if, "${{ github.run_attempt != 1 }}");
    assert.equal(first.run, "exit 1");
  });
});

describe("electron-builder macOS configuration", () => {
  test("the app is left unsigned for the center and ships as a dmg", () => {
    assert.equal(builder.mac.identity, null);
    assert.deepEqual(builder.mac.target, ["dmg"]);
    assert.equal(builder.mac.hardenedRuntime, true);
    assert.equal(builder.asar, true);
    assert.equal(builder.productName, "Synthesizer V Toolbox");
    assert.equal(builder.appId, "com.synthvcopilot.toolbox");
  });

  test("the template disk image has no license agreement the center cannot mount", () => {
    assert.equal(builder.dmg.license, undefined);
    assert.equal(builder.dmg.artifactName, "Synthesizer-V-Toolbox-${version}.${ext}");
  });

  test("windows signing is not configured", () => {
    assert.doesNotMatch(builderText, /CSC_|certificate/i);
  });
});

describe("Desktop macOS Publish workflow", () => {
  test("runs after a completed Desktop Release or by manual dispatch with a run id", () => {
    assert.deepEqual(publish.on.workflow_run, { workflows: ["Desktop Release"], types: ["completed"] });
    assert.equal(publish.on.workflow_dispatch.inputs.build_run_id.required, true);
    assert.deepEqual(publish.permissions, {});
  });

  test("starts only from a successful first-attempt tag push of this repository", () => {
    const condition = publish.jobs.resolve.if;
    for (const part of [
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.run_attempt == 1",
      ".github/workflows/desktop.yml",
      "github.event.workflow_run.repository.id == github.event.repository.id",
    ]) assert.ok(condition.includes(part), part);
    assert.match(condition, /workflow_dispatch' && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  });

  test("gives each job the least permission it needs and refuses reruns", () => {
    assert.deepEqual(publish.jobs.resolve.permissions, { actions: "read", contents: "read" });
    assert.deepEqual(publish.jobs["await-signing"].permissions, { contents: "read" });
    assert.deepEqual(publish.jobs.publish.permissions, { contents: "write" });
    for (const job of Object.values(publish.jobs)) {
      assert.equal(job.steps[0].if, "${{ github.run_attempt != 1 }}");
      assert.equal(job.steps[0].run, "exit 1");
    }
  });

  test("tools come from the default branch commit, without stored credentials", () => {
    for (const job of Object.values(publish.jobs)) {
      const checkout = job.steps.find((step) => /actions\/checkout/.test(step.uses ?? ""));
      assert.equal(checkout.with.ref, "${{ github.sha }}");
      assert.equal(checkout.with["persist-credentials"], false);
    }
  });

  test("the notarization wait runs on a Linux runner and the verification on macOS", () => {
    assert.equal(publish.jobs["await-signing"]["runs-on"], "ubuntu-latest");
    assert.equal(publish.jobs.publish["runs-on"], "macos-14");
    assert.deepEqual(publish.jobs.publish.needs, ["resolve", "await-signing"]);
    assert.ok(publish.jobs["await-signing"]["timeout-minutes"] >= 180);
  });

  test("uploads with --clobber and stays visible to the center's release discovery", () => {
    const upload = publishText.split("\n").map((line) => line.trim()).find((line) => CENTER_RELEASE_STEP.test(line));
    assert.match(upload, /gh release upload .*--clobber/);
    assert.doesNotMatch(publishText, /gh release create|gh release delete|--publish/);
  });

  test("only the wait and fetch steps receive the signing key", () => {
    const withKey = [];
    for (const [name, job] of Object.entries(publish.jobs)) {
      for (const step of job.steps) if (JSON.stringify(step.env ?? {}).includes("secrets.SIGNING_API_KEY")) withKey.push(`${name}:${/publish-macos\.mjs (\w+)/.exec(runs(step))[1]}`);
    }
    assert.deepEqual(withKey.sort(), ["await-signing:await", "publish:fetch"]);
    assert.equal((publishText.match(/secrets\./g) ?? []).length, 2);
  });

  test("hands over only public request data", () => {
    assert.doesNotMatch(releaseText + publishText, /CSC_(LINK|KEY_PASSWORD|NAME)|BEGIN [A-Z ]*PRIVATE KEY|\.p12|\.p8/i);
  });
});

describe("nightly builds", () => {
  test("keep their own release path and do not wait for the signing center", () => {
    assert.match(nightlyText, /gh release create "v\$NIGHTLY_VERSION"/);
    assert.doesNotMatch(nightlyText, /SIGNING_API_KEY|submit-macos|publish-macos/);
  });
});
