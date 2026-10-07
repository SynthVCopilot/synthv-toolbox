import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface CredentialStore {
  seal(value: string): Promise<string>;
  unseal(value: string): Promise<string>;
}

const PREFIX = "local1:";
const MAX_SECRET_BYTES = 1024 * 1024;
const UNREADABLE = "Local login data cannot be read. Sign in again to replace this credential.";

export function createLocalCredentialStore(directory: string): CredentialStore {
  const root = resolve(directory), keyPath = join(root, "credentials.key");
  let creation: Promise<Buffer> | undefined;
  const readKey = async (): Promise<Buffer> => {
    const directoryInfo = await lstat(root);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("Invalid local credential directory.");
    if ((await lstat(keyPath)).isSymbolicLink()) throw new Error("Invalid local credential key.");
    const file = await open(keyPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== 32) throw new Error("Invalid local credential key.");
      const key = await file.readFile();
      if (key.length !== 32) throw new Error("Invalid local credential key.");
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) await file.chmod(0o600);
      return key;
    } finally { await file.close(); }
  };
  const createKey = async (): Promise<Buffer> => {
    try { return await readKey(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid local credential directory.");
    const temporary = join(root, `.credentials-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, randomBytes(32), { flag: "wx", mode: 0o600 });
      try { await link(temporary, keyPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      return await readKey();
    } finally { await rm(temporary, { force: true }); }
  };
  const writableKey = () => {
    if (!creation) creation = createKey().finally(() => { creation = undefined; });
    return creation;
  };
  return {
    async seal(value) {
      if (!value || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) throw new Error("Credential must contain 1 byte to 1 MiB of text.");
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", await writableKey(), nonce);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
    },
    async unseal(value) {
      if (typeof value !== "string" || !value.startsWith(PREFIX) || value.length > MAX_SECRET_BYTES * 2) throw new Error(UNREADABLE);
      const encoded = value.slice(PREFIX.length);
      if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error(UNREADABLE);
      const payload = Buffer.from(encoded, "base64url");
      if (payload.length <= 28) throw new Error(UNREADABLE);
      try {
        const decipher = createDecipheriv("aes-256-gcm", await readKey(), payload.subarray(0, 12));
        decipher.setAuthTag(payload.subarray(12, 28));
        return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
      } catch { throw new Error(UNREADABLE); }
    },
  };
}
