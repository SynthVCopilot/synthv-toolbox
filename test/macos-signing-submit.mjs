import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, ".github", "scripts");
const { main, prepare, submitSource, assertTemplateLayout, runIdentity } = await import(pathToFileURL(path.join(scripts, "submit-macos.mjs")).href);

const PROJECT = "synthv-toolbox-arm64";
const BUNDLE_ID = "com.synthvcopilot.toolbox";
const APP = "Toneshuttle.app";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const REQUEST_ID = "6f1d0c2e-3b4a-4c5d-8e9f-a0b1c2d3e4f5";
const posix = process.platform !== "win32";
const temps = [];
after(async () => { await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true }))); });
const temp = async (prefix) => { const dir = await mkdtemp(path.join(tmpdir(), prefix)); temps.push(dir); return dir; };
const sha256 = (buffer) => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
const noSleep = async () => {};

// A signing center that follows the request and push-upload contract of the center README.
async function startCenter({ partSize = 4, received = [], createState = "awaiting_upload", partFailures = [], createFailures = [] } = {}) {
  const log = { createCalls: 0, create: null, createHeaders: null, plans: 0, parts: new Map(), partHeaders: [], complete: 0, completeBody: null };
  log.identities = [];
  const failures = [...partFailures];
  const createErrors = [...createFailures];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    log.identities.push(req.headers["x-run-identity"]);
    if (req.headers.authorization !== "Bearer test-key") return json(401, { error: "invalid_api_key" });
    if (req.method === "POST" && req.url === "/v1/requests") {
      log.createCalls += 1;
      const failure = createErrors.shift();
      if (failure) return json(failure, { error: "github_unavailable" });
      log.create = JSON.parse(body.toString("utf8"));
      log.createHeaders = req.headers;
      return json(202, { request_id: REQUEST_ID, state: createState });
    }
    if (req.method === "POST" && req.url === `/v1/requests/${REQUEST_ID}/source`) {
      assert.equal(body.toString("utf8"), "{}");
      log.plans += 1;
      const size = log.create.input_size;
      return json(200, { part_size: partSize, part_count: Math.ceil(size / partSize), received_parts: [...received, ...log.parts.keys()] });
    }
    const part = /^\/v1\/requests\/[^/]+\/source\/parts\/(\d+)$/.exec(req.url);
    if (req.method === "PUT" && part) {
      const status = failures.shift();
      if (status) return json(status, { error: "part_upload_failed" });
      log.partHeaders.push({ part: Number(part[1]), type: req.headers["content-type"], length: req.headers["content-length"] });
      log.parts.set(Number(part[1]), body);
      return json(200, { ok: true });
    }
    if (req.method === "POST" && req.url === `/v1/requests/${REQUEST_ID}/source/complete`) {
      log.complete += 1;
      log.completeBody = body.toString("utf8");
      return json(200, { request_id: REQUEST_ID, state: "accepted_waiting_source" });
    }
    return json(404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { log, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

async function submitFixture(content = Buffer.from("0123456789")) {
  const runnerTemp = await temp("toolbox-submit-");
  const workDir = path.join(runnerTemp, "toolbox-sign-42-abc");
  await mkdir(workDir);
  await writeFile(path.join(workDir, "source.zip"), content);
  return { runnerTemp, workDir, content };
}

async function identityFetch(url, options) {
  if (String(url).startsWith("https://oidc.actions.githubusercontent.com/token")) {
    return Response.json({ value: "test-run-identity" });
  }
  return fetch(url, options);
}
const submitEnv = (fixture, center, extra = {}) => ({
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.githubusercontent.com/token?existing=1",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-credential",
  SIGNING_API_KEY: "test-key",
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "1",
  INPUT_TAG: "v1.2.3",
  INPUT_SOURCE_SHA: SHA,
  INPUT_WORK_DIR: fixture.workDir,
  RUNNER_TEMP: fixture.runnerTemp,
  ...extra,
});

describe("GitHub Actions run identity", () => {
  test("requests a fresh token with the center audience and preserves the runner URL query", async () => {
    const calls = [];
    const fixture = await submitFixture();
    const env = submitEnv(fixture, {});
    const fetchImpl = async (url, options) => {
      calls.push([String(url), options]);
      return Response.json({ value: `token-${calls.length}` });
    };
    assert.equal(await runIdentity(env, fetchImpl, "https://sign.voidcarve.com"), "token-1");
    assert.equal(await runIdentity(env, fetchImpl, "https://sign.voidcarve.com"), "token-2");
    const url = new URL(calls[0][0]);
    assert.equal(url.searchParams.get("existing"), "1");
    assert.equal(url.searchParams.get("audience"), "https://sign.voidcarve.com");
    assert.equal(calls[0][1].headers.authorization, "Bearer oidc-request-credential");
    assert.equal(calls[0][1].redirect, "error");
  });

  test("fails closed when runner identity is unavailable or the provider returns an invalid token", async () => {
    const fixture = await submitFixture();
    const env = submitEnv(fixture, {});
    await assert.rejects(runIdentity({ ...env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }, fetch, "https://sign.voidcarve.com"), { code: "RUN_IDENTITY_UNAVAILABLE" });
    for (const value of ["", 42, "x".repeat(4097)]) {
      await assert.rejects(runIdentity(env, async () => Response.json({ value }), "https://sign.voidcarve.com"), { code: "RUN_IDENTITY_FAILED" });
    }
  });

  test("obtains a fresh identity for every submit, begin, part, retry and complete call", async () => {
    const center = await startCenter({ partFailures: [503] });
    const fixture = await submitFixture();
    let requested = 0;
    const fetchImpl = async (url, options) => String(url).startsWith("https://oidc.actions.githubusercontent.com/token")
      ? Response.json({ value: `proof-${++requested}` }) : fetch(url, options);
    try {
      await submitSource({ env: submitEnv(fixture, center), signingOrigin: center.url, fetchImpl, sleep: noSleep });
      assert.equal(requested, 8);
      assert.deepEqual(center.log.identities, Array.from({ length: 8 }, (_, i) => `proof-${i + 1}`));
    } finally { await center.close(); }
  });
});

describe("push request to the signing center", () => {
  test("creates the request, uploads every part and completes", async () => {
    const center = await startCenter();
    const fixture = await submitFixture();
    try {
      const result = await submitSource({ fetchImpl: identityFetch, signingOrigin: center.url, env: submitEnv(fixture, center), sleep: noSleep });
      assert.deepEqual(center.log.create, {
        project_id: PROJECT,
        platform: "macos",
        execution_visibility: "public",
        run_id: 42,
        run_attempt: 1,
        input_digest: sha256(fixture.content),
        input_size: 10,
        version: "1.2.3",
        source_sha: SHA,
      });
      assert.equal(center.log.createHeaders["idempotency-key"], `${PROJECT}-42-1`);
      assert.deepEqual([...center.log.parts.keys()].sort(), [1, 2, 3]);
      assert.deepEqual(center.log.partHeaders.map((entry) => [entry.part, entry.type, entry.length]).sort(), [[1, "application/octet-stream", "4"], [2, "application/octet-stream", "4"], [3, "application/octet-stream", "2"]]);
      assert.equal(Buffer.concat([1, 2, 3].map((n) => center.log.parts.get(n))).toString("utf8"), "0123456789");
      assert.equal(center.log.complete, 1);
      assert.equal(center.log.completeBody, "{}");
      assert.deepEqual(center.log.identities, Array(6).fill("test-run-identity"));
      assert.equal(result.request_id, REQUEST_ID);
      assert.equal(result.input_digest, sha256(fixture.content));
    } finally { await center.close(); }
  });

  test("a repeated request that is already accepted uploads nothing", async () => {
    const center = await startCenter({ createState: "accepted_waiting_source" });
    const fixture = await submitFixture();
    try {
      const result = await submitSource({ fetchImpl: identityFetch, signingOrigin: center.url, env: submitEnv(fixture, center), sleep: noSleep });
      assert.equal(result.request_id, REQUEST_ID);
      assert.equal(center.log.parts.size, 0);
      assert.equal(center.log.complete, 0);
    } finally { await center.close(); }
  });

  test("resumes an interrupted upload without re-sending received parts", async () => {
    const center = await startCenter({ received: [1, 2] });
    const fixture = await submitFixture();
    try {
      await submitSource({ fetchImpl: identityFetch, signingOrigin: center.url, env: submitEnv(fixture, center), sleep: noSleep });
      assert.deepEqual([...center.log.parts.keys()], [3]);
      assert.equal(center.log.complete, 1);
    } finally { await center.close(); }
  });

  test("retries a part that fails inside the bucket with 503", async () => {
    const center = await startCenter({ partFailures: [503, 503] });
    const fixture = await submitFixture();
    const sleeps = [];
    try {
      await submitSource({ fetchImpl: identityFetch, signingOrigin: center.url, env: submitEnv(fixture, center), sleep: async (ms) => { sleeps.push(ms); } });
      assert.deepEqual([...center.log.parts.keys()].sort(), [1, 2, 3]);
      assert.ok(sleeps.length >= 2);
    } finally { await center.close(); }
  });

  test("retries the create call with the same idempotency key after a transient center error", async () => {
    const center = await startCenter({ createFailures: [503] });
    const fixture = await submitFixture();
    const sleeps = [];
    try {
      const result = await submitSource({ fetchImpl: identityFetch, signingOrigin: center.url, env: submitEnv(fixture, center), sleep: async (ms) => { sleeps.push(ms); } });
      assert.equal(center.log.createCalls, 2);
      assert.equal(center.log.createHeaders["idempotency-key"], `${PROJECT}-42-1`);
      assert.equal(result.request_id, REQUEST_ID);
      assert.equal(sleeps.length, 1);
    } finally { await center.close(); }
  });

  test("does not retry a create call the center rejects", async () => {
    const center = await startCenter({ createFailures: [403] });
    const fixture = await submitFixture();
    try {
      await assert.rejects(submitSource({ fetchImpl: identityFetch, signingOrigin: center.url, env: submitEnv(fixture, center), sleep: noSleep }), { code: "SIGNING_REQUEST_FAILED" });
      assert.equal(center.log.createCalls, 1);
    } finally { await center.close(); }
  });

  test("the signing center address is fixed in code and cannot be redirected by the environment", async () => {
    const fixture = await submitFixture();
    const urls = [];
    const fetchImpl = async (url, options) => {
      if (String(url).startsWith("https://oidc.actions.githubusercontent.com/token")) return identityFetch(url, options);
      urls.push(url); return new Response("{}", { status: 401 });
    };
    await assert.rejects(submitSource({ env: { ...submitEnv(fixture, { url: "" }), SIGNING_URL: "https://attacker.example" }, fetchImpl, sleep: noSleep }), { code: "SIGNING_REQUEST_FAILED" });
    assert.deepEqual(urls, ["https://sign.voidcarve.com/v1/requests"]);
  });

  test("does not retry a part rejected with 400", async () => {
    const center = await startCenter({ partFailures: [400] });
    const fixture = await submitFixture();
    try {
      await assert.rejects(submitSource({ fetchImpl: identityFetch, signingOrigin: center.url, env: submitEnv(fixture, center), sleep: noSleep }), { code: "SOURCE_UPLOAD_FAILED" });
      assert.equal(center.log.complete, 0);
    } finally { await center.close(); }
  });

  test("refuses prerelease tags, reruns, a missing key and a plain http center", async () => {
    const center = await startCenter();
    const fixture = await submitFixture();
    try {
      await assert.rejects(submitSource({ fetchImpl: identityFetch, signingOrigin: center.url, env: submitEnv(fixture, center, { INPUT_TAG: "v1.2.3-rc.1" }), sleep: noSleep }), { code: "TAG_NOT_STABLE" });
      await assert.rejects(submitSource({ fetchImpl: identityFetch, signingOrigin: center.url, env: submitEnv(fixture, center, { INPUT_TAG: "refs/heads/main" }), sleep: noSleep }), { code: "TAG_NOT_STABLE" });
      await assert.rejects(submitSource({ fetchImpl: identityFetch, signingOrigin: center.url, env: submitEnv(fixture, center, { GITHUB_RUN_ATTEMPT: "2" }), sleep: noSleep }), { code: "INVALID_RUN_ATTEMPT" });
      await assert.rejects(submitSource({ fetchImpl: identityFetch, signingOrigin: center.url, env: submitEnv(fixture, center, { SIGNING_API_KEY: "" }), sleep: noSleep }), { code: "SIGNING_API_KEY_UNAVAILABLE" });
      await assert.rejects(submitSource({ fetchImpl: identityFetch, signingOrigin: "http://sign.example.com", env: submitEnv(fixture, center), sleep: noSleep }), { code: "SIGNING_URL_INVALID" });
      await assert.rejects(submitSource({ fetchImpl: identityFetch, signingOrigin: center.url, env: submitEnv(fixture, center, { INPUT_WORK_DIR: path.join(fixture.runnerTemp, "elsewhere") }), sleep: noSleep }), { code: "INVALID_TEMP_DIR" });
      assert.equal(center.log.create, null);
    } finally { await center.close(); }
  });

  test("an unauthorised key fails the request", async () => {
    const center = await startCenter();
    const fixture = await submitFixture();
    try {
      await assert.rejects(submitSource({ fetchImpl: identityFetch, signingOrigin: center.url, env: submitEnv(fixture, center, { SIGNING_API_KEY: "wrong" }), sleep: noSleep }), { code: "SIGNING_REQUEST_FAILED" });
    } finally { await center.close(); }
  });

  test("the command writes only public request data for the publish workflow", async () => {
    const center = await startCenter();
    const fixture = await submitFixture();
    const output = path.join(fixture.runnerTemp, "output.txt");
    try {
      const errors = [];
      const code = await main(["submit"], { fetchImpl: identityFetch, signingOrigin: center.url, env: submitEnv(fixture, center, { GITHUB_OUTPUT: output }), stderr: { write: (text) => errors.push(text) }, sleep: noSleep });
      assert.equal(code, 0, errors.join(""));
      const context = JSON.parse(await readFile(path.join(fixture.runnerTemp, "signing-request", "request.json"), "utf8"));
      assert.deepEqual(context, {
        schema_version: 1,
        build_run_id: 42,
        project_id: PROJECT,
        request_id: REQUEST_ID,
        input_digest: sha256(fixture.content),
        input_size: 10,
        version: "1.2.3",
        source_sha: SHA,
      });
      assert.doesNotMatch(JSON.stringify(context), /test-key/);
      assert.match(await readFile(output, "utf8"), new RegExp(`request_id=${REQUEST_ID}`));
    } finally { await center.close(); }
  });

  test("rejects unknown commands", async () => {
    const errors = [];
    assert.equal(await main(["wipe"], { env: {}, stderr: { write: (text) => errors.push(text) } }), 1);
    assert.equal(errors.join(""), "INVALID_COMMAND\n");
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
  await writeFile(path.join(macos, "MacOS", "Toneshuttle"), "binary");
  await writeFile(path.join(macos, "Resources", "app.asar"), "asar");
  await writeFile(path.join(workspace, "release", "Toneshuttle-1.2.3.dmg"), "template-image");
  const calls = [];
  const hash = "a".repeat(64);
  const plist = {
    CFBundleIdentifier: BUNDLE_ID,
    CFBundleShortVersionString: plistVersion,
    CFBundleExecutable: "Toneshuttle",
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
