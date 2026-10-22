import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  APP, ARCH, BUNDLE_ID, SHA, ToolError, UUID,
  defaultSleep, hashFile, isTransientStatus, readJsonBody, requireFirstAttempt, requireRunId, stableVersion, writeOutputs,
} from './macos-signing-shared.mjs';

const BUNDLE_NAME = 'source.zip';
const GITHUB_API = 'https://api.github.com';
const GITEDGE_ORIGIN = 'https://gitedge.voidcarve.com';
const GITEDGE_REPOSITORY_ID = '13814fa3-8580-4b5a-803e-a6b1206007ed';
const SOURCE_REPOSITORY = 'SynthVCopilot/synthv-toolbox';
const SOURCE_REPOSITORY_ID = '1319908050';
const SOURCE_WORKFLOW = '.github/workflows/desktop.yml';
const SOURCE_ARTIFACT = 'signing-source';
const PROFILE = 'synthv-macos-arm64';
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAC_DIR = /^mac(-arm64)?$/;
const ALLOWED_VOLUME_ENTRIES = new Set(['Applications', '.background', '.background.tiff', '.DS_Store', '.VolumeIcon.icns']);

function requiredEnv(name, value) {
  if (!value) throw new ToolError(`${name}_UNAVAILABLE`);
  return value;
}

function defaultExec(file, args, { capture = false } = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8', stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'], timeout: 120_000,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (result.error || result.status !== 0) throw new ToolError('COMMAND_FAILED');
  return capture ? String(result.stdout ?? '') : undefined;
}

function runnerTemp(env) {
  const dir = env.RUNNER_TEMP;
  if (!dir || !path.isAbsolute(dir)) throw new ToolError('TEMP_UNAVAILABLE');
  return path.resolve(dir);
}

function workspace(env) {
  if (!env.GITHUB_WORKSPACE || !path.isAbsolute(env.GITHUB_WORKSPACE)) throw new ToolError('WORKSPACE_UNAVAILABLE');
  return path.resolve(env.GITHUB_WORKSPACE);
}

async function findApp(root) {
  const releaseDir = path.join(root, 'release');
  const found = [];
  let entries;
  try { entries = await readdir(releaseDir, { withFileTypes: true }); } catch { throw new ToolError('APP_BUNDLE_COUNT_INVALID'); }
  for (const entry of entries) {
    if (!MAC_DIR.test(entry.name)) continue;
    const dir = path.join(releaseDir, entry.name);
    const dirInfo = await lstat(dir);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new ToolError('APP_BUNDLE_INVALID');
    const app = path.join(dir, APP);
    const info = await lstat(app).catch(() => null);
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ToolError('APP_BUNDLE_INVALID');
    found.push({ dir, app });
  }
  if (found.length !== 1) throw new ToolError('APP_BUNDLE_COUNT_INVALID');
  return found[0];
}

function plistValue(exec, app, key, format = 'raw') {
  return exec('/usr/bin/plutil', ['-extract', key, format, '-o', '-', path.join(app, 'Contents', 'Info.plist')], { capture: true }).trim();
}

/** Reads and checks the identity the center will compare against the request. */
export function inspectApp(exec, app, version) {
  let executable;
  try {
    if (plistValue(exec, app, 'CFBundleIdentifier') !== BUNDLE_ID || plistValue(exec, app, 'CFBundleShortVersionString') !== version) throw new ToolError('APP_METADATA_INVALID');
    executable = plistValue(exec, app, 'CFBundleExecutable');
    const integrity = JSON.parse(plistValue(exec, app, 'ElectronAsarIntegrity', 'json'))['Resources/app.asar'];
    if (integrity?.algorithm !== 'SHA256' || !/^[a-f0-9]{64}$/.test(integrity.hash ?? '')) throw new ToolError('APP_METADATA_INVALID');
  } catch { throw new ToolError('APP_METADATA_INVALID'); }
  if (!executable || executable.includes('/') || executable === '.' || executable === '..') throw new ToolError('APP_METADATA_INVALID');
  let archs;
  try { archs = exec('/usr/bin/lipo', ['-archs', path.join(app, 'Contents', 'MacOS', executable)], { capture: true }).trim(); }
  catch { throw new ToolError('APP_METADATA_INVALID'); }
  if (archs !== ARCH) throw new ToolError('APP_ARCHITECTURE_INVALID');
  return executable;
}

/** Mirrors the disk image layout the center accepts so a bad template fails before upload. */
export async function assertTemplateLayout(mounted) {
  const entries = await readdir(mounted, { withFileTypes: true });
  let hasApp = false;
  for (const entry of entries) {
    if (entry.name === APP) {
      if (!entry.isDirectory()) throw new ToolError('DMG_LAYOUT_INVALID');
      hasApp = true;
    } else if (entry.name === 'Applications') {
      if (!entry.isSymbolicLink() || await readlink(path.join(mounted, entry.name)) !== '/Applications') throw new ToolError('DMG_LAYOUT_INVALID');
    } else if (entry.name === '.background') {
      if (!entry.isDirectory() && !entry.isFile()) throw new ToolError('DMG_LAYOUT_INVALID');
    } else if (!ALLOWED_VOLUME_ENTRIES.has(entry.name) || !entry.isFile()) throw new ToolError('DMG_LAYOUT_INVALID');
  }
  if (!hasApp) throw new ToolError('DMG_LAYOUT_INVALID');
}

async function assertDmgMatchesApp(app, mounted, executable) {
  await assertTemplateLayout(mounted);
  for (const parts of [['Contents', 'Info.plist'], ['Contents', 'MacOS', executable], ['Contents', 'Resources', 'app.asar']]) {
    const [left, right] = await Promise.all([hashFile(path.join(app, ...parts)), hashFile(path.join(mounted, APP, ...parts))]).catch(() => { throw new ToolError('DMG_APP_MISMATCH'); });
    if (left.hash.digest('hex') !== right.hash.digest('hex')) throw new ToolError('DMG_APP_MISMATCH');
  }
}

async function buildBundle({ env, exec, runId, version, sourceSha, app, dir, executable }) {
  const dmg = path.join(workspace(env), 'release', `Synthesizer-V-Toolbox-${version}.dmg`);
  const dmgInfo = await lstat(dmg).catch(() => null);
  if (!dmgInfo?.isFile()) throw new ToolError('DMG_APP_MISMATCH');
  const workDir = await mkdtemp(path.join(runnerTemp(env), `toolbox-sign-${runId}-`));
  await chmod(workDir, 0o700);
  const mounted = path.join(workDir, 'mounted');
  const stage = path.join(workDir, 'stage');
  let attached = false;
  try {
    await mkdir(mounted, { mode: 0o700 });
    await mkdir(stage, { mode: 0o700 });
    exec('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mounted, dmg]);
    attached = true;
    let mismatch = null;
    try { await assertDmgMatchesApp(app, mounted, executable); } catch (error) { mismatch = error; }
    try { exec('/usr/bin/hdiutil', ['detach', mounted]); attached = false; } catch { throw new ToolError('DISK_IMAGE_DETACH_FAILED'); }
    if (mismatch) throw mismatch;
    const tar = path.join(stage, 'unsigned.tar.gz');
    const template = path.join(stage, 'template.dmg');
    const sourceJson = path.join(stage, 'source.json');
    exec('/usr/bin/tar', ['-czf', tar, '-C', dir, '--', APP]);
    await copyFile(dmg, template);
    await writeFile(sourceJson, `${JSON.stringify({ source_sha: sourceSha, version, bundle_id: BUNDLE_ID, architecture: ARCH })}\n`, { flag: 'wx', mode: 0o600 });
    const bundle = path.join(workDir, BUNDLE_NAME);
    exec('/usr/bin/zip', ['-q', '-X', '-j', '-0', bundle, tar, template, sourceJson]);
    const info = await stat(bundle).catch(() => null);
    if (!info?.isFile()) throw new ToolError('COMMAND_FAILED');
    await chmod(bundle, 0o600);
    await rm(stage, { recursive: true, force: true });
    await rm(mounted, { recursive: true, force: true });
    return workDir;
  } catch (error) {
    if (!attached) await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

export async function prepare({ env = process.env, exec = defaultExec } = {}) {
  const runId = requireRunId(env.GITHUB_RUN_ID);
  requireFirstAttempt(env);
  const version = stableVersion(env.INPUT_TAG);
  const sourceSha = env.INPUT_SOURCE_SHA;
  if (!SHA.test(sourceSha ?? '')) throw new ToolError('INVALID_SIGNING_REQUEST');
  runnerTemp(env);
  const root = workspace(env);
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(root, 'src', 'PiDesktop.Tauri', 'package.json'), 'utf8')); } catch { throw new ToolError('PACKAGE_VERSION_UNAVAILABLE'); }
  if (manifest.version !== version) throw new ToolError('PACKAGE_VERSION_MISMATCH');
  const { app, dir } = await findApp(root);
  const executable = inspectApp(exec, app, version);
  const workDir = await buildBundle({ env, exec, runId, version, sourceSha, app, dir, executable });
  return { workDir, version };
}

export async function runIdentity(env, fetchImpl, audience) {
  const credential = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !credential) throw new ToolError('RUN_IDENTITY_UNAVAILABLE');
  let url;
  try {
    url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
    url.searchParams.set('audience', audience);
  } catch { throw new ToolError('RUN_IDENTITY_UNAVAILABLE'); }
  let response;
  try {
    response = await fetchImpl(url.href, {
      redirect: 'error', headers: { authorization: `Bearer ${credential}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new ToolError('RUN_IDENTITY_FAILED', { transient: true }); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ToolError('RUN_IDENTITY_FAILED', { transient: isTransientStatus(response.status) });
  }
  const body = await readJsonBody(response, 'RUN_IDENTITY_FAILED');
  if (typeof body.value !== 'string' || !body.value || body.value.length > 4096 || /[\r\n]/.test(body.value)) throw new ToolError('RUN_IDENTITY_FAILED');
  return body.value;
}

function sourceArtifactUrl(suffix) { return `${GITHUB_API}/repos/${SOURCE_REPOSITORY}${suffix}`; }

async function githubJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!response.ok) { await response.body?.cancel(); throw new ToolError('GITHUB_API_FAILED'); }
  return readJsonBody(response, 'GITHUB_API_FAILED');
}

async function sourceArtifactMetadata(env, fetchImpl) {
  const runId = requireRunId(env.GITHUB_RUN_ID);
  const run = await githubJson(fetchImpl, sourceArtifactUrl(`/actions/runs/${runId}`), env.GITHUB_TOKEN);
  if (String(run.id) !== runId || run.path?.split('@')[0] !== SOURCE_WORKFLOW || run.event !== 'push'
    || run.status !== 'in_progress' || run.run_attempt !== 1 || !/^v\d+\.\d+\.\d+$/.test(run.head_branch ?? '')
    || run.head_branch !== env.INPUT_TAG
    || run.head_sha !== env.INPUT_SOURCE_SHA || env.GITHUB_REF !== `refs/tags/${run.head_branch}`
    || env.GITHUB_REPOSITORY !== SOURCE_REPOSITORY || env.GITHUB_REPOSITORY_ID !== SOURCE_REPOSITORY_ID)
    throw new ToolError('SOURCE_RUN_NOT_ALLOWED');
  const artifactId = env.INPUT_ARTIFACT_ID;
  if (!/^[1-9]\d*$/.test(artifactId ?? '') || !Number.isSafeInteger(Number(artifactId))) throw new ToolError('INVALID_SOURCE_ARTIFACT');
  const artifact = await githubJson(fetchImpl, sourceArtifactUrl(`/actions/artifacts/${artifactId}`), env.GITHUB_TOKEN);
  if (artifact.id !== Number(artifactId) || artifact.name !== SOURCE_ARTIFACT || artifact.expired !== false
    || String(artifact.workflow_run?.id) !== runId || artifact.workflow_run?.repository_id !== Number(SOURCE_REPOSITORY_ID)
    || artifact.workflow_run?.head_sha !== env.INPUT_SOURCE_SHA || !ARTIFACT_DIGEST.test(artifact.digest ?? '')
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1)
    throw new ToolError('SOURCE_ARTIFACT_METADATA_INVALID');
  return { id: artifactId, runId, digest: artifact.digest, size: artifact.size_in_bytes, tag: run.head_branch };
}

async function gitedgeJson(fetchImpl, url, token, { method = 'GET', body, idempotencyKey, identity } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}), ...(identity ? { 'x-run-identity': identity } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new ToolError('GITEDGE_SIGNING_UNAVAILABLE', { transient: true }); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ToolError(`GITEDGE_SIGNING_HTTP_${response.status}`, { transient: isTransientStatus(response.status) });
  }
  const value = await readJsonBody(response, 'GITEDGE_RESPONSE_INVALID');
  if (!value.data || typeof value.data !== 'object') throw new ToolError('GITEDGE_RESPONSE_INVALID');
  return value.data;
}

function gitedgeRequestUrl(requestId = '') {
  const url = new URL(`/api/actions/signing/requests${requestId ? `/${requestId}` : ''}`, GITEDGE_ORIGIN);
  url.searchParams.set('repositoryId', GITEDGE_REPOSITORY_ID);
  return url;
}

function validateRequest(request, expected) {
  if (!request || !UUID.test(request.id ?? '') || request.repositoryId !== GITEDGE_REPOSITORY_ID
    || request.profile !== PROFILE || request.platform !== 'macos' || request.sourceDigest !== expected.digest
    || request.sourceSize !== expected.size || !/^[a-f0-9]{40}$/.test(request.profileRevision ?? '')
    || !['accepted', 'queued', 'running', 'awaiting_source', 'succeeded', 'failed', 'cancelled'].includes(request.state))
    throw new ToolError('SIGNING_REQUEST_MISMATCH');
  return request;
}

export async function submitSource({ env = process.env, fetchImpl = fetch, sleep = defaultSleep } = {}) {
  const runId = requireRunId(env.GITHUB_RUN_ID);
  requireFirstAttempt(env);
  const version = stableVersion(env.INPUT_TAG);
  const sourceSha = env.INPUT_SOURCE_SHA;
  if (!SHA.test(sourceSha ?? '')) throw new ToolError('INVALID_SIGNING_REQUEST');
  const apiToken = requiredEnv('GITEDGE_SIGNING_TOKEN', env.GITEDGE_SIGNING_TOKEN);
  if (env.GITEDGE_SIGNING_PROFILE !== PROFILE) throw new ToolError('SIGNING_PROFILE_INVALID');
  const githubToken = requiredEnv('GITHUB_TOKEN', env.GITHUB_TOKEN);
  const artifact = await sourceArtifactMetadata({ ...env, GITHUB_TOKEN: githubToken }, fetchImpl);
  const identity = await runIdentity(env, fetchImpl, GITEDGE_ORIGIN);
  const body = {
    profile: PROFILE, platform: 'macos', sourceRepositoryId: SOURCE_REPOSITORY_ID,
    sourceCommitOid: sourceSha, sourceRunId: runId, sourceArtifactId: artifact.id,
    sourceDigest: artifact.digest, sourceSize: artifact.size, version,
  };
  let response;
  for (let attempt = 1; ; attempt += 1) {
    try {
      response = await gitedgeJson(fetchImpl, gitedgeRequestUrl(), apiToken, {
        method: 'POST', body, identity, idempotencyKey: `synthv-${runId}-1`,
      });
      break;
    } catch (error) {
      if (!(error instanceof ToolError) || !error.transient || attempt >= 5) throw error;
      await sleep(2000 * 2 ** (attempt - 1));
    }
  }
  const request = validateRequest(response.request, artifact);
  return {
    request_id: request.id, repository_id: request.repositoryId, profile: request.profile,
    profile_revision: request.profileRevision, source_run_id: artifact.runId, source_sha: sourceSha,
    source_artifact_id: artifact.id, source_digest: artifact.digest, source_size: artifact.size,
    version, build_run_id: Number(runId),
  };
}

/** Writes the public hand-off file; it holds request identifiers only. */
export async function writeContext(result, { env = process.env } = {}) {
  const dir = path.join(runnerTemp(env), 'signing-request');
  await mkdir(dir, { mode: 0o700 });
  const context = {
    schema_version: 1,
    build_run_id: result.build_run_id,
    repository_id: result.repository_id,
    request_id: result.request_id,
    profile: result.profile,
    profile_revision: result.profile_revision,
    source_run_id: result.source_run_id,
    source_artifact_id: result.source_artifact_id,
    source_digest: result.source_digest,
    source_size: result.source_size,
    version: result.version,
    source_sha: result.source_sha,
  };
  await writeFile(path.join(dir, 'request.json'), `${JSON.stringify(context, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return dir;
}

export async function main(args = process.argv.slice(2), { env = process.env, stderr = process.stderr, fetchImpl = fetch, sleep = defaultSleep, exec = defaultExec } = {}) {
  try {
    if (args.length !== 1 || !['prepare', 'submit'].includes(args[0])) throw new ToolError('INVALID_COMMAND');
    if (args[0] === 'prepare') {
      const { workDir, version } = await prepare({ env, exec });
      await writeOutputs(env, { work_dir: workDir, version });
    } else {
      const result = await submitSource({ env, fetchImpl, sleep });
      await writeOutputs(env, { request_id: result.request_id, context_dir: await writeContext(result, { env }) });
    }
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof ToolError ? error.code : 'SUBMIT_FAILED'}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
