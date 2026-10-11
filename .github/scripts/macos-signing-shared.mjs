import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';

export const PROJECT_ID = 'synthv-toolbox-arm64';
export const BUNDLE_ID = 'com.synthvcopilot.toolbox';
export const APP = 'Synthesizer V Toolbox.app';
export const ARCH = 'arm64';
export const TEAM_ID = '76DMUAK6J5';
export const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA = /^[a-f0-9]{40}$/;
export const ARCHIVE_DIGEST = /^sha256:[a-f0-9]{64}$/;
export const MAX_JSON_BYTES = 1_000_000;

export class ToolError extends Error {
  constructor(code, { detail = '', transient = false } = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
    this.transient = transient;
  }
}

export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const isTransientStatus = (status) => status === 408 || status === 429 || status >= 500;

export function requireRunId(value) {
  if (!/^[1-9]\d*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) throw new ToolError('INVALID_RUN_ID');
  return String(Number(value));
}

export function requireFirstAttempt(env) {
  if (env.GITHUB_RUN_ATTEMPT !== '1') throw new ToolError('INVALID_RUN_ATTEMPT');
}

export function stableVersion(tag) {
  const match = STABLE_TAG.exec(tag ?? '');
  if (!match) throw new ToolError('TAG_NOT_STABLE');
  return match[1];
}

/** Returns the origin-only signing center URL joined with the requests path. */
export function signEndpoint(env) {
  const origin = (env.SIGNING_URL ?? '').replace(/\/+$/, '');
  const secure = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(origin);
  // The loopback form lets contract tests run against a local mock server.
  const loopback = /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);
  if (!secure && !loopback) throw new ToolError('SIGNING_URL_INVALID');
  return `${origin}/v1/requests`;
}

export async function writeOutputs(env, values) {
  const entries = Object.entries(values).map(([key, value]) => [key, String(value)]);
  if (!env.GITHUB_OUTPUT || entries.some(([, value]) => /[\r\n]/.test(value))) throw new ToolError('OUTPUT_UNAVAILABLE');
  await writeFile(env.GITHUB_OUTPUT, entries.map(([key, value]) => `${key}=${value}\n`).join(''), { flag: 'a', mode: 0o600 });
}

export async function hashFile(file, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  let size = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { hash, size };
}

export async function readJsonBody(response, code) {
  if (!response.body) throw new ToolError(code);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_JSON_BYTES) throw new ToolError(code);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { throw new ToolError(code); }
}

const CONTEXT_KEYS = ['schema_version', 'build_run_id', 'project_id', 'request_id', 'input_digest', 'input_size', 'version', 'source_sha'];

/** Strict shape of the public hand-off file between the build and publish workflows. */
export function validateContext(value) {
  const plain = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!plain || Object.keys(value).length !== CONTEXT_KEYS.length || !CONTEXT_KEYS.every((key) => Object.hasOwn(value, key))
    || value.schema_version !== 1 || !Number.isSafeInteger(value.build_run_id) || value.build_run_id < 1
    || value.project_id !== PROJECT_ID || typeof value.request_id !== 'string' || !UUID.test(value.request_id)
    || typeof value.input_digest !== 'string' || !ARCHIVE_DIGEST.test(value.input_digest)
    || !Number.isSafeInteger(value.input_size) || value.input_size < 1
    || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version)
    || typeof value.source_sha !== 'string' || !SHA.test(value.source_sha)) throw new ToolError('CONTEXT_INVALID');
  return Object.fromEntries(CONTEXT_KEYS.map((key) => [key, value[key]]));
}
