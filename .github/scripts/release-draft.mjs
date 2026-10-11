import { access } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ToolError, stableVersion } from './macos-signing-shared.mjs';
import { assetNames } from './publish-macos.mjs';

/** Every asset a stable release must carry before it is announced to the updaters. */
export function requiredAssets(version) {
  const macos = assetNames(version);
  return [
    'latest.yml', `Synthesizer-V-Toolbox-${version}-setup.exe`,
    macos.metadata, macos.dmg, macos.zip,
  ];
}

function defaultGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  if (result.error || result.status !== 0) throw new ToolError('GH_FAILED');
  return String(result.stdout ?? '');
}

/** Creates the draft release for the tag unless a leg that ran earlier already did. */
export async function ensureDraft({ env = process.env, gh = defaultGh } = {}) {
  const tag = env.INPUT_TAG;
  stableVersion(tag);
  try { gh(['release', 'view', tag, '--json', 'isDraft']); return 'exists'; } catch { /* created below */ }
  const notesFile = path.join(env.GITHUB_WORKSPACE ?? '.', 'docs', 'releases', `${tag}.md`);
  const notes = await access(notesFile).then(() => ['--notes-file', notesFile], () => ['--generate-notes']);
  try { gh(['release', 'create', tag, '--draft', '--verify-tag', '--title', tag, ...notes]); return 'created'; } catch {
    // The other platform's workflow can win the race to create it.
    gh(['release', 'view', tag, '--json', 'isDraft']);
    return 'exists';
  }
}

/** Publishes the draft once both platforms have uploaded everything; otherwise leaves it for the later leg. */
export function promote({ env = process.env, gh = defaultGh, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const tag = env.INPUT_TAG;
  const version = stableVersion(tag);
  const release = JSON.parse(gh(['release', 'view', tag, '--json', 'isDraft,assets']));
  if (!release.isDraft) return 'published';
  const present = new Set((release.assets ?? []).map((asset) => asset.name));
  const missing = requiredAssets(version).filter((name) => !present.has(name));
  if (missing.length > 0) {
    log(`waiting for: ${missing.join(', ')}`);
    return 'waiting';
  }
  gh(['release', 'edit', tag, '--draft=false', '--latest']);
  return 'published';
}

export async function main(args = process.argv.slice(2), { env = process.env, stderr = process.stderr, gh = defaultGh, log } = {}) {
  try {
    if (args.length !== 1 || !['ensure', 'promote'].includes(args[0])) throw new ToolError('INVALID_COMMAND');
    if (args[0] === 'ensure') await ensureDraft({ env, gh });
    else promote({ env, gh, ...(log ? { log } : {}) });
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof ToolError ? error.code : 'RELEASE_FAILED'}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
