import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

type Data = Record<string, unknown>;
type TargetReport = { target: string; status: "migrated" | "skipped" | "invalid"; keys: number; reason?: string };
export type LegacyMigrationReport = { sourcePath: string; sourcePreserved: true; status: "completed" | "source_missing" | "invalid_source"; migrated: TargetReport[]; ignoredSecretKeys: number; detail?: string };

const SECRET_KEY = /(secret|token|password|passwd|api[-_]?key|access[-_]?key|refresh[-_]?token|oauth|credential|private[-_]?key|authorization)/i;
const DESKTOP_KEYS = new Set(["onboardingCompleted", "mode", "agentWorkMode", "updateChannel", "scriptsPath", "concurrentDisclaimerAccepted", "sv2ConcurrentEnabled", "sv2AccountIndicatorEnabled", "smartSvpLaunchEnabled", "smartSvpAlwaysAsk", "mcpServers"]);
const RUNTIME_KEYS = new Set(["pluginInternalFunctionsEnabled", "pluginAdvancedFunctionsEnabled", "mcpInternalFunctionsEnabled", "mcpAdvancedFunctionsEnabled", "httpApiEnabled", "httpAgentEnabled", "httpApiPort"]);

export async function migrateLegacySettings(legacyRoot: string, userData: string): Promise<LegacyMigrationReport> {
  const sourcePath = resolve(legacyRoot, "toolbox.json");
  try { await access(sourcePath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sourcePath, sourcePreserved: true, status: "source_missing", migrated: [], ignoredSecretKeys: 0, detail: "Legacy settings file was not found." }; throw error; }
  let raw: unknown;
  try { raw = JSON.parse(await readFile(sourcePath, "utf8")); } catch (error) { return { sourcePath, sourcePreserved: true, status: "invalid_source", migrated: [], ignoredSecretKeys: 0, detail: error instanceof Error ? error.message : String(error) }; }
  if (!isRecord(raw)) return { sourcePath, sourcePreserved: true, status: "invalid_source", migrated: [], ignoredSecretKeys: 0, detail: "Legacy settings must be a JSON object." };

  let ignoredSecretKeys = 0;
  const sanitize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sanitize).filter(item => item !== undefined);
    if (!isRecord(value)) return value;
    const result: Data = {};
    for (const [key, item] of Object.entries(value)) { if (SECRET_KEY.test(key)) { ignoredSecretKeys += 1; continue; } const clean = sanitize(item); if (clean !== undefined) result[key] = clean; }
    return result;
  };
  const root = sanitize(raw) as Data;
  const desktopInput = objectAt(root, "desktop") ?? root;
  const runtimeInput = objectAt(root, "runtime") ?? root;
  const componentsInput = objectAt(root, "components") ?? root;
  const desktop = pick(desktopInput, DESKTOP_KEYS);
  const runtime = pick(runtimeInput, RUNTIME_KEYS);
  const ffmpegValue = firstDefined(componentsInput.ffmpegDirectory, componentsInput.ffmpegPath, componentsInput.directory, root.ffmpegDirectory, root.ffmpegPath);
  const migrated: TargetReport[] = [];
  migrated.push(await migrateTarget(join(userData, "desktop-settings.json"), validateDesktop(desktop)));
  migrated.push(await migrateTarget(join(userData, "runtime", "runtime-settings.json"), validateRuntime(runtime)));
  migrated.push(await migrateTarget(join(userData, "components", "ffmpeg.json"), await validateFfmpeg(ffmpegValue)));
  return { sourcePath, sourcePreserved: true, status: "completed", migrated, ignoredSecretKeys };
}

async function migrateTarget(target: string, value: { value?: Data; reason?: string }): Promise<TargetReport> {
  if (value.reason) return { target, status: "invalid", keys: 0, reason: value.reason };
  if (!value.value || !Object.keys(value.value).length) return { target, status: "skipped", keys: 0, reason: "No supported non-secret settings found." };
  try { await access(target); return { target, status: "skipped", keys: 0, reason: "Target already exists; migration never overwrites it." }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value.value, null, 2), { encoding: "utf8", mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, target); return { target, status: "migrated", keys: Object.keys(value.value).length }; }
  finally { await rm(temporary, { force: true }); }
}

function validateDesktop(value: Data): { value?: Data; reason?: string } {
  const output: Data = {};
  for (const key of DESKTOP_KEYS) if (key in value) {
    const item = value[key];
    if (["onboardingCompleted", "concurrentDisclaimerAccepted", "sv2ConcurrentEnabled", "sv2AccountIndicatorEnabled", "smartSvpLaunchEnabled", "smartSvpAlwaysAsk"].includes(key) && typeof item !== "boolean") return { reason: `${key} must be boolean.` };
    if (key === "mode" && item !== "toolbox" && item !== "ai") return { reason: "mode must be toolbox or ai." };
    if (key === "agentWorkMode" && item !== "edit" && item !== "solo") return { reason: "agentWorkMode must be edit or solo." };
    if (key === "updateChannel" && item !== "stable" && item !== "nightly") return { reason: "updateChannel must be stable or nightly." };
    if (key === "scriptsPath" && (typeof item !== "string" || !item.trim())) return { reason: "scriptsPath must be a non-empty string." };
    if (key === "mcpServers" && (!Array.isArray(item) || !item.every(isRecord))) return { reason: "mcpServers must be an array of objects." };
    output[key] = item;
  }
  return { value: output };
}

function validateRuntime(value: Data): { value?: Data; reason?: string } {
  const output: Data = {};
  for (const key of RUNTIME_KEYS) if (key in value) {
    const item = value[key];
    if (key === "httpApiPort") { if (typeof item !== "number" || !Number.isInteger(item) || item < 1024 || item > 65535) return { reason: "httpApiPort must be an integer between 1024 and 65535." }; }
    else if (typeof item !== "boolean") return { reason: `${key} must be boolean.` };
    output[key] = item;
  }
  return { value: output };
}

async function validateFfmpeg(value: unknown): Promise<{ value?: Data; reason?: string }> {
  if (value === undefined || value === null || value === "") return { value: {} };
  if (typeof value !== "string" || !value.trim()) return { reason: "FFmpeg directory must be a non-empty string." };
  const directory = resolve(value);
  try { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) return { reason: "FFmpeg directory must be a real directory." }; } catch { return { reason: "FFmpeg directory does not exist." }; }
  const suffix = process.platform === "win32" ? ".exe" : "";
  try { await Promise.all([access(join(directory, `ffmpeg${suffix}`)), access(join(directory, `ffprobe${suffix}`))]); } catch { return { reason: "FFmpeg directory must contain both ffmpeg and ffprobe." }; }
  return { value: { directory } };
}

function pick(value: Data, keys: Set<string>): Data { const output: Data = {}; for (const key of keys) if (key in value) output[key] = value[key]; return output; }
function objectAt(value: Data, key: string): Data | undefined { return isRecord(value[key]) ? value[key] as Data : undefined; }
function firstDefined(...values: unknown[]): unknown { return values.find(value => value !== undefined); }
function isRecord(value: unknown): value is Data { return value !== null && typeof value === "object" && !Array.isArray(value); }
