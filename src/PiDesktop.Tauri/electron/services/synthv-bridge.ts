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
