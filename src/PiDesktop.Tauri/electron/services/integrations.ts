/** Optional host integrations. Each can be forced on/off by the user or left on "auto". */
export const INTEGRATION_IDS = ["synthv"] as const;
export type IntegrationId = typeof INTEGRATION_IDS[number];
export type IntegrationPreference = "auto" | "on" | "off";
export const INTEGRATION_PREFERENCES: readonly IntegrationPreference[] = ["auto", "on", "off"];

/**
 * What the last SynthV probe found on this machine; used to resolve the "auto" preference. Whether the app's own Bridge
 * component loaded is not evidence: it ships with every install, with or without Synthesizer V.
 */
export interface SynthVEvidence {
  installations: number;
  profiles: number;
  bridgeConnected: boolean;
}

export function isIntegrationPreference(value: unknown): value is IntegrationPreference {
  return typeof value === "string" && (INTEGRATION_PREFERENCES as readonly string[]).includes(value);
}

/**
 * Synthesizer V is in use here: an installation was found (or the user set up a scripts folder for the Bridge), the user
 * keeps SV2 account slots, or a Bridge script has connected since launch.
 */
export function synthvDetected(evidence: SynthVEvidence): boolean {
  return evidence.installations > 0 || evidence.profiles > 0 || evidence.bridgeConnected;
}

/**
 * "auto" follows the evidence. Probes keep running while it resolves to off (on window focus, and on a timer), so installing
 * Synthesizer V or connecting its Bridge turns the integration on without a restart; only "off" stops probing.
 */
export function resolveSynthVIntegration(preference: IntegrationPreference, evidence: SynthVEvidence): boolean {
  if (preference !== "auto") return preference === "on";
  return synthvDetected(evidence);
}
