import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface EmbeddedBridgeTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: Record<string, unknown>;
  readonly inputSchema: Record<string, unknown>;
  call(input: unknown): Promise<{ text: string; isError: boolean }>;
}

export interface EmbeddedBridgeClassification {
  readonly category: "read" | "uiChange" | "projectWrite" | "executorControl";
  readonly risk: "normal" | "high";
}

export interface BridgeStatusSnapshot {
  connected: boolean;
  ipcDirectory: string;
  reason?: string;
  status?: { sessionToken?: string; [key: string]: unknown } | null;
}

export interface EmbeddedBridge {
  readonly tools: readonly EmbeddedBridgeTool[];
  readonly instructions: string;
  classify(name: string, input: unknown): EmbeddedBridgeClassification;
  status(): Promise<BridgeStatusSnapshot>;
  requestStop(): Promise<void>;
  close(): Promise<void>;
}

/** Dynamically imports the bridge component's self-contained embedded front end, once. */
export function loadEmbeddedBridge(bridgeDirectory: string, clientLabel: string): Promise<EmbeddedBridge> {
  return import(pathToFileURL(join(bridgeDirectory, "dist/src/embedded.js")).href)
    .then((module: { createEmbeddedBridge(options: { clientLabel: string }): EmbeddedBridge }) => module.createEmbeddedBridge({ clientLabel }));
}

export const SYNTHV_OFF_MESSAGE = "The Synthesizer V integration is turned off: Settings > Integrations is set to Off, or Auto has not detected Synthesizer V on this computer.";
/** The refusal in the bridge's own failure envelope, so every caller that parses bridge replies reads it as a failed call. */
const SYNTHV_OFF_REPLY = JSON.stringify({ outcome: "failed", phase: "accepted", wrote: false, undoRequired: false, retry: "correct_request", error: { code: "SYNTHV_INTEGRATION_OFF", message: SYNTHV_OFF_MESSAGE } });

/**
 * Checks `enabled` when each tool call runs rather than when a session was built, so turning SynthV off in Settings also stops
 * a run, or an approved write, that was already under way. Status, install and shutdown stay available.
 */
export function gatedBridge(bridge: EmbeddedBridge, enabled: () => boolean): EmbeddedBridge {
  return {
    tools: bridge.tools.map((tool) => ({
      name: tool.name, title: tool.title, description: tool.description, annotations: tool.annotations, inputSchema: tool.inputSchema,
      call: async (input: unknown) => enabled() ? tool.call(input) : { text: SYNTHV_OFF_REPLY, isError: true },
    })),
    instructions: bridge.instructions,
    classify: (name, input) => bridge.classify(name, input),
    status: () => bridge.status(),
    requestStop: () => bridge.requestStop(),
    close: () => bridge.close(),
  };
}

/** Where the bridge component exchanges files with SynthV: the same rule as its loadConfig, so the scripts agree on it. */
export function bridgeIpcDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.SYNTHV_AGENT_BRIDGE_DIR?.trim() || tmpdir());
}

/**
 * Stands in for a bridge component that failed to load, so the rest of the app still starts without SynthV. It keeps the real
 * IPC folder: installing the SynthV scripts needs no embedded client and is how a user repairs this state.
 */
export function unavailableBridge(reason: string, env: NodeJS.ProcessEnv = process.env): EmbeddedBridge {
  const ipcDirectory = bridgeIpcDirectory(env);
  return {
    tools: [],
    instructions: "",
    classify: () => ({ category: "read", risk: "normal" }),
    status: async () => ({ connected: false, ipcDirectory, reason }),
    requestStop: async () => {},
    close: async () => {},
  };
}
