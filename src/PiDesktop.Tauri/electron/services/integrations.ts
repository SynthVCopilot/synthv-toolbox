/** Optional host integrations. Each can be forced on/off by the user or left on "auto". */
export const INTEGRATION_IDS = ["synthv"] as const;
export type IntegrationId = typeof INTEGRATION_IDS[number];
export type IntegrationPreference = "auto" | "on" | "off";
export const INTEGRATION_PREFERENCES: readonly IntegrationPreference[] = ["auto", "on", "off"];

/** What the last SynthV probe found on this machine; used to resolve the "auto" preference. */
export interface SynthVEvidence {
  installations: number;
  profiles: number;
  bridgeConnected: boolean;
  bridgeLoaded: boolean;
}

export function isIntegrationPreference(value: unknown): value is IntegrationPreference {
  return typeof value === "string" && (INTEGRATION_PREFERENCES as readonly string[]).includes(value);
}

export function resolveSynthVIntegration(preference: IntegrationPreference, evidence: SynthVEvidence): boolean {
  if (preference !== "auto") return preference === "on";
  return true;
}
