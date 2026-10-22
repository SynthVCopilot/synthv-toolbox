import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';

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
