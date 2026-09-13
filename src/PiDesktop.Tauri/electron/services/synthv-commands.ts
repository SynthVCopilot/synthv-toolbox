import type { SynthVService } from "./synthv-service.js";

export type SynthVCommandHandler = (params: Record<string, unknown>) => Promise<unknown>;
export interface SynthVCommandRegistry { register(command: string, handler: SynthVCommandHandler): void; }

export function registerSynthVCommands(registry: SynthVCommandRegistry, service: SynthVService): void {
  registry.register("scan_synthv", () => service.scanInstallations());
  registry.register("sv2_profile_state", () => service.profileState());
  registry.register("sv2_cached_profile_state", () => service.profileState());
  registry.register("create_sv2_profile", params => service.createProfile(text(params, "displayName")));
  registry.register("import_current_sv2_profile", params => service.createProfile(text(params, "displayName")));
  registry.register("rename_sv2_profile", params => service.renameProfile(text(params, "slotId"), text(params, "displayName")));
  registry.register("delete_sv2_profile", params => service.deleteProfile(text(params, "slotId")));
  registry.register("activate_sv2_profile", params => service.activateProfile(text(params, "slotId")));
  registry.register("prepare_sv2_concurrent_profile", params => service.prepareConcurrentProfile(text(params, "slotId")));
  registry.register("open_sv2_profile_folder", params => service.openProfileFolder(text(params, "slotId")));
  registry.register("read_sv2_session_document", async params => sessionDocument(await service.readSession(text(params, "slotId"))));
  registry.register("write_sv2_session_document", async params => sessionDocument(await service.writeSession(text(params, "slotId"), text(params, "plaintext"), text(params, "expectedSha256"))));
  registry.register("sv2_inspect_offline_license", params => service.inspectOfflineLicense(text(params, "slotId")));
  registry.register("sv2_set_offline_license", params => service.setOfflineLicense(text(params, "slotId"), boolean(params, "enabled")));
  registry.register("sv2_sync_categories", async () => [
    { id: "settings", title: "Settings", description: "Application settings", defaultSelected: true },
    { id: "database", title: "Database", description: "Local databases", defaultSelected: true },
    { id: "voice", title: "Voice", description: "Voice data", defaultSelected: false },
  ]);
  registry.register("execute_sv2_selective_sync", async params => service.syncProfile(text(params, "targetSlotId"), strings(params, "categories")));
  registry.register("preview_svp_route", params => service.previewSvpRoute(text(params, "projectPath")));
  registry.register("list_synthv_processes", () => service.listProcesses());
  registry.register("focus_sv2_instance", params => service.focusInstance(integer(params, "processId"), text(params, "processIdentity")));
  registry.register("terminate_sv2_instance", params => service.terminateInstance(integer(params, "processId"), text(params, "processIdentity")));
  registry.register("synthv_shortcut_profile", () => Promise.resolve(service.shortcutProfile()));
  registry.register("send_synthv_bridge_shortcut", params => service.sendShortcut(integer(params, "processId"), text(params, "processIdentity"), shortcut(params)));
  registry.register("install_bridge", params => service.installBridge(bridgeTargets(params)));
  registry.register("diagnose_bridge", params => service.diagnoseBridge(bridgeTargets(params)));
  registry.register("set_autostart", params => service.setAutostart(boolean(params, "enabled")));
  registry.register("get_autostart", () => service.getAutostart());
}

function text(params: Record<string, unknown>, key: string): string { const value = params[key]; if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string.`); return value; }
function boolean(params: Record<string, unknown>, key: string): boolean { if (typeof params[key] !== "boolean") throw new Error(`${key} must be a boolean.`); return params[key] as boolean; }
function integer(params: Record<string, unknown>, key: string): number { const value = params[key]; if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer.`); return value; }
function strings(params: Record<string, unknown>, key: string): string[] { const value = params[key]; if (!Array.isArray(value) || !value.every(item => typeof item === "string")) throw new Error(`${key} must be a string array.`); return value; }
function shortcut(params: Record<string, unknown>): string { const action = text(params, "action"); if (action !== "start" && action !== "stop") throw new Error("action must be start or stop."); return action; }
function bridgeTargets(params: Record<string, unknown>): Array<{ scriptsPath: string; bridgeProfile: string }> { const value = params.targets; if (!Array.isArray(value)) throw new Error("targets must be an array."); return value.map((target) => { if (target === null || typeof target !== "object" || Array.isArray(target)) throw new Error("Bridge target must be an object."); const source = target as Record<string, unknown>; return { scriptsPath: text(source, "scriptsPath"), bridgeProfile: text(source, "bridgeProfile") }; }); }
function sessionDocument(value: { path: string; sha256: string; plaintext?: string }): Record<string, unknown> { return { path: value.path, encryptedSha256: value.sha256, encryptedBytes: value.plaintext?.length ?? 0, plaintext: value.plaintext ?? "", backupPath: null }; }
