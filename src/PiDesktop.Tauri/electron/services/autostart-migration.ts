import { win32 } from "node:path";

// Windows-only logic; win32 paths keep it correct when tests run on macOS or Linux.
const { dirname, join } = win32;

/**
 * Renaming the Windows executable leaves the launch-at-login entry of the old build pointing at a file the installer
 * removed, while Electron reports autostart as off, so the user silently loses the setting. This moves such entries to
 * the running executable and keeps whether the user had disabled them in Task Manager.
 *
 * Entries are found through Electron's login-item API rather than by parsing `reg query`, whose output is in the OEM
 * code page and garbles profile paths with non-ASCII user names.
 */
export const AUTOSTART_ARGUMENT = "--toolbox-autostart";

/** One Run-key entry as Electron reports it; `path` is the executable parsed out of the stored command line. */
export interface LaunchItem { name: string; path: string; scope: "user" | "machine"; enabled: boolean }

export interface AutostartMigrationPorts {
  execPath: string;
  /** Where the old executable lived: beside the new one, in the old folder next to it, or in the default old folder. */
  legacyExecutables: readonly string[];
  fileExists(path: string): boolean;
  /** Run-key entries whose executable is `path`, whatever their arguments. */
  launchItems(path: string): LaunchItem[];
  remove(name: string): void;
  register(enabled: boolean): void;
}

export function legacyExecutableCandidates(execPath: string, legacy: { windowsExecutable: string; windowsInstallDirectory: string }, localAppData?: string): string[] {
  const folder = dirname(execPath);
  const candidates = [join(folder, legacy.windowsExecutable), join(dirname(folder), legacy.windowsInstallDirectory, legacy.windowsExecutable)];
  // An upgrade installed elsewhere with /D= still replaced an old install in the default per-user folder.
  if (localAppData) candidates.push(join(localAppData, "Programs", legacy.windowsInstallDirectory, legacy.windowsExecutable));
  return candidates.filter((candidate, index) => candidates.findIndex(other => sameFile(other, candidate)) === index && !sameFile(candidate, execPath));
}

/**
 * Electron parses the lookup path as a command line, so an unquoted path stops at its first space: "...\Synthesizer V
 * Toolbox.exe" would be looked up as "...\Synthesizer" and could even match another app's unquoted entry.
 */
export function loginItemLookupPath(path: string): string {
  return `"${path}"`;
}

/** Returns the names of the entries it replaced. Removal comes first because the new entry may reuse the old value name. */
export function migrateAutostart(ports: AutostartMigrationPorts): string[] {
  const replaced: string[] = [];
  let enabled = false;
  for (const executable of ports.legacyExecutables) {
    // An old executable that still exists belongs to another install, which keeps its own entry.
    if (sameFile(executable, ports.execPath) || ports.fileExists(executable)) continue;
    for (const item of ports.launchItems(executable)) {
      // Only entries that start the old executable are ours. Machine-wide entries need elevation and were never ours.
      if (item.scope !== "user" || !sameFile(item.path, executable)) continue;
      ports.remove(item.name);
      replaced.push(item.name);
      enabled ||= item.enabled;
    }
  }
  if (replaced.length) ports.register(enabled);
  return replaced;
}

function sameFile(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }
