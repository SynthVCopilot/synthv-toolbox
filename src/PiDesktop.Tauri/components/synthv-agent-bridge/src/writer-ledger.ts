import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";

export interface WriterRecord {
  readonly client: string;
  readonly pid: number;
  readonly action: string;
  readonly atEpochMs: number;
}

export interface WriterSelfIdentity {
  readonly client: string;
  readonly pid: number;
}

export interface WriterStatus {
  readonly self: WriterSelfIdentity;
  readonly lastWrite: WriterRecord | null;
  readonly lastWriteByOtherClient: boolean;
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function parseWriterRecord(raw: string): WriterRecord | null {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const value = parsed as Partial<WriterRecord>;
  if (
    typeof value.client === "string" &&
    typeof value.pid === "number" &&
    typeof value.action === "string" &&
    typeof value.atEpochMs === "number"
  ) {
    return {
      client: value.client,
      pid: value.pid,
      action: value.action,
      atEpochMs: value.atEpochMs,
    };
  }
  return null;
}

export class WriterLedger {
  public constructor(
    private readonly filePath: string,
    private readonly clientLabel: () => string,
  ) {}

  public async record(action: string): Promise<void> {
    const value: WriterRecord = {
      client: this.clientLabel(),
      pid: process.pid,
      action,
      atEpochMs: Date.now(),
    };
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx");
      try {
        await handle.writeFile(JSON.stringify(value), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, this.filePath);
    } catch (error) {
      await removeIfExists(temporary).catch(() => undefined);
      throw error;
    }
  }

  public async status(): Promise<WriterStatus> {
    const self: WriterSelfIdentity = {
      client: this.clientLabel(),
      pid: process.pid,
    };
    const lastWrite = await this.read();
    const lastWriteByOtherClient =
      lastWrite !== null &&
      (lastWrite.client !== self.client || lastWrite.pid !== self.pid);
    return { self, lastWrite, lastWriteByOtherClient };
  }

  private async read(): Promise<WriterRecord | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return parseWriterRecord(raw);
    } catch {
      return null;
    }
  }
}
