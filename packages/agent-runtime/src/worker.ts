import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { stderr, stdin, stdout } from "node:process";
import {
  AgentRuntimeWorker,
  createPiSessionFactory,
  loadPluginBackends,
  type HostCapabilityTransport,
  type LoadedPluginBackend,
  type PluginDiscovery,
  type PluginInvocationResult,
} from "./index.js";
import {
  PROTOCOL_VERSION,
  encodeJsonl,
  isHostApiCompatible,
  parseJsonl,
  validatePluginManifest,
  type JsonValue,
  type PluginManifest,
  type RpcMessage,
  type RpcResponseFailure,
} from "@synthv-toolbox/runtime-protocol";

class StdioHostTransport implements HostCapabilityTransport {
  private nextId = 1;
  private readonly pending = new Map<string, { resolve: (value: JsonValue) => void; reject: (error: Error) => void }>();

  constructor(private readonly write: (line: string) => void) {}

  request(method: string, params: JsonValue): Promise<JsonValue> {
    const id = `runtime-host-${this.nextId++}`;
    return new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(encodeJsonl({ kind: "request", id, protocolVersion: PROTOCOL_VERSION, method, params }));
    });
  }

  accept(message: RpcMessage): boolean {
    if (message.kind !== "response") return false;
    const pending = this.pending.get(message.id);
    if (!pending) return false;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(responseError(message));
    return true;
  }

  dispose(): void {
    for (const pending of this.pending.values()) pending.reject(new Error("Host capability transport closed."));
    this.pending.clear();
  }
}

class FilePluginDiscovery implements PluginDiscovery {
  private loaded: LoadedPluginBackend[] = [];

  constructor(private readonly host: HostCapabilityTransport) {}

  async discover(root: string): Promise<PluginManifest[]> {
    await this.dispose();
    const manifests: unknown[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        manifests.push(JSON.parse(await readFile(`${root}/${entry.name}/manifest.json`, "utf8")));
      } catch {
        // A malformed or absent manifest is not a plugin candidate.
      }
    }
    const accepted = manifests
      .map(validatePluginManifest)
      .filter((manifest): manifest is PluginManifest => manifest !== undefined && isHostApiCompatible(manifest));
    this.loaded = await loadPluginBackends(pathToFileURL(root).href, accepted, this.host);
    return accepted;
  }

  async dispose(): Promise<void> {
    await Promise.all(this.loaded.map(async (plugin) => { await plugin.deactivate(); }));
    this.loaded = [];
  }

  async invoke(pluginId: string, method: string, params: JsonValue): Promise<PluginInvocationResult> {
    const plugin = this.loaded.find(({ manifest }) => manifest.id === pluginId);
    if (!plugin) return { kind: "not-found" };
    if (!plugin.invoke) return { kind: "unsupported" };
    return { kind: "handled", result: await plugin.invoke(method, params) };
  }

  extensionPaths(): readonly string[] {
    return this.loaded.flatMap((plugin) => plugin.piExtensionPath ? [plugin.piExtensionPath] : []);
  }
}

export async function runStdioWorker(): Promise<void> {
  const hostTransport = new StdioHostTransport((line) => stdout.write(line));
  const pluginDiscovery = new FilePluginDiscovery(hostTransport);
  const worker = new AgentRuntimeWorker(createPiSessionFactory(() => pluginDiscovery.extensionPaths()), hostTransport, pluginDiscovery);
  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    lines.close();
    hostTransport.dispose();
    await queue;
    await worker.dispose();
    await pluginDiscovery.dispose();
  };

  lines.on("line", (line) => {
    try {
      if (hostTransport.accept(parseJsonl(line))) return;
    } catch {
      // Let the worker report malformed input on stderr.
    }
    queue = queue.then(async () => {
      try {
        const responses = await worker.handleJsonl(line);
        for (const response of responses) stdout.write(response);
      } catch (error) {
        stderr.write(`agent-runtime: ${error instanceof Error ? error.message : "invalid worker input"}\n`);
      }
    });
  });
  lines.on("close", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runStdioWorker();
}

function responseError(response: RpcResponseFailure): Error {
  return new Error(`${response.error.code}: ${response.error.message}`);
}
