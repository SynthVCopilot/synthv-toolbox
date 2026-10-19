import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { JsonValue } from "@synthv-toolbox/runtime-protocol";
import type { AiService, AiProviderId } from "./ai-service.js";
import { CREATIVE_BRIDGE_COMMANDS } from "./creative-bridge.js";
import type { CreativeService } from "./creative-service.js";
import type { SynthVService } from "./synthv-service.js";

type Data = Record<string, unknown>;

export class HostCapabilities {
  constructor(private readonly synthv: SynthVService, private readonly creative: CreativeService, private readonly ai: AiService, private readonly synthvEnabled: () => boolean = () => true, private readonly aiModeEnabled: () => boolean = () => true) {}

  async invoke(permission: "host.internal" | "host.advanced", capability: string, operation: string, params: JsonValue): Promise<JsonValue> {
    if (!isObject(params)) throw new Error("Host capability parameters must be an object.");
    // The UI hides these paths when SynthV is off or the app is in toolbox mode; MCP clients and plugins must not reopen them.
    const cover = capability === "creative" && await this.startsCover(operation, params);
    if (!this.synthvEnabled() && (capability === "synthv" || cover || (capability === "creative" && drivesSynthV(operation, params)))) throw clientSafe("The Synthesizer V integration is turned off in Settings > Integrations.");
    if (cover && !this.aiModeEnabled()) throw clientSafe("Cover runs the internal agent, which is only available in AI mode.");
    if (permission === "host.internal") return this.internal(capability, operation, params);
    return this.advanced(capability, operation, params);
  }

  /** Cover drives the agent and writes into SynthV; a retry counts only when the job being retried is a Cover job. */
  private async startsCover(operation: string, params: Data): Promise<boolean> {
    if (operation === "queue_cover") return true;
    if (operation !== "retry_media_task") return false;
    const jobs = await this.creative.invoke("media_tasks", {});
    return Array.isArray(jobs) && jobs.some(job => isObject(job) && job.id === params.id && job.kind === "cover");
  }

  private async internal(capability: string, operation: string, params: Data): Promise<JsonValue> {
    if (capability === "synthv") {
      if (operation === "profile-state") return await this.synthv.profileState() as JsonValue;
      if (operation === "session-size") return await this.synthv.sessionSize(text(params, "slotId")) as JsonValue;
      if (operation === "scan") return await this.synthv.scanInstallations() as JsonValue;

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
      if (operation === "web-account-query") return await this.synthv.webAccountQuery(text(params, "slotId")) as unknown as JsonValue;

    }
    throw new Error(`Unsupported advanced host operation: ${capability}.${operation}`);
  }
}

/** Offline .svp work belongs to the integration too: the renderer hides these tools with it, so non-UI callers lose them as well. */
const SVP_PROJECT_OPERATIONS = ["get_project_backup_state", "create_project_checkpoint", "list_project_checkpoints", "restore_project_checkpoint", "run_project_probe", "run_project_doctor", "add_project_reference", "export_project_without_parameters", "export_project_lyrics", "run_batch_workflow"];
function drivesSynthV(operation: string, params: Data): boolean {
  return CREATIVE_BRIDGE_COMMANDS.includes(operation) || operation.includes("lyric_bridge") || SVP_PROJECT_OPERATIONS.includes(operation)
    // Plain lyrics stay checkable without SynthV (the agent's toolbox_lyrics_check); a project file does not.
    || (operation === "run_pronunciation_diagnostics" && params.projectPath !== undefined)
    || (operation === "run_audio_to_project" && params.importToSynthv === true);
}
function clientSafe(message: string): Error { return Object.assign(new Error(message), { clientSafe: true }); }
function isObject(value: unknown): value is Data { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(params: Data, key: string): string { const value = params[key]; if (typeof value !== "string" || !value) throw new Error(`${key} must be a non-empty string.`); return value; }
function boolean(params: Data, key: string): boolean { if (typeof params[key] !== "boolean") throw new Error(`${key} must be a boolean.`); return params[key] as boolean; }
function number(params: Data, key: string): number { if (typeof params[key] !== "number" || !Number.isFinite(params[key])) throw new Error(`${key} must be a number.`); return params[key] as number; }
function stringRecord(value: Data): Record<string, string> { return Object.fromEntries(Object.entries(value).map(([key, item]) => { if (typeof item !== "string") throw new Error("Header values must be strings."); return [key, item]; })); }
function providerId(value: unknown): AiProviderId { if (value === "anthropic" || value === "openai-codex" || value === "workbuddy" || value === "traecode") return value; throw new Error("provider is invalid."); }
async function sandboxie(): Promise<{ start: string; ini: string }> { for (const base of [process.env.SYNTHV_TOOLBOX_SANDBOXIE_HOME, process.env.ProgramW6432 && join(process.env.ProgramW6432, "Sandboxie-Plus"), process.env.ProgramFiles && join(process.env.ProgramFiles, "Sandboxie-Plus"), process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"]!, "Sandboxie")]) { if (!base) continue; const start = join(base, "Start.exe"); const ini = join(base, "SbieIni.exe"); try { await Promise.all([access(start), access(ini)]); return { start, ini }; } catch {} } throw new Error("Sandboxie Plus or Classic is not installed."); }
async function run(file: string, args: string[]): Promise<void> { await new Promise<void>((resolveRun, reject) => { const child = spawn(file, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] }); let error = ""; child.stderr.on("data", chunk => { error += chunk; }); child.once("error", reject); child.once("close", code => code === 0 ? resolveRun() : reject(new Error(error || `${file} exited with ${code}`))); }); }
