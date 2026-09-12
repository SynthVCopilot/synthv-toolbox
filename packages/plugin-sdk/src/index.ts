import type { JsonValue, PluginManifest } from "@synthv-toolbox/runtime-protocol";

export type {
  ApiVersion,
  JsonValue,
  PluginActionContribution,
  PluginActionLocation,
  PluginBackend,
  PluginManifest,
  PluginPageContribution,
  PluginPermission,
  VersionRange,
} from "@synthv-toolbox/runtime-protocol";

export function definePlugin<const T extends PluginManifest>(manifest: T): T {
  return manifest;
}

export interface HostApiTransport {
  request(method: string, params: JsonValue): Promise<JsonValue>;
  notify?(event: string, params: JsonValue): void | Promise<void>;
}

export interface HostApiClient {
  call<TResult extends JsonValue = JsonValue>(method: string, params?: JsonValue): Promise<TResult>;
  emit(event: string, params?: JsonValue): Promise<void>;
}

export function createHostApiClient(transport: HostApiTransport): HostApiClient {
  return {
    async call<TResult extends JsonValue = JsonValue>(method: string, params: JsonValue = null): Promise<TResult> {
      return transport.request(method, params) as Promise<TResult>;
    },
    async emit(event: string, params: JsonValue = null): Promise<void> {
      await transport.notify?.(event, params);
    },
  };
}

export interface GuiReadyMessage {
  type: "plugin-ui:ready";
}

export interface GuiRequestMessage {
  type: "plugin-ui:request";
  id: string;
  method: string;
  params: JsonValue;
}

export interface GuiHostReadyMessage {
  type: "plugin-ui:host-ready";
  pluginId: string;
  pageId: string;
}

export interface GuiResponseSuccess {
  type: "plugin-ui:response";
  id: string;
  ok: true;
  result: JsonValue;
}

export interface GuiResponseFailure {
  type: "plugin-ui:response";
  id: string;
  ok: false;
  error: { code: string; message: string };
}

export interface GuiEventMessage {
  type: "plugin-ui:event";
  event: string;
  params: JsonValue;
}

export type GuiHostMessage = GuiHostReadyMessage | GuiResponseSuccess | GuiResponseFailure | GuiEventMessage;

export interface PluginGuiClient {
  ready(): void;
  request<TResult extends JsonValue = JsonValue>(method: string, params?: JsonValue): Promise<TResult>;
  onEvent(listener: (event: string, params: JsonValue) => void): () => void;
  dispose(): void;
}

export interface PluginGuiClientOptions {
  hostWindow?: Window;
  targetOrigin?: string;
}

export function createPluginGuiClient(options: PluginGuiClientOptions = {}): PluginGuiClient {
  const hostWindow = options.hostWindow ?? window.parent;
  const targetOrigin = options.targetOrigin ?? "*";
  const pending = new Map<string, { resolve(value: JsonValue): void; reject(reason: Error): void }>();
  const eventListeners = new Set<(event: string, params: JsonValue) => void>();
  let nextId = 0;

  const receive = (event: MessageEvent<unknown>): void => {
    if (event.source !== hostWindow || !isGuiHostMessage(event.data)) return;
    if (event.data.type === "plugin-ui:event") {
      for (const listener of eventListeners) listener(event.data.event, event.data.params);
      return;
    }
    if (event.data.type !== "plugin-ui:response") return;
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.ok) request.resolve(event.data.result);
    else request.reject(new Error(`${event.data.error.code}: ${event.data.error.message}`));
  };

  window.addEventListener("message", receive);
  return {
    ready(): void {
      hostWindow.postMessage({ type: "plugin-ui:ready" } satisfies GuiReadyMessage, targetOrigin);
    },
    request<TResult extends JsonValue = JsonValue>(method: string, params: JsonValue = null): Promise<TResult> {
      const id = `request-${++nextId}`;
      return new Promise<TResult>((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as TResult), reject });
        hostWindow.postMessage({ type: "plugin-ui:request", id, method, params } satisfies GuiRequestMessage, targetOrigin);
      });
    },
    onEvent(listener: (event: string, params: JsonValue) => void): () => void {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    dispose(): void {
      window.removeEventListener("message", receive);
      for (const request of pending.values()) request.reject(new Error("Plugin GUI client was disposed."));
      pending.clear();
      eventListeners.clear();
    },
  };
}

function isGuiHostMessage(value: unknown): value is GuiHostMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "plugin-ui:host-ready") return typeof message.pluginId === "string" && typeof message.pageId === "string";
  if (message.type === "plugin-ui:event") return typeof message.event === "string" && isJsonValue(message.params);
  if (message.type !== "plugin-ui:response" || typeof message.id !== "string" || typeof message.ok !== "boolean") return false;
  return message.ok ? isJsonValue(message.result) : isError(message.error);
}

function isError(value: unknown): value is { code: string; message: string } {
  return Boolean(value) && typeof value === "object"
    && typeof (value as Record<string, unknown>).code === "string"
    && typeof (value as Record<string, unknown>).message === "string";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJsonValue);
}
