import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (filename) => readFileSync(path.join(root, filename), "utf8").replace(/\r\n/g, "\n");
const yaml = createRequire(path.join(root, "src/PiDesktop.Tauri/node_modules/electron-updater/package.json"))("js-yaml");

const releaseText = read(".github/workflows/desktop.yml");
const publishText = read(".github/workflows/desktop-macos-publish.yml");
const windowsText = read(".github/workflows/desktop-windows.yml");
const nightlyText = read(".github/workflows/ffmpeg-verify.yml");
const builderText = read("electron-builder.yml");
const release = yaml.load(releaseText);
const publish = yaml.load(publishText);
const windows = yaml.load(windowsText);
const builder = yaml.load(builderText);

const stepsOf = (job) => job.steps.map((step, index) => ({ ...step, index }));
const runs = (step) => step.run ?? "";

// The center treats a repository as eligible while an active workflow on the default branch creates or uploads a release (center github.ts).
const CENTER_RELEASE_STEP = /^(?:(?:if|then|else|do|!)\s+)*(?:[A-Z_][A-Z0-9_]*=\S+\s+)*gh\s+release\s+(?:create|upload)\b/;
// The center matches the policy's required_job against the job name with this pattern (center policy.ts).
const REQUIRED_JOB = /^[\w-]{1,100}$/;

const BUNDLE_DIR = "${{ runner.temp }}/toolbox-sign-${{ github.run_id }}-bundle";

describe("Desktop Release workflow", () => {
  const build = release.jobs["macos-build"];
  const source = release.jobs["macos-source"];

  test("keeps the stable tag trigger and nothing else", () => {
    assert.deepEqual(release.on, { push: { tags: ["v*"] } });
    assert.deepEqual(release.permissions, {});
  });

  test("holds only the macOS jobs so a Windows failure or rerun cannot void the signing request", () => {
    assert.deepEqual(Object.keys(release.jobs).sort(), ["macos-build", "macos-source"]);
    assert.doesNotMatch(releaseText, /windows|--win\b/i);
    assert.doesNotMatch(releaseText, /CSC_(LINK|KEY_PASSWORD|NAME)|Validate code-signing environment/);
  });

  test("macos-source is a single non-matrix job the center can match by name", () => {
    assert.ok(source, "job id macos-source");
    assert.equal(source.name, "macos-source");
    assert.match(source.name, REQUIRED_JOB);
    assert.equal(source.strategy, undefined);
    assert.deepEqual(source.permissions, { actions: "read", contents: "read", "id-token": "write" });
    assert.deepEqual(source.needs, "macos-build");
  });

  test("the signing key and run identity never meet build scripts", () => {
    assert.equal(source.permissions["id-token"], "write");
    assert.equal(build.permissions["id-token"], undefined);
    assert.equal(build.environment, undefined);
    assert.doesNotMatch(JSON.stringify(build), /secrets\./);
    assert.equal((releaseText.match(/secrets\./g) ?? []).length, 1);
    const runsText = stepsOf(source).map(runs).join("\n");
    assert.doesNotMatch(runsText, /npm |electron-builder|pnpm|yarn/);
  });

  test("macos-build builds unsigned and hands over the source bundle", () => {
    assert.equal(build["runs-on"], "macos-14");
    assert.deepEqual(build.permissions, { contents: "read" });
    const steps = stepsOf(build);
    const find = (pattern) => steps.find((step) => pattern.test(runs(step)) || pattern.test(step.uses ?? ""));
    const validate = find(/docs\/releases/);
    const install = find(/npm ci/);
    const compile = find(/npm run build:electron/);
    const pack = find(/electron-builder/);
    const bundle = find(/submit-macos\.mjs prepare/);
    const upload = find(/upload-artifact/);
    assert.ok(validate.index < install.index && install.index < compile.index && compile.index < pack.index && pack.index < bundle.index && bundle.index < upload.index);
    assert.match(runs(pack), /--mac/);
    assert.match(runs(pack), /--publish never/);
    assert.doesNotMatch(runs(pack), /--publish always/);
    assert.equal(pack.env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
    assert.equal(upload.with.name, "signing-source");
    assert.equal(upload.with.path, "${{ steps.bundle.outputs.work_dir }}/source.zip");
    assert.equal(upload.id, "upload");
    assert.equal(build.outputs.source_artifact_id, "${{ steps.upload.outputs.artifact-id }}");
    assert.equal(steps.at(-1).index, upload.index);
    assert.equal(build.steps.find((step) => /actions\/checkout/.test(step.uses ?? "")).with["persist-credentials"], false);
  });

  test("macos-source submits the uploaded artifact ID and hands over request context", () => {
    const steps = stepsOf(source);
    const submit = steps.find((step) => /submit-macos\.mjs submit/.test(runs(step)));
    const upload = steps.find((step) => /upload-artifact/.test(step.uses ?? ""));
    assert.ok(submit.index < upload.index);
    assert.equal(submit.env.INPUT_ARTIFACT_ID, "${{ needs.macos-build.outputs.source_artifact_id }}");
    assert.equal(submit.env.GITEDGE_SIGNING_PROFILE, "${{ vars.GITEDGE_SIGNING_PROFILE }}");
    assert.equal(submit.env.GITHUB_TOKEN, "${{ github.token }}");
    assert.equal(upload.with.name, "signing-request");
    assert.equal(steps.at(-1).index, upload.index, "the job stops once the request is handed over");
  });

  test("only the submit step receives the signing key and no center address comes from repository variables", () => {
    for (const step of stepsOf(source)) {
      const secrets = JSON.stringify(step.env ?? {});
      if (/submit-macos\.mjs submit/.test(runs(step))) assert.match(secrets, /secrets\.GITEDGE_SIGNING_TOKEN/);
      else assert.doesNotMatch(secrets, /secrets\./);
    }
    assert.doesNotMatch(releaseText + publishText + windowsText, /SIGNING_API_KEY|SIGNING_URL|sign\.voidcarve\.com/);
    assert.match(releaseText, /vars\.GITEDGE_SIGNING_PROFILE/);
  });

  test("the request carries the tag version and the exact commit", () => {
    const steps = [...stepsOf(build), ...stepsOf(source)];
    for (const step of steps.filter((entry) => /submit-macos\.mjs/.test(runs(entry)))) {
      assert.equal(step.env.INPUT_TAG, "${{ github.ref_name }}");
      assert.equal(step.env.INPUT_SOURCE_SHA, "${{ github.sha }}");
    }
  });

  test("the release tag must match the package version and have release notes before anything is built", () => {
    for (const job of [build, windows.jobs.draft]) {
      const validate = job.steps.find((step) => /docs\/releases/.test(runs(step)));
      assert.match(runs(validate), /test -s "docs\/releases\/\$\{RELEASE_TAG\}\.md"/);
      assert.match(runs(validate), /package\.json'\)\.version"\)" = "\$RELEASE_TAG"/);
    }
  });

  test("reruns are refused", () => {
    for (const job of [build, source]) {
      assert.equal(job.steps[0].if, "${{ github.run_attempt != 1 }}");
      assert.equal(job.steps[0].run, "exit 1");
    }
  });
});

describe("Desktop Windows Release workflow", () => {
  test("is its own tag workflow, so macOS signing does not depend on it", () => {
    assert.deepEqual(windows.on, { push: { tags: ["v*"] } });
    assert.deepEqual(windows.permissions, {});
    assert.deepEqual(Object.keys(windows.jobs), ["draft", "windows", "publish"]);
    assert.doesNotMatch(windowsText, /secrets\.|workflow_run|needs: macos/);
  });

  test("builds unsigned and publishes with electron-builder into the draft release", () => {
    const job = windows.jobs.windows;
    assert.equal(job["runs-on"], "windows-latest");
    assert.equal(job.needs, "draft");
    assert.deepEqual(job.permissions, { contents: "write" });
    const publishStep = stepsOf(job).find((step) => /electron-builder/.test(runs(step)));
    assert.match(runs(publishStep), /--win --publish always/);
    assert.equal(publishStep.env.GH_TOKEN, "${{ github.token }}");
  });

  test("no checkout keeps the write token, and only release steps receive it", () => {
    for (const job of Object.values(windows.jobs)) {
      const checkout = job.steps.find((step) => /actions\/checkout/.test(step.uses ?? ""));
      assert.equal(checkout.with["persist-credentials"], false);
      for (const step of job.steps) {
        const needsToken = /release-draft\.mjs|electron-builder/.test(runs(step));
        assert.equal(JSON.stringify(step.env ?? {}).includes("github.token"), needsToken, `${job.name}: ${step.name ?? step.uses}`);
      }
    }
  });

  test("the release stays a draft until both platforms uploaded and then a clean job publishes it", () => {
    assert.equal(builder.publish.releaseType, "draft");
    const draft = stepsOf(windows.jobs.draft).map(runs).join("\n");
    const publish = stepsOf(windows.jobs.publish).map(runs).join("\n");
    assert.match(draft, /release-draft\.mjs ensure/);
    assert.match(publish, /release-draft\.mjs promote/);
    assert.equal(windows.jobs.publish.needs, "windows");
    assert.doesNotMatch(publish, /npm /);
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
      for (const step of job.steps) if (JSON.stringify(step.env ?? {}).includes("secrets.GITEDGE_SIGNING_TOKEN")) withKey.push(`${name}:${/publish-macos\.mjs (\w+)/.exec(runs(step))[1]}`);
    }
    assert.deepEqual(withKey.sort(), ["await-signing:await", "publish:fetch"]);
    assert.equal((publishText.match(/secrets\./g) ?? []).length, 2);
  });

  test("the draft exists before the upload and is published only after the upload is verified", () => {
    const steps = stepsOf(publish.jobs.publish);
    const ensure = steps.find((step) => /release-draft\.mjs ensure/.test(runs(step)));
    const upload = steps.find((step) => /gh release upload/.test(runs(step)));
    const promote = steps.find((step) => /release-draft\.mjs promote/.test(runs(step)));
    assert.ok(ensure.index < upload.index && upload.index < promote.index);
    assert.match(runs(upload), /Release asset was not published/);
    assert.equal(promote.env.INPUT_TAG, "${{ needs.resolve.outputs.tag }}");
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

// The center flips the RunAsNode fuse off for every Electron profile, so a signed app cannot be spawned as a plain Node.
describe("signed Electron app", () => {
  const shipped = [];
  const scan = (target) => {
    if (statSync(target).isFile()) {
      if (/\.(ts|mjs|cjs|js)$/.test(target)) shipped.push(target);
      return;
    }
    for (const entry of readdirSync(target)) if (entry !== "node_modules" && entry !== ".git") scan(path.join(target, entry));
  };

  test("no shipped code relies on ELECTRON_RUN_AS_NODE", () => {
    scan(path.join(root, "src/PiDesktop.Tauri/electron"));
    for (const resource of builder.extraResources) {
      if (typeof resource === "object" && resource.from.startsWith("src/")) scan(path.join(root, resource.from));
    }
    assert.ok(shipped.length > 20, "the scan covers the main process and the bundled components");
    assert.deepEqual(shipped.filter((file) => /RUN_AS_NODE/.test(readFileSync(file, "utf8"))).map((file) => path.relative(root, file)), []);
  });
});
