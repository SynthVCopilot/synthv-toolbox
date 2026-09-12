import type { IconName } from "../icons";
import type {
  PluginActionLocation,
  PluginManifest,
} from "@synthv-toolbox/runtime-protocol";

export type { PluginManifest } from "@synthv-toolbox/runtime-protocol";

export type HostPageId = "home" | "accounts" | "import" | "convert" | "analysis" | "quality" | "lyrics" | "history" | "copilot" | "ai" | "components" | "bridge" | "connections" | "settings" | "about";
export type PluginPageId = `plugin:${string}`;
export type PluginLoadStatus = "discovered" | "loading" | "active" | "disabled" | "failed";

export interface PluginRecord {
  manifest: PluginManifest;
  status: PluginLoadStatus;
  error?: string;
}

export interface RegisteredPluginPage {
  pluginId: string;
  pageId: PluginPageId;
  title: string;
  icon?: IconName;
  src: string;
}

export interface RegisteredPluginAction {
  pluginId: string;
  id: string;
  targetPage: HostPageId;
  title: string;
  icon?: IconName;
  whenCapability?: string;
}

export interface PluginActionInvocation {
  pluginId: string;
  actionId: string;
  targetPage: HostPageId;
}

export interface PluginFrameRequest {
  pluginId: string;
  pageId: PluginPageId;
  id: string;
  method: string;
  params: unknown;
}

export interface PluginFrameResponse {
  pluginId: string;
  pageId: PluginPageId;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface PluginFrameEvent {
  pluginId: string;
  pageId: PluginPageId;
  event: string;
  params: unknown;
}

type RegistryListener = () => void;

const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function isPluginPageId(value: string): value is PluginPageId {
  return value.startsWith("plugin:");
}

function assertId(value: string, label: string): void {
  if (!idPattern.test(value)) throw new Error(`${label} must contain only letters, digits, dots, underscores, or dashes.`);
}

function assertRelativeEntry(value: string): void {
  if (!value || value.startsWith("/") || value.startsWith("\\") || value.includes("\\") || value.split("/").includes("..")) {
    throw new Error("Plugin entries must be safe relative paths.");
  }
}

function pageId(pluginId: string, contributionId: string): PluginPageId {
  return `plugin:${pluginId}/${contributionId}`;
}

function pageSource(pluginId: string, entry: string): string {
  return `toolbox-plugin://localhost/${pluginId}/${entry}`;
}

function actionTarget(location: PluginActionLocation): HostPageId {
  switch (location) {
    case "home.toolbar": return "home";
    case "project.toolbar":
    case "project.context": return "lyrics";
    case "conversation.toolbar": return "copilot";
  }
}

function iconFromManifest(icon: string | undefined): IconName | undefined {
  const supported: IconName[] = ["home", "users", "toolbox", "bot", "boxes", "plug", "bridge", "settings", "sparkles", "audio", "file", "import", "download", "plus", "play", "folder", "send", "check", "refresh", "arrow", "server", "trash", "pipeline", "doctor", "history", "info", "github", "warning", "batch", "sync", "compare", "pronunciation", "lyrics", "waveform", "recipe", "shield"];
  return icon && supported.includes(icon as IconName) ? icon as IconName : undefined;
}

export class PluginRegistry {
  private readonly records = new Map<string, PluginRecord>();
  private readonly listeners = new Set<RegistryListener>();

  register(manifest: PluginManifest, status: PluginLoadStatus = "discovered"): void {
    assertId(manifest.id, "Plugin id");
    if (manifest.schemaVersion !== 1 || !manifest.name.trim() || !manifest.version.trim()) throw new Error("Plugin schema, name, and version are required.");
    if (this.records.has(manifest.id)) throw new Error(`Plugin '${manifest.id}' is already registered.`);
    const contributionIds = new Set<string>();
    for (const page of manifest.pages ?? []) {
      assertId(page.id, "Page id");
      assertRelativeEntry(page.entry);
      if (!page.title.trim() || contributionIds.has(page.id)) throw new Error("Plugin page ids must be unique and have a title.");
      contributionIds.add(page.id);
    }
    for (const action of manifest.actions ?? []) {
      assertId(action.id, "Action id");
      if (!action.title.trim() || contributionIds.has(action.id)) throw new Error("Plugin contribution ids must be unique and have a title.");
      contributionIds.add(action.id);
    }
    this.records.set(manifest.id, { manifest, status });
    this.notify();
  }

  unregister(pluginId: string): void {
    if (this.records.delete(pluginId)) this.notify();
  }

  setStatus(pluginId: string, status: PluginLoadStatus, error?: string): void {
    const record = this.records.get(pluginId);
    if (!record) throw new Error(`Plugin '${pluginId}' is not registered.`);
    record.status = status;
    record.error = error;
    this.notify();
  }

  recordsList(): readonly PluginRecord[] {
    return [...this.records.values()];
  }

  pages(): RegisteredPluginPage[] {
    return [...this.records.values()].flatMap((record) => record.status === "active"
      ? (record.manifest.pages ?? []).map((page) => ({ pluginId: record.manifest.id, pageId: pageId(record.manifest.id, page.id), title: page.title, icon: iconFromManifest(page.icon), src: pageSource(record.manifest.id, page.entry) }))
      : []);
  }

  page(id: PluginPageId): RegisteredPluginPage | undefined {
    return this.pages().find((page) => page.pageId === id);
  }

  actionsFor(targetPage: HostPageId): RegisteredPluginAction[] {
    return [...this.records.values()].flatMap((record) => record.status === "active"
      ? (record.manifest.actions ?? []).filter((action) => actionTarget(action.location) === targetPage).map((action) => ({ pluginId: record.manifest.id, id: action.id, targetPage: actionTarget(action.location), title: action.title, icon: iconFromManifest(action.icon), whenCapability: action.whenCapability }))
      : []);
  }

  subscribe(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const pluginRegistry = new PluginRegistry();

export function dispatchPluginAction(action: PluginActionInvocation): void {
  window.dispatchEvent(new CustomEvent<PluginActionInvocation>("plugin-ui:action", { detail: action }));
}

export function dispatchPluginFrameRequest(request: PluginFrameRequest): void {
  window.dispatchEvent(new CustomEvent<PluginFrameRequest>("plugin-ui:request", { detail: request }));
}

export function dispatchPluginFrameResponse(response: PluginFrameResponse): void {
  window.dispatchEvent(new CustomEvent<PluginFrameResponse>("plugin-ui:response", { detail: response }));
}

export function dispatchPluginFrameEvent(event: PluginFrameEvent): void {
  window.dispatchEvent(new CustomEvent<PluginFrameEvent>("plugin-ui:event", { detail: event }));
}
