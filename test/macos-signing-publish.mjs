import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publish = await import(pathToFileURL(path.join(root, ".github", "scripts", "publish-macos.mjs")).href);
const { assertStagedSet, assetNames, awaitSigning, fetchSigned, latestMacYml, main, readContext, resolve, validateVerification, verifyMacos } = publish;
// The updater reads latest-mac.yml with this parser, so the generated file must load through it.
const yaml = createRequire(path.join(root, "src/PiDesktop.Tauri/node_modules/electron-updater/package.json"))("js-yaml");

const GITEDGE_REPOSITORY = "13814fa3-8580-4b5a-803e-a6b1206007ed";
const PROFILE = "synthv-macos-arm64";
const PROFILE_REVISION = "b".repeat(40);
const BUNDLE_ID = "com.synthvcopilot.toolbox";
const APP = "Synthesizer V Toolbox.app";
const TEAM_ID = "76DMUAK6J5";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const REQUEST_ID = "6f1d0c2e-3b4a-4c5d-8e9f-a0b1c2d3e4f5";
const NOTARIZATION_ID = "11111111-2222-4333-8444-555555555555";
const INPUT_DIGEST = `sha256:${"b".repeat(64)}`;
// The final stage consumes the previous stage output, so its report names a different digest than the request.
const REPORT_INPUT_DIGEST = INPUT_DIGEST;
const temps = [];
after(async () => { await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true }))); });
const temp = (prefix) => { const dir = mkdtempSync(path.join(tmpdir(), prefix)); temps.push(dir); return dir; };
const sha256Hex = (buffer) => createHash("sha256").update(buffer).digest("hex");
const noSleep = async () => {};

describe("build run resolution", () => {
  const run = (overrides = {}) => ({
    id: 77, path: ".github/workflows/desktop.yml@refs/tags/v1.2.3", repository: { id: 1319908050 }, head_repository: { id: 1319908050 },
    run_attempt: 1, status: "completed", conclusion: "success", event: "push", head_branch: "v1.2.3", head_sha: SHA, ...overrides,
  });
  const resolveWith = (value, env = {}) => resolve({
    env: { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "SynthVCopilot/synthv-toolbox", GITHUB_REPOSITORY_ID: "1319908050", INPUT_BUILD_RUN_ID: "77", ...env },
    sleep: noSleep,
    fetchImpl: async (url) => {
      assert.equal(url, "https://api.github.com/repos/SynthVCopilot/synthv-toolbox/actions/runs/77");
      return new Response(JSON.stringify(value), { status: 200 });
    },
  });

  test("accepts a finished first-attempt stable tag push of the release workflow", async () => {
    assert.deepEqual(await resolveWith(run()), { tag: "v1.2.3", version: "1.2.3", source_sha: SHA, build_run_id: "77" });
  });

  for (const [label, overrides] of [
    ["another workflow", { path: ".github/workflows/ffmpeg-verify.yml" }],
    ["a rerun", { run_attempt: 2 }],
    ["an unfinished run", { status: "in_progress", conclusion: null }],
    ["a failed run", { conclusion: "failure" }],
    ["a manual dispatch", { event: "workflow_dispatch" }],
    ["a run from a fork", { head_repository: { id: 6 } }],
    ["another repository", { repository: { id: 6 } }],
    ["a branch push", { head_branch: "main" }],
    ["a prerelease tag", { head_branch: "v1.2.3-rc.1" }],
    ["a nightly tag", { head_branch: "v1.2.4-dev.5.abcdef1" }],
    ["an incomplete version", { head_branch: "v1.2" }],
  ]) {
    test(`refuses ${label}`, async () => {
      await assert.rejects(resolveWith(run(overrides)), (error) => ["BUILD_RUN_NOT_ALLOWED", "TAG_NOT_STABLE"].includes(error.code));
    });
  }
});

describe("GitEdge signing request hand-off", () => {
  const contextEnv = async (context) => {
    const dir = temp("toolbox-context-");
    await writeFile(path.join(dir, "request.json"), JSON.stringify(context));
    return { INPUT_CONTEXT_DIR: dir, INPUT_BUILD_RUN_ID: "77", INPUT_VERSION: "1.2.3", INPUT_SOURCE_SHA: SHA };
  };
  const valid = {
    schema_version: 1, build_run_id: 77, repository_id: GITEDGE_REPOSITORY, request_id: REQUEST_ID,
    profile: PROFILE, profile_revision: PROFILE_REVISION, source_run_id: "77", source_artifact_id: "88",
    source_digest: INPUT_DIGEST, source_size: 10, version: "1.2.3", source_sha: SHA,
  };

  test("reads a context bound to the resolved source run and signing profile", async () => {
    assert.deepEqual(await readContext({ env: await contextEnv(valid) }), valid);
  });

  for (const [label, change] of [
    ["another build run", { build_run_id: 78 }], ["another version", { version: "1.2.4" }],
    ["another commit", { source_sha: "f".repeat(40) }], ["another GitEdge repository", { repository_id: "other" }],
    ["another profile", { profile: "other" }], ["a malformed profile revision", { profile_revision: "bad" }],
    ["another source artifact", { source_artifact_id: "not-an-id" }], ["a malformed digest", { source_digest: "sha256:abc" }],
    ["an extra field", { api_key: "secret" }],
  ]) {
    test(`refuses ${label}`, async () => {
      await assert.rejects(readContext({ env: await contextEnv({ ...valid, ...change }) }), { code: "CONTEXT_INVALID" });
    });
  }
});
async function startCenter({ states = [], archive = Buffer.from("signed-archive"), digest = null, headerDigest = null, cutFirstDownload = false, downloadStatus = null, overrides = {} } = {}) {
  const log = { ranges: [], statusCalls: 0, downloads: 0 };
  const queue = [...states];
  const archiveDigest = digest ?? `sha256:${sha256Hex(archive)}`;
  const fetch = async (url, options = {}) => {
    const target = new URL(url);
    assert.equal(target.origin, "https://gitedge.voidcarve.com");
    assert.equal(target.searchParams.get("repositoryId"), GITEDGE_REPOSITORY);
    if (options.headers.authorization !== "Bearer test-token") return new Response("{}", { status: 401 });
    if (target.pathname === `/api/actions/signing/requests/${REQUEST_ID}` && options.method !== "GET") return new Response("{}", { status: 405 });
    if (target.pathname === `/api/actions/signing/requests/${REQUEST_ID}`) {
      log.statusCalls += 1;
      const state = queue.length > 1 ? queue.shift() : queue[0];
      return Response.json({ data: {
        id: REQUEST_ID, repositoryId: GITEDGE_REPOSITORY, profile: PROFILE, profileRevision: PROFILE_REVISION,
        platform: "macos", stage: "dmg_finalize", state, sourceDigest: INPUT_DIGEST, sourceSize: 10,
        outputDigest: state === "succeeded" ? archiveDigest : null,
        outputSize: state === "succeeded" ? archive.length : null,
        ...overrides,
      } });
    }
    if (target.pathname === `/api/actions/signing/requests/${REQUEST_ID}/download`) {
      log.downloads += 1;
      if (downloadStatus) return new Response("{}", { status: downloadStatus });
      const range = options.headers.range;
      log.ranges.push(range ?? null);
      const start = range ? Number(/^bytes=(\d+)-$/.exec(range)[1]) : 0;
      const payload = archive.subarray(start);
      const headers = { "content-type": "application/zip", "x-signing-digest": headerDigest ?? archiveDigest,
        "accept-ranges": "bytes", "content-length": String(payload.length) };
      if (range) headers["content-range"] = `bytes ${start}-${archive.length - 1}/${archive.length}`;
      if (cutFirstDownload && log.downloads === 1) {
        const body = new ReadableStream({ start(controller) { controller.enqueue(payload.subarray(0, 5)); setTimeout(() => controller.error(new Error("interrupted")), 5); } });
        return new Response(body, { status: range ? 206 : 200, headers });
      }
      return new Response(payload, { status: range ? 206 : 200, headers });
    }
    return new Response("{}", { status: 404 });
  };
  return { log, archive, archiveDigest, fetch, close: async () => {} };
}

const signingEnv = (_center, extra = {}) => ({
  GITEDGE_SIGNING_TOKEN: "test-token", INPUT_BUILD_RUN_ID: "77", INPUT_VERSION: "1.2.3", INPUT_SOURCE_SHA: SHA,
  INPUT_REQUEST_ID: REQUEST_ID, INPUT_SOURCE_DIGEST: INPUT_DIGEST, INPUT_SOURCE_SIZE: "10",
  INPUT_PROFILE: PROFILE, INPUT_PROFILE_REVISION: PROFILE_REVISION, INPUT_REPOSITORY_ID: GITEDGE_REPOSITORY, ...extra,
});
describe("waiting for GitEdge signing", () => {
  test("polls the profile-bound request until it succeeds", async () => {
    const center = await startCenter({ states: ["queued", "running", "succeeded"] });
    const seen = [];
    const waits = [];
    await awaitSigning({ env: signingEnv(center), fetchImpl: center.fetch, sleep: async ms => waits.push(ms), log: line => seen.push(line) });
    assert.equal(center.log.statusCalls, 3);
    assert.deepEqual(seen, ["state: queued", "state: running", "state: succeeded"]);
    assert.ok(waits.every(ms => ms >= 15_000 && ms <= 300_000));
  });

  test("stops after a failed request", async () => {
    const center = await startCenter({ states: ["running", "failed"] });
    await assert.rejects(awaitSigning({ env: signingEnv(center), fetchImpl: center.fetch, sleep: noSleep, log: () => {} }), { code: "SIGNING_FAILED" });
  });

  test("gives up after the timeout", async () => {
    const center = await startCenter({ states: ["running"] });
    let clock = 0;
    await assert.rejects(awaitSigning({ env: signingEnv(center, { INPUT_TIMEOUT_SECONDS: "100" }), fetchImpl: center.fetch,
      sleep: async ms => { clock += ms; }, now: () => clock, log: () => {} }), { code: "SIGNING_TIMEOUT" });
  });

  test("refuses a status with a mismatched request, repository, profile, revision or source bytes", async () => {
    for (const overrides of [{ id: "7f1d0c2e-3b4a-4c5d-8e9f-a0b1c2d3e4f5" }, { repositoryId: "other" },
      { profile: "other" }, { profileRevision: "c".repeat(40) }, { sourceDigest: `sha256:${"c".repeat(64)}` }, { sourceSize: 11 }]) {
      const center = await startCenter({ states: ["succeeded"], overrides });
      await assert.rejects(awaitSigning({ env: signingEnv(center), fetchImpl: center.fetch, sleep: noSleep, log: () => {} }), { code: "SIGNING_REQUEST_MISMATCH" });
    }
  });

  test("fails immediately on an authentication response", async () => {
    const center = await startCenter({ states: ["running"] });
    await assert.rejects(awaitSigning({ env: signingEnv(center), fetchImpl: async () => new Response("{}", { status: 401 }),
      sleep: noSleep, log: () => {} }), { code: "SIGNING_AUTH_FAILED" });
  });
});
const report = (overrides = {}, files = {}) => ({
  schema_version: 1, request_id: REQUEST_ID, generation: 4, stage: "dmg_finalize", input_digest: REPORT_INPUT_DIGEST, recipe_sha: "d".repeat(40),
  policy_digest: `sha256:${"e".repeat(64)}`, team_id: TEAM_ID, bundle_id: BUNDLE_ID, version: "1.2.3", architecture: "arm64",
  codesign_verified: true, timestamp_verified: true, asar_integrity_verified: true, notarization_id: NOTARIZATION_ID, notarization_status: "Accepted",
  notary_archive_sha256: "f".repeat(64), gatekeeper_verified: true, staple_verified: true,
  files: [{ path: "product.dmg", size: 16, sha256: sha256Hex("signed-dmg-bytes"), ...files }], ...overrides,
});
const expectedReport = { requestId: REQUEST_ID, version: "1.2.3", productSize: 16, productSha256: sha256Hex("signed-dmg-bytes") };

describe("verification report", () => {
  test("accepts the final disk image report for this request", () => {
    validateVerification(report(), expectedReport);
  });

  for (const [label, overrides, files] of [
    ["another team", { team_id: "ABCDE12345" }],
    ["another bundle id", { bundle_id: "io.example.other" }],
    ["a malformed previous-stage digest", { input_digest: "sha256:abc" }],
    ["another request", { request_id: "7f1d0c2e-3b4a-4c5d-8e9f-a0b1c2d3e4f5" }],
    ["another version", { version: "1.2.4" }],
    ["another architecture", { architecture: "x64" }],
    ["an intermediate stage", { stage: "dmg_sign" }],
    ["an unnotarized image", { notarization_status: "Submitted" }],
    ["a missing staple", { staple_verified: false }],
    ["an unchecked Electron archive", { asar_integrity_verified: false }],
    ["a missing gatekeeper pass", { gatekeeper_verified: false }],
    ["an unexpected field", { extra: true }],
    ["a different file", {}, { sha256: "0".repeat(64) }],
    ["a different file size", {}, { size: 15 }],
    ["a different file name", {}, { path: "product.zip" }],
  ]) {
    test(`rejects ${label}`, () => {
      assert.throws(() => validateVerification(report(overrides, files), expectedReport), { code: "VERIFICATION_REPORT_INVALID" });
    });
  }

  test("accepts a valid previous-stage digest distinct from the source artifact digest", () => {
    const previousStageDigest = `sha256:${"0".repeat(64)}`;
    assert.equal(validateVerification(report({ input_digest: previousStageDigest }), expectedReport).input_digest, previousStageDigest);
  });
});

// Fake macOS tooling: every command the verification may run is answered from this table.
function macTools({ team = TEAM_ID, gatekeeper = "source=Notarized Developer ID", flags = "0x10000(runtime)", version = "1.2.3", archs = "arm64", unpackedBroken = false } = {}) {
  const calls = [];
  const identity = (authority) => `${authority ? `Authority=Developer ID Application: Example (${team})\n` : ""}CodeDirectory v=20500 size=1 flags=${flags} hashes=1\nTeamIdentifier=${team}\nTimestamp=Oct 11, 2026 at 10:00:00\n`;
  const exec = (file, args) => {
    const tool = path.basename(file);
    calls.push([tool, ...args]);
    const target = args[args.length - 1];
    if (tool === "codesign" && args[0] === "-dv") return identity(!target.endsWith(".dmg"));
    if (tool === "codesign") {
      if (unpackedBroken && args.includes("--deep") && !args.some((arg) => arg.startsWith("-R="))) throw new Error("broken");
      return "";
    }
    if (tool === "spctl") return `${target}: accepted\n${gatekeeper}\n`;
    if (tool === "xcrun") return "";
    if (tool === "hdiutil" && args[0] === "attach") {
      mkdirSync(path.join(args[args.indexOf("-mountpoint") + 1], APP), { recursive: true });
      return "";
    }
    if (tool === "hdiutil") return "";
    if (tool === "plutil") return { CFBundleIdentifier: BUNDLE_ID, CFBundleShortVersionString: version, CFBundleExecutable: "Toneshuttle" }[args[1]] ?? "";
    if (tool === "lipo") return `${archs}\n`;
    if (tool === "ditto" && args[0] === "-c") { writeFileSync(target, "updater-zip-bytes"); return ""; }
    if (tool === "ditto" && args[0] === "-x") { mkdirSync(path.join(target, APP), { recursive: true }); return ""; }
    if (tool === "unzip" && args[0] === "-Z1") return "verification.json\nproduct.dmg\n";
    if (tool === "unzip") {
      const dest = args[args.indexOf("-d") + 1];
      writeFileSync(path.join(dest, "product.dmg"), "signed-dmg-bytes");
      writeFileSync(path.join(dest, "verification.json"), JSON.stringify(report({}, { size: 16, sha256: sha256Hex("signed-dmg-bytes") })));
      return "";
    }
    throw new Error(`unexpected command ${tool}`);
  };
  return { exec, calls };
}

describe("macOS verification of the signed image", () => {
  const verify = async (options) => {
    const tools = macTools(options);
    const tmpRoot = temp("toolbox-verify-root-");
    const zip = path.join(tmpRoot, "updater.zip");
    await verifyMacos({ exec: tools.exec, dmg: path.join(tmpRoot, "product.dmg"), version: "1.2.3", zip, tmpRoot });
    return { ...tools, zip };
  };

  test("checks signature, staple and Gatekeeper on the image and the app, then builds the updater zip", async () => {
    const { calls, zip } = await verify();
    assert.ok(calls.some((call) => call[0] === "codesign" && call.includes("--verify") && call.includes("--strict") && call.at(-1).endsWith("product.dmg")));
    assert.ok(calls.some((call) => call[0] === "spctl" && call.includes("-a") && call.includes("-t") && call.includes("open") && call.includes("context:primary-signature") && call.at(-1).endsWith("product.dmg")));
    assert.ok(calls.some((call) => call[0] === "xcrun" && call[1] === "stapler" && call[2] === "validate" && call.at(-1).endsWith("product.dmg")));
    assert.ok(calls.some((call) => call[0] === "codesign" && call.includes("--verify") && call.includes("--deep") && call.includes("--strict") && call.at(-1).endsWith(APP)));
    assert.ok(calls.some((call) => call[0] === "xcrun" && call[2] === "validate" && call.at(-1).endsWith(APP)));
    const ditto = calls.find((call) => call[0] === "ditto" && call[1] === "-c");
    assert.deepEqual(ditto.slice(1, 5), ["-c", "-k", "--sequesterRsrc", "--keepParent"]);
    assert.equal(ditto.at(-1), zip);
    assert.equal(readFileSync(zip, "utf8"), "updater-zip-bytes");
    assert.ok(calls.some((call) => call[0] === "hdiutil" && call[1] === "detach"));
  });

  test("fails when the team identifier differs", async () => {
    await assert.rejects(verify({ team: "ABCDE12345" }), { code: "MACOS_VERIFICATION_FAILED:dmg-identity" });
  });

  test("fails when Gatekeeper does not report a notarized Developer ID", async () => {
    await assert.rejects(verify({ gatekeeper: "source=Unnotarized Developer ID" }), { code: "MACOS_VERIFICATION_FAILED:dmg-gatekeeper" });
  });

  test("fails when the app has no hardened runtime", async () => {
    await assert.rejects(verify({ flags: "0x0(none)" }), { code: "MACOS_VERIFICATION_FAILED:app-identity" });
  });

  test("fails when the app version or architecture differs", async () => {
    await assert.rejects(verify({ version: "1.2.4" }), { code: "MACOS_VERIFICATION_FAILED:app-metadata" });
    await assert.rejects(verify({ archs: "x86_64" }), { code: "MACOS_VERIFICATION_FAILED:app-metadata" });
  });

  test("fails when the unpacked updater zip no longer verifies", async () => {
    await assert.rejects(verify({ unpackedBroken: true }), { code: "MACOS_VERIFICATION_FAILED:updater-zip" });
  });
});

describe("latest-mac.yml", () => {
  test("loads through the updater's yaml parser with the signed zip first", () => {
    const zip = { name: "Toneshuttle-1.2.3-arm64-mac.zip", version: "1.2.3", size: 17, sha512: "zipsha+/==" };
    const dmg = { name: "Toneshuttle-1.2.3.dmg", version: "1.2.3", size: 14, sha512: "dmgsha+/==" };
    const info = yaml.load(latestMacYml({ zip, dmg, now: () => Date.UTC(2026, 9, 11, 10, 0, 0) }));
    assert.equal(info.version, "1.2.3");
    assert.deepEqual(info.files, [{ url: zip.name, sha512: zip.sha512, size: 17 }, { url: dmg.name, sha512: dmg.sha512, size: 14 }]);
    assert.equal(info.path, zip.name);
    assert.equal(info.sha512, zip.sha512);
    assert.equal(new Date(info.releaseDate).toISOString(), "2026-10-11T10:00:00.000Z");
  });
});

describe("fetching the signed image", () => {
  const fetchWith = async (center, { exec = macTools().exec, env = {} } = {}) => {
    const runnerTemp = temp("toolbox-fetch-");
    const dir = await fetchSigned({
      env: { ...signingEnv(center), GITHUB_RUN_ID: "88", RUNNER_TEMP: runnerTemp, ...env }, fetchImpl: center.fetch,
      exec, sleep: noSleep, now: () => Date.UTC(2026, 9, 11, 10, 0, 0),
    });
    return { dir, runnerTemp };
  };

  test("downloads, verifies and stages the dmg, the updater zip and the metadata", async () => {
    const center = await startCenter({ states: ["succeeded"] });
    try {
      const { dir } = await fetchWith(center);
      const names = assetNames("1.2.3");
      assert.deepEqual((await readdir(dir)).sort(), [names.dmg, names.metadata, names.zip].sort());
      assert.equal(await readFile(path.join(dir, names.dmg), "utf8"), "signed-dmg-bytes");
      const info = yaml.load(await readFile(path.join(dir, names.metadata), "utf8"));
      const zipBytes = await readFile(path.join(dir, names.zip));
      const dmgBytes = await readFile(path.join(dir, names.dmg));
      assert.equal(info.files[0].url, names.zip);
      assert.equal(info.files[0].sha512, createHash("sha512").update(zipBytes).digest("base64"));
      assert.equal(info.files[0].size, zipBytes.length);
      assert.equal(info.files[1].url, names.dmg);
      assert.equal(info.files[1].sha512, createHash("sha512").update(dmgBytes).digest("base64"));
      assert.equal(info.files[1].size, dmgBytes.length);
      assert.equal(info.version, "1.2.3");
      await assertStagedSet(dir, "1.2.3");
    } finally { await center.close(); }
  });

  test("resumes an interrupted download with a Range request", async () => {
    const archive = Buffer.from("0123456789-signed-archive-bytes");
    const center = await startCenter({ states: ["succeeded"], archive, cutFirstDownload: true });
    try {
      await fetchWith(center);
      assert.equal(center.log.ranges[0], null);
      assert.match(center.log.ranges[1], /^bytes=\d+-$/);
      assert.ok(Number(/\d+/.exec(center.log.ranges[1])[0]) > 0);
    } finally { await center.close(); }
  });

  test("refuses an archive whose digest header differs from the status", async () => {
    const center = await startCenter({ states: ["succeeded"], headerDigest: `sha256:${"9".repeat(64)}` });
    try {
      await assert.rejects(fetchWith(center), { code: "SIGNED_OUTPUT_MISMATCH" });
    } finally { await center.close(); }
  });

  test("refuses an archive whose bytes do not match the announced digest", async () => {
    const center = await startCenter({ states: ["succeeded"] });
    try {
      // The status and the header announce the true digest while the stream carries other bytes.
      center.archive.fill(0x41);
      await assert.rejects(fetchWith(center), { code: "SIGNED_OUTPUT_MISMATCH" });
    } finally { await center.close(); }
  });

  for (const [status, code] of [[409, "SIGNED_OUTPUT_UNAVAILABLE"], [410, "SIGNED_OUTPUT_UNAVAILABLE"]]) {
    test(`a ${status} download answer is final`, async () => {
      const center = await startCenter({ states: ["succeeded"], downloadStatus: status });
      try {
        await assert.rejects(fetchWith(center), { code });
        assert.equal(center.log.downloads, 1);
      } finally { await center.close(); }
    });
  }

  test("refuses a request that has not succeeded", async () => {
    const center = await startCenter({ states: ["running"] });
    try {
      await assert.rejects(fetchWith(center), { code: "SIGNED_OUTPUT_UNAVAILABLE" });
      assert.equal(center.log.downloads, 0);
    } finally { await center.close(); }
  });

  test("refuses a report that does not match the request", async () => {
    const center = await startCenter({ states: ["succeeded"] });
    const tools = macTools();
    const exec = (file, args) => {
      const result = tools.exec(file, args);
      if (path.basename(file) === "unzip" && args[0] !== "-Z1") {
        const dest = args[args.indexOf("-d") + 1];
        writeFileSync(path.join(dest, "verification.json"), JSON.stringify(report({ team_id: "ABCDE12345" }, { size: 16, sha256: sha256Hex("signed-dmg-bytes") })));
      }
      return result;
    };
    try {
      await assert.rejects(fetchWith(center, { exec }), { code: "VERIFICATION_REPORT_INVALID" });
      assert.equal(tools.calls.some((call) => call[0] === "codesign"), false);
    } finally { await center.close(); }
  });

  test("refuses an archive with unexpected members", async () => {
    const center = await startCenter({ states: ["succeeded"] });
    const exec = (file, args) => (path.basename(file) === "unzip" && args[0] === "-Z1" ? "verification.json\nproduct.dmg\nextra.bin\n" : macTools().exec(file, args));
    try {
      await assert.rejects(fetchWith(center, { exec }), { code: "SIGNED_ARCHIVE_INVALID" });
    } finally { await center.close(); }
  });
});

describe("staged release set", () => {
  test("accepts exactly the dmg, zip and metadata", async () => {
    const dir = temp("toolbox-staged-");
    const names = assetNames("1.2.3");
    for (const name of [names.dmg, names.zip, names.metadata]) await writeFile(path.join(dir, name), "x");
    await assertStagedSet(dir, "1.2.3");
    await writeFile(path.join(dir, "extra.txt"), "x");
    await assert.rejects(assertStagedSet(dir, "1.2.3"), { code: "STAGED_SET_INVALID" });
    await rm(path.join(dir, "extra.txt"));
    await rm(path.join(dir, names.zip));
    await assert.rejects(assertStagedSet(dir, "1.2.3"), { code: "STAGED_SET_INVALID" });
  });

  test("uses the artifact names the app and the nightly channel already publish", () => {
    assert.deepEqual(assetNames("1.2.3"), { dmg: "Toneshuttle-1.2.3.dmg", zip: "Toneshuttle-1.2.3-arm64-mac.zip", metadata: "latest-mac.yml" });
  });
});

describe("command line", () => {
  test("rejects unknown commands", async () => {
    const errors = [];
    assert.equal(await main(["gate"], { env: {}, stderr: { write: (text) => errors.push(text) } }), 1);
    assert.equal(errors.join(""), "INVALID_COMMAND\n");
  });

  test("resolve writes the tag, version and source commit as outputs", async () => {
    const output = path.join(temp("toolbox-output-"), "out.txt");
    const errors = [];
    const code = await main(["resolve"], {
      env: { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "SynthVCopilot/synthv-toolbox", GITHUB_REPOSITORY_ID: "1319908050", INPUT_BUILD_RUN_ID: "77", GITHUB_OUTPUT: output },
      stderr: { write: (text) => errors.push(text) },
      sleep: noSleep,
      fetchImpl: async () => new Response(JSON.stringify({
        id: 77, path: ".github/workflows/desktop.yml@refs/tags/v1.2.3", repository: { id: 1319908050 }, head_repository: { id: 1319908050 }, run_attempt: 1,
        status: "completed", conclusion: "success", event: "push", head_branch: "v1.2.3", head_sha: SHA,
      }), { status: 200 }),
    });
    assert.equal(code, 0, errors.join(""));
    assert.equal(await readFile(output, "utf8"), `tag=v1.2.3\nversion=1.2.3\nsource_sha=${SHA}\n`);
  });
});
