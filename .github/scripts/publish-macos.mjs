import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  APP, ARCH, ARCHIVE_DIGEST, BUNDLE_ID, SHA, TEAM_ID, ToolError, UUID,
  defaultSleep, hashFile, isTransientStatus, readJsonBody, requireRunId, stableVersion, writeOutputs,
} from './macos-signing-shared.mjs';

const GITHUB_API = 'https://api.github.com';
const GITEDGE_ORIGIN = 'https://gitedge.voidcarve.com';
const GITEDGE_REPOSITORY_ID = '13814fa3-8580-4b5a-803e-a6b1206007ed';
const PROFILE = 'synthv-macos-arm64';
const SOURCE_REPOSITORY = 'SynthVCopilot/synthv-toolbox';
const SOURCE_REPOSITORY_ID = '1319908050';
const BUILD_WORKFLOW = '.github/workflows/desktop.yml';
const CONTEXT_FILE = 'request.json';
const MAX_CONTEXT_BYTES = 16 * 1024;
const SAFE_CODE = /^[a-z0-9_]{1,64}$/;
const DOWNLOAD_ATTEMPTS = 5;
const TERMINAL_FAILURES = ['failed', 'cancelled'];

function defaultExec(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new ToolError('COMMAND_FAILED');
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

export const assetNames = (version) => ({
  dmg: `Synthesizer-V-Toolbox-${version}.dmg`,
  zip: `Synthesizer-V-Toolbox-${version}-${ARCH}-mac.zip`,
  metadata: 'latest-mac.yml',
});

// Resolve: decide whether a finished build run may be published, using only GitHub's record of the run.

async function githubRun({ fetchImpl, sleep }, token, repo, runId) {
  const route = `/repos/${repo}/actions/runs/${runId}`;
  for (let attempt = 1; ; attempt += 1) {
    let response = null;
    try {
      response = await fetchImpl(`${GITHUB_API}${route}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      });
    } catch { response = null; }
    if (response?.ok) return readJsonBody(response, 'INVALID_RESPONSE');
    const transient = !response || isTransientStatus(response.status);
    await response?.body?.cancel();
    if (!transient || attempt >= 3) throw new ToolError('GITHUB_REQUEST_FAILED');
    await sleep(2000 * attempt);
  }
}

export async function resolve({ env = process.env, fetchImpl = fetch, sleep = defaultSleep } = {}) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new ToolError('GITHUB_TOKEN_UNAVAILABLE');
  const repo = env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) throw new ToolError('INVALID_REPOSITORY');
  const buildRunId = requireRunId(env.INPUT_BUILD_RUN_ID);
  const run = await githubRun({ fetchImpl, sleep }, token, repo, buildRunId);
  if (repo !== SOURCE_REPOSITORY || String(env.GITHUB_REPOSITORY_ID) !== SOURCE_REPOSITORY_ID
    || String(run?.id) !== buildRunId
    || String(run.path ?? '').split('@')[0] !== BUILD_WORKFLOW
    || String(run.repository?.id) !== String(env.GITHUB_REPOSITORY_ID ?? '')
    || String(run.head_repository?.id) !== String(env.GITHUB_REPOSITORY_ID ?? '')
    || run.run_attempt !== 1 || run.status !== 'completed' || run.conclusion !== 'success'
    || run.event !== 'push' || typeof run.head_sha !== 'string' || !SHA.test(run.head_sha)) throw new ToolError('BUILD_RUN_NOT_ALLOWED');
  const version = stableVersion(run.head_branch);
  return { tag: run.head_branch, version, source_sha: run.head_sha, build_run_id: buildRunId };
}

/** Reads the hand-off file of the build run and binds it to the resolved run. */
export async function readContext({ env = process.env } = {}) {
  const dir = env.INPUT_CONTEXT_DIR;
  const buildRunId = requireRunId(env.INPUT_BUILD_RUN_ID);
  if (!dir || !path.isAbsolute(dir)) throw new ToolError('CONTEXT_INVALID');
  const file = path.join(dir, CONTEXT_FILE);
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.size > MAX_CONTEXT_BYTES) throw new ToolError('CONTEXT_INVALID');
  let context;
  try { context = JSON.parse(await readFile(file, 'utf8')); } catch { throw new ToolError('CONTEXT_INVALID'); }
  const keys = ['schema_version', 'build_run_id', 'repository_id', 'request_id', 'profile', 'profile_revision',
    'source_run_id', 'source_artifact_id', 'source_digest', 'source_size', 'version', 'source_sha'];
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.keys(context).length !== keys.length
    || !keys.every(key => Object.hasOwn(context, key)) || context.schema_version !== 1
    || String(context.build_run_id) !== buildRunId || String(context.source_run_id) !== buildRunId
    || context.repository_id !== GITEDGE_REPOSITORY_ID || context.profile !== PROFILE
    || !/^[a-f0-9]{40}$/.test(context.profile_revision ?? '') || !UUID.test(context.request_id ?? '')
    || !/^[1-9]\d*$/.test(context.source_artifact_id ?? '') || !ARCHIVE_DIGEST.test(context.source_digest ?? '')
    || !Number.isSafeInteger(context.source_size) || context.source_size < 1
    || context.version !== env.INPUT_VERSION || context.source_sha !== env.INPUT_SOURCE_SHA) throw new ToolError('CONTEXT_INVALID');
  context = Object.fromEntries(keys.map(key => [key, context[key]]));
  return context;
}

// GitEdge request access.

function signingInputs(env) {
  const buildRunId = requireRunId(env.INPUT_BUILD_RUN_ID);
  const version = env.INPUT_VERSION;
  const sourceSha = env.INPUT_SOURCE_SHA;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !SHA.test(sourceSha ?? '')) throw new ToolError('INVALID_INPUT');
  const apiToken = env.GITEDGE_SIGNING_TOKEN;
  if (!apiToken) throw new ToolError('GITEDGE_SIGNING_TOKEN_UNAVAILABLE');
  const requestId = env.INPUT_REQUEST_ID;
  const sourceDigest = env.INPUT_SOURCE_DIGEST;
  const sourceSize = Number(env.INPUT_SOURCE_SIZE);
  const profileRevision = env.INPUT_PROFILE_REVISION;
  const profile = env.INPUT_PROFILE;
  const repositoryId = env.INPUT_REPOSITORY_ID;
  if (!UUID.test(requestId ?? '') || repositoryId !== GITEDGE_REPOSITORY_ID || profile !== PROFILE
    || !/^[a-f0-9]{40}$/.test(profileRevision ?? '') || !ARCHIVE_DIGEST.test(sourceDigest ?? '')
    || !Number.isSafeInteger(sourceSize) || sourceSize < 1) throw new ToolError('INVALID_INPUT');
  return { buildRunId, version, sourceSha, apiToken, requestId, sourceDigest, sourceSize, profileRevision,
    profile, repositoryId, endpoint: `${GITEDGE_ORIGIN}/api/actions/signing/requests` };
}

async function signingStatus({ fetchImpl }, inputs) {
  let response;
  try {
    const url = new URL(`${inputs.endpoint}/${inputs.requestId}`);
    url.searchParams.set('repositoryId', inputs.repositoryId);
    response = await fetchImpl(url, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${inputs.apiToken}`, accept: 'application/json' },
    });
  } catch { throw new ToolError('SIGNING_STATUS_UNAVAILABLE', { transient: true }); }
  if (!response.ok) {
    await response.body?.cancel();
    if (isTransientStatus(response.status)) throw new ToolError('SIGNING_STATUS_UNAVAILABLE', { transient: true });
    if (response.status === 401 || response.status === 403) throw new ToolError('SIGNING_AUTH_FAILED');
    if (response.status === 404) throw new ToolError('SIGNING_REQUEST_NOT_FOUND');
    throw new ToolError('SIGNING_STATUS_FAILED');
  }
  let envelope;
  try { envelope = await readJsonBody(response, 'SIGNING_STATUS_UNAVAILABLE'); } catch { throw new ToolError('SIGNING_STATUS_UNAVAILABLE', { transient: true }); }
  const body = envelope?.data;
  if (!body || body.id !== inputs.requestId || body.repositoryId !== inputs.repositoryId
    || body.profile !== inputs.profile || body.profileRevision !== inputs.profileRevision || body.platform !== 'macos'
    || body.sourceDigest !== inputs.sourceDigest || body.sourceSize !== inputs.sourceSize)
    throw new ToolError('SIGNING_REQUEST_MISMATCH');
  return body;
}

function interpretStatus(body) {
  if (TERMINAL_FAILURES.includes(body.state)) {
    throw new ToolError(`SIGNING_${body.state.toUpperCase()}`, { detail: typeof body.error === 'string' && SAFE_CODE.test(body.error) ? body.error : '' });
  }
  if (body.state !== 'succeeded') return null;
  if (!ARCHIVE_DIGEST.test(body.outputDigest ?? '') || !Number.isSafeInteger(body.outputSize) || body.outputSize < 1)
    throw new ToolError('SIGNING_OUTPUT_INVALID');
  return { digest: body.outputDigest, size: body.outputSize };
}

export async function awaitSigning({ env = process.env, fetchImpl = fetch, sleep = defaultSleep, now = Date.now, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const inputs = signingInputs(env);
  const timeoutMs = Number(env.INPUT_TIMEOUT_SECONDS ?? 10800) * 1000;
  if (!(timeoutMs > 0)) throw new ToolError('INVALID_INPUT');
  const deadline = now() + timeoutMs;
  let lastState = null;
  for (;;) {
    let wait = 30;
    try {
      const body = await signingStatus({ fetchImpl }, inputs);
      const state = SAFE_CODE.test(body.state ?? '') ? body.state : 'unknown';
      if (state !== lastState) { lastState = state; log(`state: ${state}`); }
      if (interpretStatus(body)) return;
      if (Number.isFinite(body.retry_after_seconds)) wait = body.retry_after_seconds;
    } catch (error) {
      if (!error.transient) throw error;
    }
    if (now() >= deadline) throw new ToolError('SIGNING_TIMEOUT');
    await sleep(Math.min(300, Math.max(15, wait)) * 1000);
  }
}

// Fetch: download, check and stage the signed disk image.

const REPORT_KEYS = ['schema_version', 'request_id', 'generation', 'stage', 'input_digest', 'recipe_sha', 'policy_digest', 'team_id', 'bundle_id', 'version', 'architecture',
  'codesign_verified', 'timestamp_verified', 'asar_integrity_verified', 'notarization_id', 'notarization_status', 'notary_archive_sha256', 'gatekeeper_verified', 'staple_verified', 'files'];

// The final stage consumes the previous stage's output, so its input digest is not the request's digest; the status report is the reference.
export function validateVerification(report, { requestId, version, inputDigest, productSize, productSha256 }) {
  const ok = report !== null && typeof report === 'object' && !Array.isArray(report)
    && Object.keys(report).length === REPORT_KEYS.length && REPORT_KEYS.every((key) => Object.hasOwn(report, key))
    && report.schema_version === 1 && report.request_id === requestId && report.stage === 'dmg_finalize'
    && ARCHIVE_DIGEST.test(report.input_digest ?? '') && (!inputDigest || report.input_digest === inputDigest)
    && report.team_id === TEAM_ID && report.bundle_id === BUNDLE_ID
    && report.version === version && report.architecture === ARCH
    && report.codesign_verified === true && report.timestamp_verified === true
    && report.gatekeeper_verified === true && report.staple_verified === true
    && report.notarization_status === 'Accepted'
    && Number.isSafeInteger(report.generation) && report.generation > 0
    && report.asar_integrity_verified === true
    && SHA.test(report.recipe_sha) && ARCHIVE_DIGEST.test(report.policy_digest)
    && UUID.test(report.notarization_id) && /^[a-f0-9]{64}$/.test(report.notary_archive_sha256)
    && Array.isArray(report.files) && report.files.length === 1
    && Object.keys(report.files[0]).sort().join() === 'path,sha256,size'
    && report.files[0].path === 'product.dmg' && report.files[0].size === productSize && report.files[0].sha256 === productSha256;
  if (!ok) throw new ToolError('VERIFICATION_REPORT_INVALID');
  return report;
}

async function downloadArchive({ fetchImpl, sleep }, inputs, expected, dest) {
  const downloadUrl = new URL(`${inputs.endpoint}/${inputs.requestId}/download`);
  downloadUrl.searchParams.set('repositoryId', inputs.repositoryId);
  const url = downloadUrl.href;
  await writeFile(dest, '', { mode: 0o600 });
  for (let attempt = 1; ; attempt += 1) {
    const have = (await stat(dest)).size;
    let failure = null;
    try {
      const headers = { authorization: `Bearer ${inputs.apiToken}`, accept: 'application/zip' };
      if (have > 0) headers.range = `bytes=${have}-`;
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(600_000) });
      if (response.status === 409 || response.status === 410) { await response.body?.cancel(); throw new ToolError('SIGNED_OUTPUT_UNAVAILABLE'); }
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new ToolError('SIGNING_AUTH_FAILED'); }
      if (response.status === 404) { await response.body?.cancel(); throw new ToolError('SIGNED_OUTPUT_UNAVAILABLE'); }
      if (response.status === 416) { await response.body?.cancel(); await truncate(dest, 0); failure = new ToolError('DOWNLOAD_INTERRUPTED', { transient: true }); }
      else if (!response.ok || !response.body) {
        await response.body?.cancel();
        if (!isTransientStatus(response.status)) throw new ToolError('SIGNED_OUTPUT_UNAVAILABLE');
        failure = new ToolError('DOWNLOAD_INTERRUPTED', { transient: true });
      }
      else {
        if (response.headers.get('x-signing-digest') !== expected.digest) { await response.body.cancel(); throw new ToolError('SIGNED_OUTPUT_MISMATCH'); }
        let offset = have;
        if (response.status === 200) offset = 0;
        else if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${have}-${expected.size - 1}/${expected.size}`) { await response.body.cancel(); throw new ToolError('SIGNED_OUTPUT_MISMATCH'); }
        if (offset === 0 && have > 0) await truncate(dest, 0);
        const handle = await open(dest, 'a');
        let written = offset;
        try {
          for await (const chunk of response.body) {
            written += chunk.byteLength;
            if (written > expected.size) throw new ToolError('SIGNED_OUTPUT_MISMATCH');
            await handle.write(chunk);
          }
        } catch (error) {
          if (error instanceof ToolError) throw error;
          failure = new ToolError('DOWNLOAD_INTERRUPTED', { transient: true });
        } finally { await handle.close(); }
        if (!failure && written < expected.size) failure = new ToolError('DOWNLOAD_INTERRUPTED', { transient: true });
        if (!failure) break;
      }
    } catch (error) {
      if (!(error instanceof ToolError)) failure = new ToolError('DOWNLOAD_INTERRUPTED', { transient: true });
      else if (error.transient) failure = error;
      else throw error;
    }
    if (attempt >= DOWNLOAD_ATTEMPTS) throw new ToolError('SIGNED_OUTPUT_UNAVAILABLE');
    await sleep(2000 * 2 ** (attempt - 1));
  }
  const { hash, size } = await hashFile(dest);
  if (size !== expected.size || `sha256:${hash.digest('hex')}` !== expected.digest) throw new ToolError('SIGNED_OUTPUT_MISMATCH');
}

const field = (output, pattern) => pattern.exec(output)?.[1];

function failCheck(name) { throw new ToolError(`MACOS_VERIFICATION_FAILED:${name}`); }

async function check(name, action) {
  try { return await action(); } catch { return failCheck(name); }
}

function requireIdentity(output, name) {
  if (field(output, /^TeamIdentifier=(.*)$/m) !== TEAM_ID) failCheck(name);
  const timestamp = field(output, /^Timestamp=(.*)$/m);
  if (!timestamp || timestamp.trim() === 'none') failCheck(name);
}

async function findMountedApp(mounted) {
  const apps = [];
  for (const entry of await readdir(mounted, { withFileTypes: true })) {
    if (entry.name.endsWith('.app') && entry.isDirectory()) apps.push(entry.name);
  }
  if (apps.length !== 1 || apps[0] !== APP) throw new ToolError('APP_BUNDLE_COUNT_INVALID');
  return path.join(mounted, APP);
}

const DEVELOPER_ID_REQUIREMENT = `anchor apple generic and identifier "${BUNDLE_ID}" and certificate leaf[subject.OU] = "${TEAM_ID}"`;
const GATEKEEPER = 'source=Notarized Developer ID';

/** Verifies the signed disk image and its app, and writes the updater zip built from that app. */
export async function verifyMacos({ exec = defaultExec, dmg, version, zip, tmpRoot = os.tmpdir() }) {
  await check('dmg-codesign', () => exec('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', dmg]));
  requireIdentity(await check('dmg-identity', () => exec('/usr/bin/codesign', ['-dv', '--verbose=4', dmg])), 'dmg-identity');
  await check('dmg-staple', () => exec('/usr/bin/xcrun', ['stapler', 'validate', dmg]));
  const dmgAssessment = await check('dmg-gatekeeper', () => exec('/usr/sbin/spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg]));
  if (!dmgAssessment.includes(GATEKEEPER)) failCheck('dmg-gatekeeper');

  const work = await mkdtemp(path.join(tmpRoot, 'toolbox-verify-'));
  const mounted = path.join(work, 'mounted');
  let attached = false;
  let failure = null;
  try {
    await check('dmg-mount', async () => { await mkdir(mounted, { mode: 0o700 }); exec('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mounted, dmg]); attached = true; });
    const app = await check('dmg-mount', () => findMountedApp(mounted));

    await check('app-codesign', () => exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', `-R=${DEVELOPER_ID_REQUIREMENT}`, app]));
    const appIdentity = await check('app-identity', () => exec('/usr/bin/codesign', ['-dv', '--verbose=4', app]));
    requireIdentity(appIdentity, 'app-identity');
    if (!/^Authority=Developer ID Application: /m.test(appIdentity)) failCheck('app-identity');
    const flags = field(appIdentity, /flags=0x[0-9a-f]+\(([^)]*)\)/);
    if (!flags || !flags.split(',').includes('runtime')) failCheck('app-identity');

    const plist = path.join(app, 'Contents', 'Info.plist');
    const read = (key) => exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]).trim();
    if (await check('app-metadata', () => read('CFBundleIdentifier')) !== BUNDLE_ID) failCheck('app-metadata');
    if (await check('app-metadata', () => read('CFBundleShortVersionString')) !== version) failCheck('app-metadata');
    const executable = await check('app-metadata', () => read('CFBundleExecutable'));
    const archs = await check('app-metadata', () => exec('/usr/bin/lipo', ['-archs', path.join(app, 'Contents', 'MacOS', executable)]));
    if (archs.trim() !== ARCH) failCheck('app-metadata');

    await check('app-notarization', () => exec('/usr/bin/xcrun', ['stapler', 'validate', app]));
    const appAssessment = await check('app-notarization', () => exec('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]));
    if (!appAssessment.includes(GATEKEEPER)) failCheck('app-notarization');

    await check('updater-zip', () => exec('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]));
    // The updater unpacks the zip next to the running app, so the unpacked copy must still verify and stay stapled.
    const unpacked = path.join(work, 'unpacked');
    await check('updater-zip', async () => {
      await mkdir(unpacked, { mode: 0o700 });
      exec('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
      exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(unpacked, APP)]);
      exec('/usr/bin/xcrun', ['stapler', 'validate', path.join(unpacked, APP)]);
    });
  } catch (error) {
    failure = error;
  }
  let detachFailed = false;
  if (attached) {
    try { exec('/usr/bin/hdiutil', ['detach', mounted]); } catch { detachFailed = true; }
  }
  if (!detachFailed) await rm(work, { recursive: true, force: true });
  if (failure) throw failure;
  if (detachFailed) failCheck('dmg-detach');
}

export function latestMacYml({ zip, dmg, now }) {
  const entry = (file) => `  - url: ${file.name}\n    sha512: ${file.sha512}\n    size: ${file.size}\n`;
  return `version: ${zip.version}\nfiles:\n${entry(zip)}${entry(dmg)}path: ${zip.name}\nsha512: ${zip.sha512}\nreleaseDate: '${new Date(now()).toISOString()}'\n`;
}

async function retryStatus(deps, inputs) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await signingStatus(deps, inputs); } catch (error) {
      if (!error.transient || attempt >= 5) throw error;
      await deps.sleep(2000 * 2 ** (attempt - 1));
    }
  }
}

async function describe(file, name, version) {
  const sha512 = await hashFile(file, 'sha512');
  return { name, version, size: sha512.size, sha512: sha512.hash.digest('base64') };
}

export async function fetchSigned({ env = process.env, fetchImpl = fetch, sleep = defaultSleep, now = Date.now, exec = defaultExec } = {}) {
  const inputs = signingInputs(env);
  const runId = requireRunId(env.GITHUB_RUN_ID);
  if (!env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP)) throw new ToolError('TEMP_UNAVAILABLE');
  const names = assetNames(inputs.version);
  const work = path.join(env.RUNNER_TEMP, `toolbox-signed-${runId}`);
  const out = path.join(env.RUNNER_TEMP, 'signed-macos');
  await mkdir(work, { mode: 0o700 });
  await mkdir(out, { mode: 0o700 });
  const expected = interpretStatus(await retryStatus({ fetchImpl, sleep }, inputs));
  if (!expected) throw new ToolError('SIGNED_OUTPUT_UNAVAILABLE');
  const archive = path.join(work, 'signed.zip');
  await downloadArchive({ fetchImpl, sleep }, inputs, expected, archive);
  const entries = exec('/usr/bin/unzip', ['-Z1', archive]).split('\n').map((line) => line.trim()).filter(Boolean).sort();
  if (entries.join() !== 'product.dmg,verification.json') throw new ToolError('SIGNED_ARCHIVE_INVALID');
  const unpacked = path.join(work, 'unpacked');
  await mkdir(unpacked, { mode: 0o700 });
  exec('/usr/bin/unzip', ['-o', '-q', '-d', unpacked, archive]);
  const product = path.join(unpacked, 'product.dmg');
  const reportFile = path.join(unpacked, 'verification.json');
  const productInfo = await lstat(product).catch(() => null);
  const reportInfo = await lstat(reportFile).catch(() => null);
  if (!productInfo?.isFile() || !reportInfo?.isFile() || reportInfo.size > 65536) throw new ToolError('SIGNED_ARCHIVE_INVALID');
  const sha256 = await hashFile(product);
  let report;
  try { report = JSON.parse(await readFile(reportFile, 'utf8')); } catch { throw new ToolError('VERIFICATION_REPORT_INVALID'); }
  validateVerification(report, { requestId: inputs.requestId, version: inputs.version, inputDigest: expected.reportInputDigest, productSize: sha256.size, productSha256: sha256.hash.digest('hex') });
  const zip = path.join(out, names.zip);
  await verifyMacos({ exec, dmg: product, version: inputs.version, zip, tmpRoot: env.RUNNER_TEMP });
  await copyFile(product, path.join(out, names.dmg));
  const files = { zip: await describe(zip, names.zip, inputs.version), dmg: await describe(path.join(out, names.dmg), names.dmg, inputs.version) };
  await writeFile(path.join(out, names.metadata), latestMacYml({ ...files, now }), { mode: 0o600 });
  await rm(work, { recursive: true, force: true });
  return out;
}

/** The release upload accepts exactly the verified set, nothing else. */
export async function assertStagedSet(dir, version) {
  const names = assetNames(version);
  const expected = [names.dmg, names.zip, names.metadata].sort();
  const actual = (await readdir(dir).catch(() => [])).sort();
  if (actual.join('\n') !== expected.join('\n')) throw new ToolError('STAGED_SET_INVALID');
}

export async function main(args = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env;
  const stderr = deps.stderr ?? process.stderr;
  try {
    const [command] = args;
    if (args.length !== 1 || !['resolve', 'context', 'await', 'fetch'].includes(command)) throw new ToolError('INVALID_COMMAND');
  const injected = { env, fetchImpl: deps.fetchImpl, sleep: deps.sleep, now: deps.now, exec: deps.exec, log: deps.log };
    const defined = Object.fromEntries(Object.entries(injected).filter(([, value]) => value !== undefined));
    if (command === 'resolve') {
      const run = await resolve(defined);
      await writeOutputs(env, { tag: run.tag, version: run.version, source_sha: run.source_sha });
    } else if (command === 'context') {
      const context = await readContext({ env });
      await writeOutputs(env, {
        request_id: context.request_id, source_digest: context.source_digest, source_size: context.source_size,
        profile: context.profile, profile_revision: context.profile_revision, repository_id: context.repository_id,
      });
    } else if (command === 'await') await awaitSigning(defined);
    else {
      const dir = await fetchSigned(defined);
      await assertStagedSet(dir, env.INPUT_VERSION);
      await writeOutputs(env, { dir });
    }
    return 0;
  } catch (error) {
    const code = error instanceof ToolError ? error.code : 'PUBLISH_FAILED';
    stderr.write(`${code}${error instanceof ToolError && error.detail ? ` ${error.detail}` : ''}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
