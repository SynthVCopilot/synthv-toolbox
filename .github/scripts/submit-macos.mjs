import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  APP, ARCH, BUNDLE_ID, PROJECT_ID, SHA, ToolError, UUID,
  defaultSleep, hashFile, isTransientStatus, readJsonBody, requireFirstAttempt, requireRunId, signEndpoint, stableVersion, writeOutputs,
} from './macos-signing-shared.mjs';

const BUNDLE_NAME = 'source.zip';
const MAX_PART_BYTES = 64 * 1024 * 1024;
const PART_ATTEMPTS = 5;
const MAC_DIR = /^mac(-arm64)?$/;
const ALLOWED_VOLUME_ENTRIES = new Set(['Applications', '.background', '.background.tiff', '.DS_Store', '.VolumeIcon.icns']);

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

async function checkedWorkDir(value, runId, env) {
  const workDir = path.resolve(value ?? '');
  if (path.dirname(workDir) !== runnerTemp(env) || !path.basename(workDir).startsWith(`toolbox-sign-${runId}-`)) throw new ToolError('INVALID_TEMP_DIR');
  return workDir;
}

async function centerJson(fetchImpl, url, apiKey, body, extraHeaders = {}, timeoutMs = 30_000) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { throw new ToolError('SIGNING_REQUEST_FAILED', { transient: true }); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ToolError('SIGNING_REQUEST_FAILED', { transient: isTransientStatus(response.status) });
  }
  return readJsonBody(response, 'SIGNING_REQUEST_FAILED');
}

// The create, plan and complete calls are idempotent on the center, so a lost response can be asked for again.
async function centerRetry(sleep, call) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await call(); } catch (error) {
      if (!(error instanceof ToolError) || !error.transient || attempt >= PART_ATTEMPTS) throw error;
      await sleep(2000 * 2 ** (attempt - 1));
    }
  }
}

function validateUploadPlan(plan, bundle) {
  const received = plan?.received_parts;
  if (!Number.isInteger(plan?.part_size) || plan.part_size < 1 || plan.part_size > MAX_PART_BYTES
    || !Number.isInteger(plan.part_count) || plan.part_count !== Math.ceil(bundle.size / plan.part_size)
    || !Array.isArray(received) || !received.every((n) => Number.isInteger(n) && n >= 1 && n <= plan.part_count)) throw new ToolError('SIGNING_REQUEST_FAILED');
  return plan;
}

async function putPart(fetchImpl, url, apiKey, file, start, length) {
  const response = await fetchImpl(url, {
    method: 'PUT',
    redirect: 'error',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/octet-stream', 'content-length': String(length) },
    body: createReadStream(file, { start, end: start + length - 1 }),
    duplex: 'half',
    signal: AbortSignal.timeout(300_000),
  });
  await response.body?.cancel();
  return response.status;
}

async function uploadParts(fetchImpl, sleep, base, apiKey, file, bundle) {
  const fetchPlan = async () => validateUploadPlan(await centerRetry(sleep, () => centerJson(fetchImpl, `${base}/source`, apiKey, {})), bundle);
  let plan = await fetchPlan();
  for (let part = 1; part <= plan.part_count; part += 1) {
    if (plan.received_parts.includes(part)) continue;
    const start = (part - 1) * plan.part_size;
    const length = Math.min(plan.part_size, bundle.size - start);
    for (let attempt = 1; ; attempt += 1) {
      let status = 0;
      try { status = await putPart(fetchImpl, `${base}/source/parts/${part}`, apiKey, file, start, length); } catch { status = 0; }
      if (status === 200) break;
      if (!(status === 0 || isTransientStatus(status)) || attempt >= PART_ATTEMPTS) throw new ToolError('SOURCE_UPLOAD_FAILED');
      await sleep(2000 * 2 ** (attempt - 1));
      plan = await fetchPlan();
      if (plan.received_parts.includes(part)) break;
    }
  }
}

export async function submitSource({ env = process.env, fetchImpl = fetch, sleep = defaultSleep, signingOrigin } = {}) {
  const endpoint = signEndpoint(signingOrigin);
  const runId = requireRunId(env.GITHUB_RUN_ID);
  requireFirstAttempt(env);
  const version = stableVersion(env.INPUT_TAG);
  const sourceSha = env.INPUT_SOURCE_SHA;
  if (!SHA.test(sourceSha ?? '')) throw new ToolError('INVALID_SIGNING_REQUEST');
  const workDir = await checkedWorkDir(env.INPUT_WORK_DIR, runId, env);
  const apiKey = env.SIGNING_API_KEY;
  if (!apiKey) throw new ToolError('SIGNING_API_KEY_UNAVAILABLE');
  const file = path.join(workDir, BUNDLE_NAME);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new ToolError('INVALID_SIGNING_REQUEST');
  const hashed = await hashFile(file);
  const bundle = { digest: `sha256:${hashed.hash.digest('hex')}`, size: hashed.size };
  if (bundle.size < 1) throw new ToolError('INVALID_SIGNING_REQUEST');
  const body = {
    project_id: PROJECT_ID,
    platform: 'macos',
    execution_visibility: 'public',
    run_id: Number(runId),
    run_attempt: 1,
    input_digest: bundle.digest,
    input_size: bundle.size,
    version,
    source_sha: sourceSha,
  };
  const idempotencyKey = { 'idempotency-key': `${PROJECT_ID}-${runId}-1` };
  const created = await centerRetry(sleep, () => centerJson(fetchImpl, endpoint, apiKey, body, idempotencyKey));
  if (typeof created.request_id !== 'string' || !UUID.test(created.request_id)) throw new ToolError('SIGNING_REQUEST_FAILED');
  if (created.state !== 'accepted_waiting_source') {
    if (created.state !== 'awaiting_upload') throw new ToolError('SIGNING_REQUEST_FAILED');
    const base = `${endpoint}/${created.request_id}`;
    await uploadParts(fetchImpl, sleep, base, apiKey, file, bundle);
    const completed = await centerRetry(sleep, () => centerJson(fetchImpl, `${base}/source/complete`, apiKey, {}, {}, 300_000));
    if (completed.state !== 'accepted_waiting_source') throw new ToolError('SIGNING_REQUEST_FAILED');
  }
  return { request_id: created.request_id, input_digest: bundle.digest, input_size: bundle.size, version, source_sha: sourceSha, build_run_id: Number(runId) };
}

/** Writes the public hand-off file; it holds request identifiers only. */
export async function writeContext(result, { env = process.env } = {}) {
  const dir = path.join(runnerTemp(env), 'signing-request');
  await mkdir(dir, { mode: 0o700 });
  const context = {
    schema_version: 1,
    build_run_id: result.build_run_id,
    project_id: PROJECT_ID,
    request_id: result.request_id,
    input_digest: result.input_digest,
    input_size: result.input_size,
    version: result.version,
    source_sha: result.source_sha,
  };
  await writeFile(path.join(dir, 'request.json'), `${JSON.stringify(context, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return dir;
}

export async function main(args = process.argv.slice(2), { env = process.env, stderr = process.stderr, fetchImpl = fetch, sleep = defaultSleep, exec = defaultExec, signingOrigin } = {}) {
  try {
    if (args.length !== 1 || !['prepare', 'submit'].includes(args[0])) throw new ToolError('INVALID_COMMAND');
    if (args[0] === 'prepare') {
      const { workDir, version } = await prepare({ env, exec });
      await writeOutputs(env, { work_dir: workDir, version });
    } else {
      const result = await submitSource({ env, fetchImpl, sleep, signingOrigin });
      await writeOutputs(env, { request_id: result.request_id, context_dir: await writeContext(result, { env }) });
    }
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof ToolError ? error.code : 'SUBMIT_FAILED'}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
