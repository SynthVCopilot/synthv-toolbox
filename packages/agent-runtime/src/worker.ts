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
} from "./index.js";
import { isHostApiCompatible, validatePluginManifest, type JsonValue, type PluginManifest } from "@synthv-toolbox/runtime-protocol";

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
    return this.loaded.map(({ manifest }) => manifest);
  }

  async dispose(): Promise<void> {
    await Promise.all(this.loaded.map(async (plugin) => { await plugin.deactivate(); }));
    this.loaded = [];
  }
}

const unavailableHost: HostCapabilityTransport = {
  async request(): Promise<JsonValue> {
    throw new Error("Host capability calls require a Native Host transport.");
  },
};

export async function runStdioWorker(): Promise<void> {
  const pluginDiscovery = new FilePluginDiscovery(unavailableHost);
  const worker = new AgentRuntimeWorker(createPiSessionFactory(), undefined, pluginDiscovery);
  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    lines.close();
    await queue;
    await worker.dispose();
    await pluginDiscovery.dispose();
  };

  lines.on("line", (line) => {
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
