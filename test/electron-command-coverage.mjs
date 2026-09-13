import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ElectronCommandRegistry } from "../src/PiDesktop.Tauri/dist/electron/services/command-registry.js";

const apiSource = await readFile(new URL("../src/PiDesktop.Tauri/src/api.ts", import.meta.url), "utf8");
const mainSource = await readFile(new URL("../src/PiDesktop.Tauri/electron/main.ts", import.meta.url), "utf8");
const apiCommands = [...apiSource.matchAll(/call(?:<[^;\n]*?>)?\("([^"]+)"/g)].map(match => match[1]);
const mainCommands = [...mainSource.matchAll(/handlers\.register\("([^"]+)"/g)].map(match => match[1]);

const host = { contributions: async () => [], runtime: { dispose: async () => {} } };
const inert = {};
const registry = new ElectronCommandRegistry(host, { ai: inert, creative: inert, desktop: inert, synthv: inert, componentAudio: { dataRoot: process.cwd(), run: async () => ({ stdout: "", stderr: "" }) } });
const covered = new Set([...registry.commands(), ...mainCommands]);
const missing = [...new Set(apiCommands)].filter(command => !covered.has(command));

assert.deepEqual(missing, [], `Renderer commands missing from Electron: ${missing.join(", ")}`);
console.log(`Electron covers ${new Set(apiCommands).size} renderer commands.`);
