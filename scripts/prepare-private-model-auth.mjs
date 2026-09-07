import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kit = process.env.PLATFORM_KIT_PATH ?? path.join(root, ".platform-kit-private/source");
if (!path.isAbsolute(kit)) throw new Error("PLATFORM_KIT_PATH must be an absolute authorized Platform Kit checkout.");
const installer = path.join(kit, "tooling/platform-cli/bin/platform-kit.mjs");
if (!existsSync(installer)) throw new Error("Private Platform Kit is missing. Set PLATFORM_KIT_PATH to an authorized checkout and run pnpm model-auth:pack there first.");
const result = spawnSync(process.execPath, [installer, "install-model-auth", path.resolve(root, "src/PiDesktop.Tauri")], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
