import type { IconName } from "../icons";

export type HostPageId = "home" | "accounts" | "import" | "convert" | "analysis" | "quality" | "lyrics" | "history" | "copilot" | "ai" | "components" | "bridge" | "connections" | "settings" | "about";
export type PluginPageId = `plugin:${string}`;
export type PluginLoadStatus = "discovered" | "loading" | "active" | "disabled" | "failed";

export interface PluginPageContribution {
  id: string;
  title: string;
  subtitle?: string;
  icon?: IconName;
  src: string;
}

export interface PluginActionContribution {
  id: string;
  targetPage: HostPageId;
  title: string;
  icon?: IconName;
}

export interface PluginUiManifest {
  id: string;
  name: string;
  pages?: PluginPageContribution[];
  actions?: PluginActionContribution[];
}

export interface PluginRecord {
  manifest: PluginUiManifest;
  status: PluginLoadStatus;
  error?: string;
}

export interface RegisteredPluginPage extends PluginPageContribution {
  pluginId: string;
  pageId: PluginPageId;
}

export interface RegisteredPluginAction extends PluginActionContribution {
  pluginId: string;
}

export interface PluginActionInvocation {
  pluginId: string;
  actionId: string;
  targetPage: HostPageId;
}

export interface PluginFrameRequest {
  pluginId: string;
  pageId: PluginPageId;
  request: string;
  payload?: unknown;
}

type RegistryListener = () => void;

const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function isPluginPageId(value: string): value is PluginPageId {
  return value.startsWith("plugin:");
}

function assertId(value: string, label: string): void {
  if (!idPattern.test(value)) throw new Error(`${label} must contain only letters, digits, dots, underscores, or dashes.`);
}

function assertFrameSource(value: string): void {
  const source = new URL(value);
  if (source.protocol !== "plugin:" && source.protocol !== "https:") {
    throw new Error("Plugin page sources must use the plugin: or https: protocol.");
  }
}

function pageId(pluginId: string, contributionId: string): PluginPageId {
  return `plugin:${pluginId}/${contributionId}`;
}

export class PluginRegistry {
  private readonly records = new Map<string, PluginRecord>();
  private readonly listeners = new Set<RegistryListener>();

  register(manifest: PluginUiManifest, status: PluginLoadStatus = "discovered"): void {
    assertId(manifest.id, "Plugin id");
    if (!manifest.name.trim()) throw new Error("Plugin name is required.");
    if (this.records.has(manifest.id)) throw new Error(`Plugin '${manifest.id}' is already registered.`);
    const contributionIds = new Set<string>();
    for (const page of manifest.pages ?? []) {
      assertId(page.id, "Page id");
      assertFrameSource(page.src);
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
      ? (record.manifest.pages ?? []).map((page) => ({ ...page, pluginId: record.manifest.id, pageId: pageId(record.manifest.id, page.id) }))
      : []);
  }

  page(id: PluginPageId): RegisteredPluginPage | undefined {
    return this.pages().find((page) => page.pageId === id);
  }

  actionsFor(targetPage: HostPageId): RegisteredPluginAction[] {
    return [...this.records.values()].flatMap((record) => record.status === "active"
      ? (record.manifest.actions ?? []).filter((action) => action.targetPage === targetPage).map((action) => ({ ...action, pluginId: record.manifest.id }))
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
