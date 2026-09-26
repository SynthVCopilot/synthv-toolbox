import { copyFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "dist", "electron-preload", "preload.js");
const destination = resolve(root, "dist", "electron", "preload.js");

// preload build uses its own outDir so it never overwrites the ESM electron/bridge.js emit.
await copyFile(source, destination);
await rm(resolve(root, "dist", "electron-preload"), { recursive: true, force: true });
