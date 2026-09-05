import os from "node:os";
import path from "node:path";

export const LEGACY_PROTOCOL_VERSION = 1 as const;
export const LEGACY_SERVER_NAME = "synthv-agent-bridge-sv1-legacy";

export interface LegacyConfig {
  readonly directory: string;
  readonly requestFile: string;
  readonly responseFile: string;
  readonly statusFile: string;
  readonly stopFile: string;
  readonly timeoutMs: number;
  readonly pollMs: number;
}

function positive(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

export function loadLegacyConfig(env: NodeJS.ProcessEnv = process.env): LegacyConfig {
  const directory = path.resolve(env.SYNTHV_AGENT_SV1_LEGACY_DIR?.trim() || os.tmpdir());
  const prefix = path.join(directory, LEGACY_SERVER_NAME);
  return {
    directory,
    requestFile: `${prefix}.request.json`,
    responseFile: `${prefix}.response.json`,
    statusFile: `${prefix}.status.json`,
    stopFile: `${prefix}.stop`,
    timeoutMs: positive(env.SYNTHV_AGENT_SV1_LEGACY_TIMEOUT_MS, 30_000, "SYNTHV_AGENT_SV1_LEGACY_TIMEOUT_MS"),
    pollMs: positive(env.SYNTHV_AGENT_SV1_LEGACY_POLL_MS, 20, "SYNTHV_AGENT_SV1_LEGACY_POLL_MS"),
  };
}
