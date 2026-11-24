import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AiProviderId, CredentialKind } from "./ai-service.js";

type Data = Record<string, unknown>;

export interface LegacyAiCredentialInput {
  id: string;
  provider: AiProviderId;
  kind: CredentialKind;
  label: string;
  models: string[];
  enabled: boolean;
  weight: number;
  active: boolean;
  expiresAt?: number;
  secret: string;
}

export interface LegacyAiCredentialMigrationReport {
  status: "completed" | "already_completed" | "source_missing";
  sourcePreserved: true;
  migrated: number;
  skipped: number;
  unsupported: number;
}

type LegacyCredentialImporter = (input: LegacyAiCredentialInput) => Promise<boolean>;

const OAUTH_SERVICE = "com.synthvcopilot.toolbox.oauth";
const API_KEY_SERVICE = "com.synthvcopilot.toolbox.api-key";
const RECORD_MAGIC = Buffer.from("STC1");
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;

export async function migrateLegacyAiCredentials(
  legacyRoot: string,
  userData: string,
  importCredential: LegacyCredentialImporter,
  now: () => Date = () => new Date(),
): Promise<LegacyAiCredentialMigrationReport> {
  const sourceRoot = resolve(legacyRoot);
  const marker = join(resolve(userData), "ai", "legacy-credential-migration-v1.json");
  if (await safeRegularFile(marker, 64 * 1024, false)) {
    return { status: "already_completed", sourcePreserved: true, migrated: 0, skipped: 0, unsupported: 0 };
  }
  const settingsPath = join(sourceRoot, "toolbox.json");
  const settingsFile = await safeRegularFile(settingsPath, MAX_SETTINGS_BYTES, false);
  if (!settingsFile) return { status: "source_missing", sourcePreserved: true, migrated: 0, skipped: 0, unsupported: 0 };
  const settings = parseSettings(await readFile(settingsFile, "utf8"));
  const candidates = await readCandidates(sourceRoot, settings);
  let migrated = 0;
  let skipped = 0;
  for (const candidate of candidates.supported) {
    if (await importCredential(candidate)) migrated += 1;
    else skipped += 1;
  }
  const report = { status: "completed" as const, sourcePreserved: true as const, migrated, skipped, unsupported: candidates.unsupported };
  await writeMarker(marker, { schemaVersion: 1, completedAt: now().toISOString(), migrated, skipped, unsupported: candidates.unsupported });
  return report;
}

async function readCandidates(root: string, settings: Data): Promise<{ supported: LegacyAiCredentialInput[]; unsupported: number }> {
  const credentialsRoot = join(root, "credentials");
  const activeProvider = provider(settings.aiProvider);
  const supported: LegacyAiCredentialInput[] = [];
  let unsupported = 0;
  for (const value of array(settings.oauthAccounts)) {
    if (!isRecord(value)) continue;
    const selectedProvider = provider(value.provider);
    if (!selectedProvider || (selectedProvider !== "anthropic" && selectedProvider !== "openai-codex")) { unsupported += 1; continue; }
    const id = boundedString(value.id, "OAuth credential id", 512);
    const decrypted = await decryptRecord(credentialsRoot, OAUTH_SERVICE, id);
    try {
      const persisted = JSON.parse(decrypted.toString("utf8")) as unknown;
      if (!isRecord(persisted)) throw new Error("Legacy OAuth credential payload is invalid.");
      const refresh = boundedString(persisted.refresh, "OAuth refresh credential", 256 * 1024);
      const accountId = optionalString(persisted.accountId, 512);
      const model = selectedModel(settings, selectedProvider);
      supported.push({
        id,
        provider: selectedProvider,
        kind: "oauth",
        label: optionalString(value.label, 80) ?? providerLabel(selectedProvider),
        models: [model],
        enabled: value.enabled !== false,
        weight: weight(value.weight),
        active: selectedProvider === activeProvider,
        expiresAt: finiteNumber(value.expiresAt),
        secret: JSON.stringify({ type: "oauth", access: "", refresh, expires: 0, ...(accountId ? { accountId } : {}) }),
      });
    } finally {
      decrypted.fill(0);
    }
  }
  for (const [selectedProvider, key] of [["anthropic", "anthropicApiKeys"], ["openai-codex", "openaiApiKeys"]] as const) {
    for (const value of array(settings[key])) {
      if (!isRecord(value)) continue;
      const id = boundedString(value.id, "API key credential id", 512);
      const decrypted = await decryptRecord(credentialsRoot, API_KEY_SERVICE, id);
      try {
        const secret = boundedString(decrypted.toString("utf8"), "API key credential", 256 * 1024);
        const selected = selectedModel(settings, selectedProvider);
        const models = array(value.models).filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= 200);
        supported.push({
          id,
          provider: selectedProvider,
          kind: "api-key",
          label: optionalString(value.label, 80) ?? "API Key",
          models: [selected, ...models.filter(model => model !== selected)],
          enabled: value.enabled !== false,
          weight: weight(value.weight),
          active: selectedProvider === activeProvider,
          secret,
        });
      } finally {
        decrypted.fill(0);
      }
    }
  }
  return { supported, unsupported };
}

async function decryptRecord(root: string, service: string, id: string): Promise<Buffer> {
  const keyPath = await safeRegularFile(join(root, "key.bin"), KEY_BYTES, true);
  if (!keyPath || (await lstat(keyPath)).size !== KEY_BYTES) throw new Error("Legacy credential key is unavailable or invalid.");
  const digest = createHash("sha256").update(service).update(Buffer.from([0])).update(id).digest("hex");
  const recordPath = await safeRegularFile(join(root, `${digest}.bin`), MAX_RECORD_BYTES, true);
  if (!recordPath) throw new Error("Legacy credential record is unavailable.");
  const key = await readFile(keyPath);
  const record = await readFile(recordPath);
  try {
    if (record.length < RECORD_MAGIC.length + NONCE_BYTES + AUTH_TAG_BYTES || !record.subarray(0, RECORD_MAGIC.length).equals(RECORD_MAGIC)) {
      throw new Error("Legacy credential record format is invalid.");
    }
    const nonceStart = RECORD_MAGIC.length;
    const ciphertextStart = nonceStart + NONCE_BYTES;
    const tagStart = record.length - AUTH_TAG_BYTES;
    const decipher = createDecipheriv("aes-256-gcm", key, record.subarray(nonceStart, ciphertextStart));
    decipher.setAAD(Buffer.from(`${service}\0${id}`));
    decipher.setAuthTag(record.subarray(tagStart));
    return Buffer.concat([decipher.update(record.subarray(ciphertextStart, tagStart)), decipher.final()]);
  } catch (reason) {
    if (reason instanceof Error && reason.message.startsWith("Legacy credential")) throw reason;
    throw new Error("Legacy credential record could not be decrypted.");
  } finally {
    key.fill(0);
    record.fill(0);
  }
}

async function safeRegularFile(path: string, maximumBytes: number, privateFile: boolean): Promise<string | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > maximumBytes) throw new Error("Legacy credential path is not a bounded regular file.");
    if (privateFile && process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("Legacy credential permissions are too broad.");
    return path;
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw reason;
  }
}

async function writeMarker(path: string, value: Data): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (process.platform !== "win32") await chmod(dirname(path), 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try { await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

function parseSettings(raw: string): Data {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Legacy AI settings are invalid JSON."); }
  if (!isRecord(value) || value.schemaVersion !== 2) throw new Error("Legacy AI settings schema is unsupported.");
  return value;
}

function selectedModel(settings: Data, selectedProvider: AiProviderId): string {
  const key = selectedProvider === "anthropic" ? "anthropicModel" : "codexModel";
  return boundedString(settings[key], `${selectedProvider} model`, 200);
}

function provider(value: unknown): AiProviderId | undefined {
  return value === "anthropic" || value === "openai-codex" || value === "workbuddy" || value === "traecode" ? value : undefined;
}

function providerLabel(value: AiProviderId): string { return value === "openai-codex" ? "OpenAI Codex" : "Anthropic"; }
function weight(value: unknown): number { return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100 ? value : 1; }
function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function optionalString(value: unknown, maximum: number): string | undefined { return typeof value === "string" && value.trim().length > 0 && value.length <= maximum ? value.trim() : undefined; }
function boundedString(value: unknown, label: string, maximum: number): string { const result = optionalString(value, maximum); if (!result) throw new Error(`${label} is invalid.`); return result; }
function isRecord(value: unknown): value is Data { return value !== null && typeof value === "object" && !Array.isArray(value); }
