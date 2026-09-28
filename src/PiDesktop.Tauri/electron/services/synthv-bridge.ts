import { join } from "node:path";
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
