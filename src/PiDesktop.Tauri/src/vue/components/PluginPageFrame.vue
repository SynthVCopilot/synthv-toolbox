<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { dispatchPluginFrameRequest, type PluginFrameEvent, type PluginFrameResponse, type RegisteredPluginPage } from "../pluginRegistry";

const props = defineProps<{ page: RegisteredPluginPage }>();
const frame = ref<HTMLIFrameElement>();

interface PluginMessage {
  type: "plugin-ui:ready" | "plugin-ui:request";
  id?: string;
  method?: string;
  params?: unknown;
}

function isPluginMessage(value: unknown): value is PluginMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.type === "plugin-ui:ready"
    || (message.type === "plugin-ui:request" && typeof message.id === "string" && typeof message.method === "string" && message.method.length <= 80);
}

function postContext(): void {
  // The sandbox intentionally gives the frame an opaque origin, so only its exact Window reference can receive this message.
  frame.value?.contentWindow?.postMessage({ type: "plugin-ui:host-ready", pluginId: props.page.pluginId, pageId: props.page.pageId }, "*");
}

function receiveMessage(event: MessageEvent<unknown>): void {
  if (event.source !== frame.value?.contentWindow || !isPluginMessage(event.data)) return;
  if (event.data.type === "plugin-ui:ready") {
    postContext();
    return;
  }
  dispatchPluginFrameRequest({
    pluginId: props.page.pluginId,
    pageId: props.page.pageId,
    id: event.data.id!,
    method: event.data.method!,
    params: event.data.params ?? null,
  });
}

function postResponse(event: Event): void {
  const response = (event as CustomEvent<PluginFrameResponse>).detail;
  if (response.pluginId !== props.page.pluginId || response.pageId !== props.page.pageId) return;
  frame.value?.contentWindow?.postMessage({ type: "plugin-ui:response", id: response.id, ok: response.ok, ...(response.ok ? { result: response.result ?? null } : { error: response.error ?? { code: "unknown", message: "Plugin request failed." } }) }, "*");
}

function postEvent(event: Event): void {
  const message = (event as CustomEvent<PluginFrameEvent>).detail;
  if (message.pluginId !== props.page.pluginId || message.pageId !== props.page.pageId) return;
  frame.value?.contentWindow?.postMessage({ type: "plugin-ui:event", event: message.event, params: message.params ?? null }, "*");
}

onMounted(() => {
  window.addEventListener("message", receiveMessage);
  window.addEventListener("plugin-ui:response", postResponse);
  window.addEventListener("plugin-ui:event", postEvent);
});
onBeforeUnmount(() => {
  window.removeEventListener("message", receiveMessage);
  window.removeEventListener("plugin-ui:response", postResponse);
  window.removeEventListener("plugin-ui:event", postEvent);
});
</script>

<template>
  <div class="plugin-page-frame">
    <iframe
      ref="frame"
      :src="page.src"
      :title="page.title"
      sandbox="allow-scripts allow-forms"
      referrerpolicy="no-referrer"
      @load="postContext"
    ></iframe>
  </div>
</template>
