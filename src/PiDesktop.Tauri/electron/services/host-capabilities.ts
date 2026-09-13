import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { JsonValue } from "@synthv-toolbox/runtime-protocol";
import type { AiService, AiProviderId } from "./ai-service.js";
import type { CreativeService } from "./creative-service.js";
import type { SynthVService } from "./synthv-service.js";

type Data = Record<string, unknown>;

export class HostCapabilities {
  constructor(private readonly synthv: SynthVService, private readonly creative: CreativeService, private readonly ai: AiService) {}

  async invoke(permission: "host.internal" | "host.advanced", capability: string, operation: string, params: JsonValue): Promise<JsonValue> {
    if (!isObject(params)) throw new Error("Host capability parameters must be an object.");
    if (permission === "host.internal") return this.internal(capability, operation, params);
    return this.advanced(capability, operation, params);
  }

  private async internal(capability: string, operation: string, params: Data): Promise<JsonValue> {
    if (capability === "synthv") {
      if (operation === "profile-state") return await this.synthv.profileState() as JsonValue;
      if (operation === "scan") return await this.synthv.scanInstallations() as JsonValue;
      if (operation === "session-read") return await this.synthv.readSession(text(params, "slotId")) as JsonValue;
      if (operation === "offline-inspect") return await this.synthv.inspectOfflineLicense(text(params, "slotId")) as JsonValue;
      if (operation === "processes") return await this.synthv.listProcesses() as unknown as JsonValue;
    }
    if (capability === "creative") return await this.creative.invoke(operation, params) as JsonValue;
    throw new Error(`Unsupported internal host operation: ${capability}.${operation}`);
  }

  private async advanced(capability: string, operation: string, params: Data): Promise<JsonValue> {
    if (capability === "network" && operation === "fetch") {
      const response = await fetch(text(params, "url"), { method: typeof params.method === "string" ? params.method : "GET", headers: isObject(params.headers) ? stringRecord(params.headers) : undefined, body: typeof params.body === "string" ? params.body : undefined });
      return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
    }
    if (capability === "filesystem") {
      const path = resolve(text(params, "path"));
      if (operation === "read") return { path, content: await readFile(path, "utf8") };
      if (operation === "write") { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text(params, "content"), "utf8"); return { path }; }
      if (operation === "mkdir") { await mkdir(path, { recursive: true }); return { path }; }
      if (operation === "delete") { await rm(path, { recursive: true, force: true }); return { path }; }
    }
    if (capability === "sandbox") {
      const name = text(params, "name");
      if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name)) throw new Error("Sandbox name is invalid.");
      const provider = await sandboxie();
      if (operation === "add") { const root = text(params, "root"); if (!isAbsolute(root)) throw new Error("Sandbox root must be absolute."); await mkdir(root, { recursive: true }); for (const [setting, value] of [["Enabled", "y"], ["FileRootPath", root], ["SeparateUserFolders", "y"], ["AutoRecover", "n"], ["NeverDelete", "y"]]) await run(provider.ini, ["set", name, setting, value]); await run(provider.start, ["/silent", "/reload"]); return { name, root }; }
      if (operation === "delete") { await run(provider.ini, ["delete", name]); await run(provider.start, ["/silent", "/reload"]); return { name }; }
    }
    if (capability === "authorization") {
      const provider = providerId(params.provider);
      if (operation === "remove") return await this.ai.remove_ai_provider_account(provider, text(params, "credentialId")) as JsonValue;
      if (operation === "enable") return await this.ai.update_ai_credential(provider, text(params, "credentialId"), boolean(params, "enabled"), number(params, "weight")) as JsonValue;
      if (operation === "add-api-key") return await this.ai.add_ai_api_key(provider, text(params, "label"), text(params, "apiKey")) as JsonValue;
    }
    if (capability === "synthv") {
      if (operation === "activate-profile") return await this.synthv.activateProfile(text(params, "slotId")) as JsonValue;
      if (operation === "offline-set") return await this.synthv.setOfflineLicense(text(params, "slotId"), boolean(params, "enabled")) as unknown as JsonValue;
    }
    throw new Error(`Unsupported advanced host operation: ${capability}.${operation}`);
  }
}

function isObject(value: unknown): value is Data { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(params: Data, key: string): string { const value = params[key]; if (typeof value !== "string" || !value) throw new Error(`${key} must be a non-empty string.`); return value; }
function boolean(params: Data, key: string): boolean { if (typeof params[key] !== "boolean") throw new Error(`${key} must be a boolean.`); return params[key] as boolean; }
function number(params: Data, key: string): number { if (typeof params[key] !== "number" || !Number.isFinite(params[key])) throw new Error(`${key} must be a number.`); return params[key] as number; }
function stringRecord(value: Data): Record<string, string> { return Object.fromEntries(Object.entries(value).map(([key, item]) => { if (typeof item !== "string") throw new Error("Header values must be strings."); return [key, item]; })); }
function providerId(value: unknown): AiProviderId { if (value === "anthropic" || value === "openai-codex" || value === "workbuddy" || value === "traecode") return value; throw new Error("provider is invalid."); }
async function sandboxie(): Promise<{ start: string; ini: string }> { for (const base of [process.env.SYNTHV_TOOLBOX_SANDBOXIE_HOME, process.env.ProgramW6432 && join(process.env.ProgramW6432, "Sandboxie-Plus"), process.env.ProgramFiles && join(process.env.ProgramFiles, "Sandboxie-Plus"), process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"]!, "Sandboxie")]) { if (!base) continue; const start = join(base, "Start.exe"); const ini = join(base, "SbieIni.exe"); try { await Promise.all([access(start), access(ini)]); return { start, ini }; } catch {} } throw new Error("Sandboxie Plus or Classic is not installed."); }
async function run(file: string, args: string[]): Promise<void> { await new Promise<void>((resolveRun, reject) => { const child = spawn(file, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] }); let error = ""; child.stderr.on("data", chunk => { error += chunk; }); child.once("error", reject); child.once("close", code => code === 0 ? resolveRun() : reject(new Error(error || `${file} exited with ${code}`))); }); }
