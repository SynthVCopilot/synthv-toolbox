/**
 * Renaming the product renames the Windows executable. A launch-at-login entry written by the old build keeps
 * pointing at an executable the installer removed, while Electron reports autostart as off, so the user silently
 * loses the setting. The "--toolbox-autostart" argument identifies entries this app wrote.
 */
export const AUTOSTART_ARGUMENT = "--toolbox-autostart";
export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

export interface RunKeyEntry { name: string; command: string }

export interface AutostartMigrationPorts {
  execPath: string;
  queryRunKey(): Promise<string>;
  removeRunValue(name: string): Promise<void>;
  enableAutostart(): Promise<unknown>;
  fileExists(path: string): boolean;
}

/** Parses `reg query <key>` output: one "    <name>    REG_SZ    <data>" line per value. */
export function parseRunKey(output: string): RunKeyEntry[] {
  return output.split(/\r?\n/).flatMap(line => {
    const match = /^\s{2,}(.+?)\s{2,}REG_(?:EXPAND_)?SZ\s{2,}(.*)$/.exec(line);
    return match ? [{ name: match[1], command: match[2].trim() }] : [];
  });
}

export function executableOf(command: string): string {
  if (command.startsWith("\"")) return command.slice(1, command.indexOf("\"", 1) > 0 ? command.indexOf("\"", 1) : undefined);
  const exe = command.toLowerCase().indexOf(".exe");
  return exe >= 0 ? command.slice(0, exe + 4) : command.split(" ")[0];
}

export function staleAutostartEntries(entries: RunKeyEntry[], execPath: string, fileExists: (path: string) => boolean): RunKeyEntry[] {
  return entries.filter(entry => {
    // reg.exe prints in the OEM code page; a path that did not survive decoding cannot be judged, so it is never treated as stale.
    if (!entry.command.includes(AUTOSTART_ARGUMENT) || /\uFFFD/.test(entry.command + entry.name)) return false;
    const executable = executableOf(entry.command);
    return executable.toLowerCase() !== execPath.toLowerCase() && !fileExists(executable);
  });
}

/** Replaces stale entries with one for the running executable. Removal comes first because the new entry may reuse the old value name. */
export async function migrateAutostart(ports: AutostartMigrationPorts): Promise<string[]> {
  const stale = staleAutostartEntries(parseRunKey(await ports.queryRunKey()), ports.execPath, ports.fileExists);
  if (!stale.length) return [];
  for (const entry of stale) await ports.removeRunValue(entry.name);
  await ports.enableAutostart();
  return stale.map(entry => entry.name);
}
