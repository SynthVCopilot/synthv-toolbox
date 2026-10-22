import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Moves the data folder from its pre-Toneshuttle name to the current one. It runs synchronously before
 * app.setPath("userData") and the single-instance lock, because Chromium creates the folder as soon as either reads it.
 *
 * The folder is renamed as a whole, never copied or linked: the credential key, Chromium's cookie key ("Local State"),
 * hard links, the Python venv and the Hugging Face caches all survive a rename, and several services refuse
 * symlinked sub-folders. A still-running older version is detected before the move (Chromium's lock in the old
 * folder) and, on Windows, by the rename itself failing while files inside are open. The old folder is then used for
 * this launch and the move is retried on the next one.
 */

/** Written into the data folder just before it moves, so path fix-ups resume if the app stops right after the move. */
export const MIGRATION_MARKER = ".toneshuttle-migration.json";
/** Serializes concurrent starts of the new version, which would otherwise race on the same move. */
const LOCK_DIRECTORY = ".toneshuttle-migration.lock";
/**
 * How long a start waits for another start's migration. Moves take well under a second, so this only matters when the
 * first start is slow; afterwards the waiting start reaches the single-instance lock and hands its window to the first.
 */
const LOCK_WAIT_MS = 120_000;
/** A lock without a readable owner pid (its owner crashed before writing it) is stale after this. */
const LOCK_STALE_MS = 30000;
/** Even a live owner pid stops counting after this: a rename and a few JSON rewrites never take that long, but a reused pid could. */
const LOCK_LIVE_OWNER_MAX_MS = 10 * 60 * 1000;
/** Entries only this app writes. A folder holding none of them has no user data, whatever Chromium left in it. */
const APP_DATA_ENTRIES = ["desktop-settings.json", "ai", "synthv", "runtime", "creative", "components", MIGRATION_MARKER];
/** JSON files that store absolute paths inside the data folder and read them back (retry, resume, reveal). */
const PATH_FILES = ["desktop-settings.json", "components/ffmpeg.json", "creative/creative-history/entries.json", "creative/project-checkpoints/entries.json"];
const PATH_FILE_GLOBS: ReadonlyArray<[string, RegExp, string?]> = [["creative/cover-jobs", /^[0-9a-f-]{36}\.json$/u], ["creative/cover-jobs", /^[0-9a-f-]{36}$/u, "result.json"], ["creative/cover-score", /^[\w-]+$/u, "state.json"]];
const RETRY_DELAYS_MS = [100, 200, 400, 800];
const BUSY_CODES = ["EPERM", "EBUSY", "EACCES"];
/** Fix-ups that keep failing for a transient reason are given up after this many starts. */
const MAX_FIXUP_ATTEMPTS = 3;

export type DeferredReason = "running" | "in-use" | "error";

export interface DataDirectoryOptions {
  appData: string;
  name: string;
  legacyNames: readonly string[];
  /** Development runs pass false and keep sharing the legacy folder with an installed older build. */
  migrate: boolean;
  appVersion: string;
  platform?: NodeJS.Platform;
  sleep?: (milliseconds: number) => void;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => Date;
  /** Creates the migration lock; tests make it fail like a folder antivirus briefly denies. */
  createDirectory?: (path: string) => void;
  /** Removes the migration lock; tests make it fail like a file that antivirus or an indexer holds. */
  removeDirectory?: (path: string) => void;
}

export interface DataDirectoryDecision {
  path: string;
  /** The legacy folder this launch moved the data from. */
  migratedFrom?: string;
  /** Why the legacy folder is still in use for this launch; the move is retried next time. */
  deferred?: { reason: DeferredReason; detail: string };
  /** A legacy folder that still holds app data beside the current one. It is never merged automatically. */
  legacyRemaining?: string;
  /** Where a pre-existing folder without app data, found at the new name, was moved before the data took its place. */
  setAside?: string;
  /** Files whose stored paths could not be rewritten after the move. */
  fixupErrors?: string[];
  /** Another start of the app is still moving the folder; this one must exit rather than open it half migrated. */
  busy?: boolean;
}

interface MigrationMarker { from: string; to: string; at: string; appVersion: string; fixups: "pending" | "done"; attempts?: number; errors?: string[] }

export function resolveUserDataDirectory(options: DataDirectoryOptions): DataDirectoryDecision {
  const target = join(options.appData, options.name);
  const legacy = findLegacy(options);
  if (!options.migrate) return { path: holdsAppData(target) || !legacy ? target : legacy };
  const marker = readMarker(target);
  const pending = marker?.fixups === "pending";
  // Records whose paths could not be rewritten stay broken, so Settings keeps listing them on every start.
  if (holdsAppData(target) && !pending) return { path: target, ...(legacy ? { legacyRemaining: legacy } : {}), ...(marker?.errors?.length ? { fixupErrors: marker.errors } : {}) };
  if (!legacy && !pending) return { path: target };
  return withMigrationLock(options, target, () => migrate(options, target));
}

/** Runs under the lock, so everything is evaluated again: another start may have finished the move while this one waited. */
function migrate(options: DataDirectoryOptions, target: string): DataDirectoryDecision {
  const legacy = findLegacy(options);
  let setAside: string | undefined;
  // When the move does not happen, a folder set aside for it goes back under its own name; only if that fails too does the
  // decision report where it is, since a later successful move would no longer know about it.
  const putBack = (): { setAside?: string } => {
    if (!setAside) return {};
    try { if (!existsSync(target)) { renameSync(setAside, target); return {}; } } catch { /* reported below */ }
    return { setAside };
  };
  try {
    if (holdsAppData(target)) {
      const fixupErrors = resumeFixups(target, options);
      return { path: target, ...(legacy ? { legacyRemaining: legacy } : {}), ...(fixupErrors.length ? { fixupErrors } : {}) };
    }
    if (!legacy) return { path: target };
    const running = liveInstance(legacy, options);
    if (running) return { path: legacy, deferred: { reason: "running", detail: running } };
    setAside = clearTarget(target, options);
    const aside = setAside ? { setAside } : {};
    // The marker moves with the folder, so a stop between the rename and the fix-ups still leaves them resumable.
    writeMarker(legacy, { from: legacy, to: target, at: now(options).toISOString(), appVersion: options.appVersion, fixups: "pending", attempts: 0 }, options);
    const failure = renameWithRetry(legacy, target, options);
    if (failure) {
      rmSync(join(legacy, MIGRATION_MARKER), { force: true });
      return { path: legacy, deferred: failure, ...putBack() };
    }
    const fixupErrors = resumeFixups(target, options);
    return { path: target, migratedFrom: legacy, ...aside, ...(fixupErrors.length ? { fixupErrors } : {}) };
  } catch (error) {
    // Never block startup. If the folder already moved, say so rather than promising a retry that cannot happen.
    if (legacy && !existsSync(legacy) && holdsAppData(target)) return { path: target, migratedFrom: legacy, fixupErrors: [message(error)], ...(setAside ? { setAside } : {}) };
    const path = holdsAppData(target) || !legacy ? target : legacy;
    return { path, deferred: { reason: "error", detail: message(error) }, ...putBack() };
  }
}

function findLegacy(options: DataDirectoryOptions): string | undefined {
  return options.legacyNames.map(name => join(options.appData, name)).find(holdsAppData);
}

function holdsAppData(path: string): boolean {
  try { return readdirSync(path).some(entry => APP_DATA_ENTRIES.includes(entry)); } catch { return false; }
}

function withMigrationLock(options: DataDirectoryOptions, target: string, work: () => DataDirectoryDecision): DataDirectoryDecision {
  const lock = join(options.appData, LOCK_DIRECTORY);
  const sleep = options.sleep ?? sleepSync;
  for (let waited = 0; ; waited += 100) {
    try { (options.createDirectory ?? mkdirSync)(lock); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        // The lock is what keeps two starts from racing the rename; without it this start keeps the old folder and a later
        // start moves it.
        console.warn(`Could not create the data-folder migration lock at ${lock}:`, error);
        const legacy = findLegacy(options);
        return { path: holdsAppData(target) || !legacy ? target : legacy, deferred: { reason: "in-use", detail: "The data-folder migration lock could not be created yet." } };
      }
      if (staleLock(lock, options)) {
        // Antivirus or an indexer may still hold part of the dead start's lock; the move waits for a later start.
        try { (options.removeDirectory ?? removeWithRetries)(lock); continue; } catch (error) {
          console.warn(`Could not remove the stale data-folder migration lock at ${lock}:`, error);
          const legacy = findLegacy(options);
          return { path: holdsAppData(target) || !legacy ? target : legacy, deferred: { reason: "in-use", detail: "A lock left by an earlier start could not be removed yet." } };
        }
      }
      if (waited >= LOCK_WAIT_MS) {
        const legacy = findLegacy(options);
        return { path: holdsAppData(target) || !legacy ? target : legacy, deferred: { reason: "in-use", detail: "Another start of the app is moving the data folder." }, busy: true };
      }
      sleep(100);
    }
  }
  try {
    writeFileSync(join(lock, "owner"), String(process.pid));
    return work();
  } finally {
    // The work is done (or failed on its own); a lock that cannot be removed right now (antivirus, an indexer) is left for
    // the next start to find stale, never a reason to stop this one.
    try { (options.removeDirectory ?? removeWithRetries)(lock); } catch (error) { console.warn(`Could not remove the data-folder migration lock at ${lock}:`, error); }
  }
}

function removeWithRetries(path: string): void { rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }

function staleLock(lock: string, options: DataDirectoryOptions): boolean {
  let age: number;
  try { age = Date.now() - statSync(lock).mtimeMs; } catch { return true; }
  let owner = 0;
  try { owner = Number(readFileSync(join(lock, "owner"), "utf8")); } catch { /* the owner may not have written its pid yet */ }
  // A live owner may be moving a large profile on a slow disk; breaking its lock would run two moves at once.
  if (Number.isSafeInteger(owner) && owner > 0) return !(options.isProcessAlive ?? processAlive)(owner) || age > LOCK_LIVE_OWNER_MAX_MS;
  return age > LOCK_STALE_MS;
}

function liveInstance(folder: string, options: DataDirectoryOptions): string | undefined {
  if ((options.platform ?? process.platform) === "win32") {
    // Chromium keeps <userData>\lockfile open without write sharing while it runs. Checking it directly also covers a
    // junctioned data folder, which Windows renames even while files behind it are open.
    let handle: number;
    try { handle = openSync(join(folder, "lockfile"), "r+"); } catch (error) {
      return BUSY_CODES.includes((error as NodeJS.ErrnoException).code ?? "") ? "An older version is still running." : undefined;
    }
    closeSync(handle);
    return undefined;
  }
  // macOS and Linux let a folder be renamed under a running process, so Chromium's SingletonLock ("<host>-<pid>") is
  // checked instead. The host part is ignored: macOS host names change with the network, and deferring is always safe.
  let owner: string;
  try { owner = readlinkSync(join(folder, "SingletonLock")); } catch { return undefined; }
  const pid = Number(/-(\d+)$/u.exec(owner)?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return (options.isProcessAlive ?? processAlive)(pid) ? `An older version is still running (process ${pid}).` : undefined;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The target can exist without app data, e.g. an empty folder; an empty one is removed and anything else is set aside. */
function clearTarget(target: string, options: DataDirectoryOptions): string | undefined {
  let entries: string[];
  try { entries = readdirSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (entries.some(entry => APP_DATA_ENTRIES.includes(entry))) throw new Error(`${target} already holds app data.`);
  if (!entries.length) { rmdirSync(target); return undefined; }
  const aside = `${target}.before-migration-${now(options).toISOString().replace(/[:.]/gu, "-")}`;
  renameSync(target, aside);
  return aside;
}

function renameWithRetry(from: string, to: string, options: DataDirectoryOptions): { reason: DeferredReason; detail: string } | undefined {
  const sleep = options.sleep ?? sleepSync;
  for (let attempt = 0; ; attempt += 1) {
    try { renameSync(from, to); return undefined; } catch (error) {
      const busy = BUSY_CODES.includes((error as NodeJS.ErrnoException).code ?? "");
      if (!busy || attempt >= RETRY_DELAYS_MS.length) return { reason: busy ? "in-use" : "error", detail: message(error) };
      sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

function sleepSync(milliseconds: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }
function now(options: DataDirectoryOptions): Date { return (options.now ?? (() => new Date()))(); }

function readMarker(folder: string): MigrationMarker | undefined {
  try { return JSON.parse(readFileSync(join(folder, MIGRATION_MARKER), "utf8")) as MigrationMarker; } catch { return undefined; }
}

function writeMarker(folder: string, marker: MigrationMarker, options: DataDirectoryOptions): void {
  writeAtomic(join(folder, MIGRATION_MARKER), `${JSON.stringify(marker, null, 2)}\n`, options);
}

function resumeFixups(folder: string, options: DataDirectoryOptions): string[] {
  const marker = readMarker(folder);
  if (marker?.fixups !== "pending") return marker?.errors ?? [];
  const { errors, retryable } = rewriteStoredPaths(folder, marker.from, marker.to, options);
  const attempts = (marker.attempts ?? 0) + 1;
  // A record held open by an indexer or antivirus is retried on later starts; a broken record is not.
  const fixups = retryable && attempts < MAX_FIXUP_ATTEMPTS ? "pending" : "done";
  const { errors: _previous, ...rest } = marker;
  writeMarker(folder, { ...rest, fixups, attempts, ...(errors.length ? { errors } : {}) }, options);
  return errors;
}

/** Rewrites string values that start with the old folder path. Free text that merely mentions a path is left alone. */
function rewriteStoredPaths(folder: string, from: string, to: string, options: DataDirectoryOptions): { errors: string[]; retryable: boolean } {
  const platform = options.platform ?? process.platform;
  const errors: string[] = [];
  let retryable = false;
  for (const file of pathFiles(folder)) {
    try {
      if (!lstatSync(file).isFile()) continue;
      const text = readFileSync(file, "utf8");
      let changed = false;
      const value = relocateValue(JSON.parse(text), from, to, platform, () => { changed = true; });
      if (changed) writeAtomic(file, JSON.stringify(value, null, /\n\s/u.test(text) ? 2 : undefined), options);
    } catch (error) {
      retryable ||= BUSY_CODES.includes((error as NodeJS.ErrnoException).code ?? "");
      errors.push(`${relative(folder, file)}: ${message(error)}`);
    }
  }
  return { errors, retryable };
}

function pathFiles(folder: string): string[] {
  const files = PATH_FILES.map(file => join(folder, file)).filter(file => existsSync(file));
  for (const [directory, pattern, child] of PATH_FILE_GLOBS) {
    let entries: string[];
    try { entries = readdirSync(join(folder, directory)); } catch { continue; }
    for (const entry of entries) if (pattern.test(entry)) {
      const file = child ? join(folder, directory, entry, child) : join(folder, directory, entry);
      if (existsSync(file)) files.push(file);
    }
  }
  return files;
}

export function relocatePath(value: string, from: string, to: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const windows = platform === "win32";
  const normalize = (path: string) => windows ? path.replaceAll("/", "\\").toLowerCase() : path;
  if (value.length < from.length || normalize(value.slice(0, from.length)) !== normalize(from)) return undefined;
  const rest = value.slice(from.length);
  // "...\\synthv-toolbox-other" shares the prefix but is a different folder.
  if (rest && !(windows ? /^[\\/]/u : /^\//u).test(rest)) return undefined;
  return to + rest;
}

function relocateValue(value: unknown, from: string, to: string, platform: NodeJS.Platform, changed: () => void): unknown {
  if (typeof value === "string") {
    const moved = relocatePath(value, from, to, platform);
    if (moved === undefined) return value;
    changed();
    return moved;
  }
  if (Array.isArray(value)) return value.map(item => relocateValue(item, from, to, platform, changed));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocateValue(item, from, to, platform, changed)]));
  return value;
}

/** Windows refuses to replace a file another process has open (indexers, antivirus), so the final rename is retried. */
function writeAtomic(file: string, text: string, options: DataDirectoryOptions): void {
  const temporary = `${file}.${process.pid}.migrating`;
  const sleep = options.sleep ?? sleepSync;
  try {
    writeFileSync(temporary, text, { mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      try { renameSync(temporary, file); return; } catch (error) {
        if (!BUSY_CODES.includes((error as NodeJS.ErrnoException).code ?? "") || attempt >= 2) throw error;
        sleep(50 * (attempt + 1));
      }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
