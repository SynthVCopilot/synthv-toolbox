import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, ".github", "scripts");
const { main, prepare, submitSource, assertTemplateLayout, runIdentity, writeContext } = await import(pathToFileURL(path.join(scripts, "submit-macos.mjs")).href);

const BUNDLE_ID = "com.synthvcopilot.toolbox";
const APP = "Synthesizer V Toolbox.app";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const REQUEST_ID = "6f1d0c2e-3b4a-4c5d-8e9f-a0b1c2d3e4f5";
const posix = process.platform !== "win32";
const temps = [];
after(async () => { await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true }))); });
const temp = async (prefix) => { const dir = await mkdtemp(path.join(tmpdir(), prefix)); temps.push(dir); return dir; };
const sha256 = (buffer) => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
const noSleep = async () => {};

async function submitFixture() {
  const runnerTemp = await temp("toolbox-submit-");
  return { runnerTemp };
}

const PROFILE = "synthv-macos-arm64";
const GITEDGE_REPOSITORY = "13814fa3-8580-4b5a-803e-a6b1206007ed";
const PROFILE_REVISION = "b".repeat(40);
const ARTIFACT_ID = "73";
const ARTIFACT_DIGEST = `sha256:${"c".repeat(64)}`;
const ARTIFACT_SIZE = 1024;

async function gitHubFetch(url, options) {
  const target = new URL(url);
  if (target.hostname === "oidc.actions.githubusercontent.com") return Response.json({ value: "test-run-identity" });
  if (target.hostname === "api.github.com" && target.pathname.endsWith("/actions/runs/42")) return Response.json({
    id: 42, path: ".github/workflows/desktop.yml@refs/tags/v1.2.3", event: "push", status: "in_progress",
    run_attempt: 1, head_branch: "v1.2.3", head_sha: SHA,
  });
  if (target.hostname === "api.github.com" && target.pathname.endsWith(`/actions/artifacts/${ARTIFACT_ID}`)) return Response.json({
    id: Number(ARTIFACT_ID), name: "signing-source", expired: false, digest: ARTIFACT_DIGEST,
    size_in_bytes: ARTIFACT_SIZE, workflow_run: { id: 42, repository_id: 1319908050, head_sha: SHA },
  });
  return fetch(url, options);
}

const submitEnv = (fixture, extra = {}) => ({
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.githubusercontent.com/token?existing=1",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-credential",
  GITEDGE_SIGNING_TOKEN: "test-token",
  GITEDGE_SIGNING_PROFILE: PROFILE,
  GITHUB_TOKEN: "github-token",
  GITHUB_REPOSITORY: "SynthVCopilot/synthv-toolbox",
  GITHUB_REPOSITORY_ID: "1319908050",
  GITHUB_REF: "refs/tags/v1.2.3",
  GITHUB_EVENT_NAME: "push",
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "1",
  INPUT_ARTIFACT_ID: ARTIFACT_ID,
  INPUT_TAG: "v1.2.3",
  INPUT_SOURCE_SHA: SHA,
  RUNNER_TEMP: fixture.runnerTemp,
  ...extra,
});

function signingRequest(overrides = {}) {
  return {
    id: REQUEST_ID, repositoryId: GITEDGE_REPOSITORY, profile: PROFILE, profileRevision: PROFILE_REVISION,
    platform: "macos", sourceDigest: ARTIFACT_DIGEST, sourceSize: ARTIFACT_SIZE, state: "queued", ...overrides,
  };
}

function mockGitedge(log, { failures = [], request = signingRequest() } = {}) {
  const pending = [...failures];
  return async (url, options) => {
    const target = new URL(url);
    if (target.hostname !== "gitedge.voidcarve.com") return gitHubFetch(url, options);
    log.push({ url: String(url), options, body: options.body });
    assert.equal(target.pathname, "/api/actions/signing/requests");
    assert.equal(target.searchParams.get("repositoryId"), GITEDGE_REPOSITORY);
    assert.equal(options.headers.authorization, "Bearer test-token");
    assert.equal(options.headers["x-run-identity"], "test-run-identity");
    const failure = pending.shift();
    if (failure) return new Response("temporary failure", { status: failure });
    return Response.json({ data: { request } }, { status: 202 });
  };
}

describe("GitHub Actions run identity", () => {
  test("requests an OIDC token for GitEdge and preserves the runner URL query", async () => {
    const calls = [];
    const fixture = await submitFixture();
    const env = submitEnv(fixture);
    const fetchImpl = async (url, options) => {
      calls.push([String(url), options]);
      return Response.json({ value: `token-${calls.length}` });
    };
    assert.equal(await runIdentity(env, fetchImpl, "https://gitedge.voidcarve.com"), "token-1");
    assert.equal(new URL(calls[0][0]).searchParams.get("existing"), "1");
    assert.equal(new URL(calls[0][0]).searchParams.get("audience"), "https://gitedge.voidcarve.com");
    assert.equal(calls[0][1].headers.authorization, "Bearer oidc-request-credential");
    assert.equal(calls[0][1].redirect, "error");
  });

  test("fails closed when run identity is unavailable or invalid", async () => {
    const fixture = await submitFixture();
    const env = submitEnv(fixture);
    await assert.rejects(runIdentity({ ...env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }, fetch, "https://gitedge.voidcarve.com"), { code: "RUN_IDENTITY_UNAVAILABLE" });
    for (const value of ["", 42, "x".repeat(4097)]) {
      await assert.rejects(runIdentity(env, async () => Response.json({ value }), "https://gitedge.voidcarve.com"), { code: "RUN_IDENTITY_FAILED" });
    }
  });
});

describe("native GitEdge source artifact submission", () => {
  test("binds the request to the exact GitHub run, uploaded artifact, profile and OIDC identity", async () => {
    const fixture = await submitFixture();
    const calls = [];
    const result = await submitSource({ env: submitEnv(fixture), fetchImpl: mockGitedge(calls), sleep: noSleep });
    assert.equal(calls.length, 1);
    const request = JSON.parse(calls[0].body);
    assert.deepEqual(request, {
      profile: PROFILE, platform: "macos", sourceRepositoryId: "1319908050", sourceCommitOid: SHA,
      sourceRunId: "42", sourceArtifactId: ARTIFACT_ID, sourceDigest: ARTIFACT_DIGEST,
      sourceSize: ARTIFACT_SIZE, version: "1.2.3",
    });
    assert.equal(calls[0].options.headers["idempotency-key"], "synthv-42-1");
    assert.equal(result.request_id, REQUEST_ID);
    assert.equal(result.source_digest, ARTIFACT_DIGEST);
    assert.equal(result.source_size, ARTIFACT_SIZE);
  });

  test("retries transient request failures with identical payload and idempotency key", async () => {
    const fixture = await submitFixture();
    const calls = [];
    const waits = [];
    await submitSource({ env: submitEnv(fixture), fetchImpl: mockGitedge(calls, { failures: [503] }), sleep: async ms => waits.push(ms) });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body, calls[1].body);
    assert.equal(calls[0].options.headers["idempotency-key"], calls[1].options.headers["idempotency-key"]);
    assert.deepEqual(waits, [2000]);
  });

  test("does not retry authorization errors or mismatched run and artifact metadata", async () => {
    const fixture = await submitFixture();
    const calls = [];
    await assert.rejects(submitSource({ env: submitEnv(fixture), fetchImpl: mockGitedge(calls, { failures: [403] }), sleep: noSleep }), { code: "GITEDGE_SIGNING_HTTP_403" });
    assert.equal(calls.length, 1);
    for (const extra of [{ GITHUB_REF: "refs/tags/v9.9.9" }, { GITHUB_RUN_ATTEMPT: "2" }, { GITEDGE_SIGNING_PROFILE: "other" }]) {
      await assert.rejects(submitSource({ env: submitEnv(fixture, extra), fetchImpl: gitHubFetch, sleep: noSleep }));
    }
  });

  test("writes only the native request binding into the public handoff file", async () => {
    const fixture = await submitFixture();
    const result = await submitSource({ env: submitEnv(fixture), fetchImpl: mockGitedge([]), sleep: noSleep });
    const dir = await writeContext(result, { env: submitEnv(fixture) });
    const context = JSON.parse(await readFile(path.join(dir, "request.json"), "utf8"));
    assert.deepEqual(context, {
      schema_version: 1, build_run_id: 42, repository_id: GITEDGE_REPOSITORY, request_id: REQUEST_ID,
      profile: PROFILE, profile_revision: PROFILE_REVISION, source_run_id: "42", source_artifact_id: ARTIFACT_ID,
      source_digest: ARTIFACT_DIGEST, source_size: ARTIFACT_SIZE, version: "1.2.3", source_sha: SHA,
    });
    assert.doesNotMatch(JSON.stringify(context), /test-token|oidc-request-credential/);
  });
});
// The center accepts only the app, an Applications link to /Applications and the dmg decoration files.
describe("template disk image layout", { skip: !posix }, () => {
  const layout = async (build) => {
    const dir = await temp("toolbox-layout-");
    await mkdir(path.join(dir, APP));
    await build(dir);
    return dir;
  };

  test("accepts the standard electron-builder volume", async () => {
    const dir = await layout(async (mounted) => {
      await symlink("/Applications", path.join(mounted, "Applications"));
      await mkdir(path.join(mounted, ".background"));
      await writeFile(path.join(mounted, ".DS_Store"), "");
      await writeFile(path.join(mounted, ".VolumeIcon.icns"), "");
    });
    await assertTemplateLayout(dir);
  });

  test("rejects an Applications link to any other target", async () => {
    const dir = await layout((mounted) => symlink("/tmp", path.join(mounted, "Applications")));
    await assert.rejects(assertTemplateLayout(dir), { code: "DMG_LAYOUT_INVALID" });
  });

  test("rejects extra volume entries", async () => {
    const dir = await layout((mounted) => writeFile(path.join(mounted, "README.txt"), ""));
    await assert.rejects(assertTemplateLayout(dir), { code: "DMG_LAYOUT_INVALID" });
    const hidden = await layout((mounted) => mkdir(path.join(mounted, ".fseventsd")));
    await assert.rejects(assertTemplateLayout(hidden), { code: "DMG_LAYOUT_INVALID" });
  });

  test("rejects a volume without the app", async () => {
    const dir = await temp("toolbox-layout-");
    await assert.rejects(assertTemplateLayout(dir), { code: "DMG_LAYOUT_INVALID" });
  });
});

// A workspace as electron-builder leaves it, with commands that would need macOS replaced by fakes.
async function bundleFixture({ packageVersion = "1.2.3", plistVersion = "1.2.3", archs = "arm64", extraVolumeEntry = null } = {}) {
  const workspace = await temp("toolbox-workspace-");
  const runnerTemp = await temp("toolbox-runner-");
  await mkdir(path.join(workspace, "src", "PiDesktop.Tauri"), { recursive: true });
  await writeFile(path.join(workspace, "src", "PiDesktop.Tauri", "package.json"), JSON.stringify({ name: "synthv-toolbox", version: packageVersion }));
  const macos = path.join(workspace, "release", "mac-arm64", APP, "Contents");
  await mkdir(path.join(macos, "MacOS"), { recursive: true });
  await mkdir(path.join(macos, "Resources"), { recursive: true });
  await writeFile(path.join(macos, "Info.plist"), "plist");
  await writeFile(path.join(macos, "MacOS", "Synthesizer V Toolbox"), "binary");
  await writeFile(path.join(macos, "Resources", "app.asar"), "asar");
  await writeFile(path.join(workspace, "release", "Synthesizer-V-Toolbox-1.2.3.dmg"), "template-image");
  const calls = [];
  const hash = "a".repeat(64);
  const plist = {
    CFBundleIdentifier: BUNDLE_ID,
    CFBundleShortVersionString: plistVersion,
    CFBundleExecutable: "Synthesizer V Toolbox",
    ElectronAsarIntegrity: JSON.stringify({ "Resources/app.asar": { algorithm: "SHA256", hash } }),
  };
  const exec = (file, args, options = {}) => {
    calls.push([path.basename(file), ...args]);
    const tool = path.basename(file);
    if (tool === "plutil") return plist[args[1]] ?? "";
    if (tool === "lipo") return `${archs}\n`;
    if (tool === "hdiutil" && args[0] === "attach") {
      const mounted = args[args.indexOf("-mountpoint") + 1];
      cpSync(path.join(workspace, "release", "mac-arm64", APP), path.join(mounted, APP), { recursive: true });
      symlinkSync("/Applications", path.join(mounted, "Applications"));
      if (extraVolumeEntry) writeFileSync(path.join(mounted, extraVolumeEntry), "");
      return "";
    }
    if (tool === "tar" || tool === "zip" || tool === "hdiutil") return options.capture ? "" : undefined;
    throw new Error(`unexpected command ${tool}`);
  };
  const env = { GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1", INPUT_TAG: "v1.2.3", INPUT_SOURCE_SHA: SHA, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp };
  return { workspace, runnerTemp, env, calls, exec };
}

describe("source bundle preparation", { skip: !posix }, () => {
  test("rejects a tag that differs from the package version", async () => {
    const fixture = await bundleFixture({ packageVersion: "1.2.4" });
    await assert.rejects(prepare({ env: fixture.env, exec: fixture.exec }), { code: "PACKAGE_VERSION_MISMATCH" });
  });

  test("rejects an application whose version or architecture differs from the request", async () => {
    const version = await bundleFixture({ plistVersion: "1.2.4" });
    await assert.rejects(prepare({ env: version.env, exec: version.exec }), { code: "APP_METADATA_INVALID" });
    const arch = await bundleFixture({ archs: "x86_64" });
    await assert.rejects(prepare({ env: arch.env, exec: arch.exec }), { code: "APP_ARCHITECTURE_INVALID" });
  });

  test("rejects a template disk image with unexpected entries before packing", async () => {
    const fixture = await bundleFixture({ extraVolumeEntry: ".fseventsd" });
    await assert.rejects(prepare({ env: fixture.env, exec: fixture.exec }), { code: "DMG_LAYOUT_INVALID" });
    assert.equal(fixture.calls.some(([tool]) => tool === "zip" || tool === "tar"), false);
    assert.deepEqual(await readdir(fixture.runnerTemp), []);
  });

  test("rejects prerelease tags before touching the workspace", async () => {
    const fixture = await bundleFixture();
    await assert.rejects(prepare({ env: { ...fixture.env, INPUT_TAG: "v1.2.3-beta.1" }, exec: fixture.exec }), { code: "TAG_NOT_STABLE" });
    assert.deepEqual(fixture.calls, []);
  });
});

// Real tar and zip prove the layout the center unpacks: a flat stored zip with exactly three members.
describe("source bundle layout", { skip: !(posix && ["/usr/bin/tar", "/usr/bin/zip", "/usr/bin/unzip"].every((tool) => spawnSync(tool, ["-h"]).error === undefined)) }, () => {
  test("zip holds unsigned.tar.gz, template.dmg and source.json at its root", async () => {
    const fixture = await bundleFixture();
    const exec = (file, args, options = {}) => {
      if (["tar", "zip"].includes(path.basename(file))) {
        const result = spawnSync(file, args, { encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } });
        assert.equal(result.status, 0, result.stderr);
        return "";
      }
      return fixture.exec(file, args, options);
    };
    const { workDir } = await prepare({ env: fixture.env, exec });
    const bundle = path.join(workDir, "source.zip");
    const listing = spawnSync("/usr/bin/unzip", ["-Z1", bundle], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
    assert.deepEqual(listing, ["source.json", "template.dmg", "unsigned.tar.gz"]);
    const details = spawnSync("/usr/bin/unzip", ["-v", bundle], { encoding: "utf8" }).stdout;
    assert.match(details, /Stored/);
    assert.doesNotMatch(details, /Defl/);
    const extracted = await temp("toolbox-unzipped-");
    assert.equal(spawnSync("/usr/bin/unzip", ["-q", bundle, "-d", extracted]).status, 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(extracted, "source.json"), "utf8")), { source_sha: SHA, version: "1.2.3", bundle_id: BUNDLE_ID, architecture: "arm64" });
    assert.equal(await readFile(path.join(extracted, "template.dmg"), "utf8"), "template-image");
    const members = spawnSync("/usr/bin/tar", ["-tzf", path.join(extracted, "unsigned.tar.gz")], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    assert.ok(members.every((name) => name === `${APP}/` || name.startsWith(`${APP}/`)), "every member sits under the bundle name");
    assert.ok(members.every((name) => !path.basename(name).startsWith("._")), "no AppleDouble files");
    assert.deepEqual((await readdir(workDir)).sort(), ["source.zip"]);
  });
});
