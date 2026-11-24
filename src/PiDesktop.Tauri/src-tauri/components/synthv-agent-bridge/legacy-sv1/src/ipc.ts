import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type { LegacyConfig } from "./config.js";
import { LEGACY_PROTOCOL_VERSION } from "./config.js";

export class LegacyIpcError extends Error {
  public constructor(readonly code: string, message: string) { super(message); this.name = "LegacyIpcError"; }
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class LegacyIpcClient {
  public constructor(private readonly config: LegacyConfig) {}

  public async status(): Promise<Record<string, unknown>> {
    try {
      const status = JSON.parse(await fs.readFile(this.config.statusFile, "utf8")) as Record<string, unknown>;
      const updated = status.updatedAtEpochMs;
      if (typeof updated !== "number" || Date.now() - updated > 5_000 || status.state !== "running") {
        throw new LegacyIpcError("HOST_UNAVAILABLE", "SV1 legacy Bridge is not running.");
      }
      return status;
    } catch (error) {
      if (error instanceof LegacyIpcError) throw error;
      throw new LegacyIpcError("HOST_UNAVAILABLE", "SV1 legacy Bridge heartbeat was not found.");
    }
  }

  public async call(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    await fs.mkdir(this.config.directory, { recursive: true });
    const requestId = randomUUID();
    try {
      await fs.writeFile(this.config.requestFile, `${JSON.stringify({ v: LEGACY_PROTOCOL_VERSION, id: requestId, a: action, p: payload })}\n`, { encoding: "utf8", flag: "wx" });
    } catch {
      throw new LegacyIpcError("HOST_BUSY", "SV1 legacy Bridge already has a pending request.");
    }
    const deadline = Date.now() + this.config.timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = JSON.parse(await fs.readFile(this.config.responseFile, "utf8")) as Record<string, unknown>;
        if (response.id !== requestId) { await sleep(this.config.pollMs); continue; }
        await fs.rm(this.config.responseFile, { force: true });
        if (response.ok !== true) {
          const error = response.error as Record<string, unknown> | undefined;
          throw new LegacyIpcError(typeof error?.code === "string" ? error.code : "HOST_ERROR", typeof error?.message === "string" ? error.message : "SV1 host rejected the request.");
        }
        return response.result;
      } catch (error) {
        if (error instanceof LegacyIpcError) throw error;
        await sleep(this.config.pollMs);
      }
    }
    await fs.rm(this.config.requestFile, { force: true });
    throw new LegacyIpcError("HOST_TIMEOUT", "SV1 legacy Bridge did not respond before timeout.");
  }

  public async disconnect(): Promise<{ readonly requested: true }> {
    await fs.mkdir(this.config.directory, { recursive: true });
    await fs.writeFile(this.config.stopFile, "stop\n", "utf8");
    return { requested: true };
  }
}
