import { lstat, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const safeSegment = /^[A-Za-z0-9._-]+$/;
const artifactId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function resolvePluginResource(root: string, rawUrl: string): Promise<string | undefined> {
  const url = parseLocalUrl(rawUrl, "toolbox-plugin");
  if (!url) return undefined;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2 || !segments.every(segment => safeSegment.test(segment))) return undefined;
  return resolveManagedFile(root, segments);
}

export async function resolveAudioResource(root: string, rawUrl: string, lookup: (id: string) => string | undefined): Promise<string | undefined> {
  const url = parseLocalUrl(rawUrl, "toolbox-audio");
  if (!url) return undefined;
  const id = url.pathname.slice(1);
  if (!artifactId.test(id) || url.pathname.includes("/", 1)) return undefined;
  const candidate = lookup(id);
  if (!candidate) return undefined;
  return resolveManagedFile(root, relative(root, candidate).split(sep));
}

function parseLocalUrl(rawUrl: string, scheme: string): URL | undefined {
  try {
    const url = new URL(rawUrl);
    return url.protocol === `${scheme}:` && url.hostname === "localhost" && !url.search && !url.hash ? url : undefined;
  } catch { return undefined; }
}

async function resolveManagedFile(root: string, segments: string[]): Promise<string | undefined> {
  if (!segments.length || segments.some(segment => !safeSegment.test(segment))) return undefined;
  const configuredRoot = resolve(root);
  try {
    const rootMetadata = await lstat(configuredRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return undefined;
    const canonicalRoot = await realpath(configuredRoot);
    let current = configuredRoot;
    for (const segment of segments) {
      current = resolve(current, segment);
      if (!within(configuredRoot, current)) return undefined;
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) return undefined;
    }
    const metadata = await lstat(current);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    const canonical = await realpath(current);
    return within(canonicalRoot, canonical) ? canonical : undefined;
  } catch { return undefined; }
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && !path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep);
}
