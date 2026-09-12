<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { dispatchPluginFrameRequest, type RegisteredPluginPage } from "../pluginRegistry";

const props = defineProps<{ page: RegisteredPluginPage }>();
const frame = ref<HTMLIFrameElement>();

interface PluginMessage {
  type: "plugin-ui:ready" | "plugin-ui:request";
  request?: string;
  payload?: unknown;
}

function isPluginMessage(value: unknown): value is PluginMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.type === "plugin-ui:ready"
    || (message.type === "plugin-ui:request" && typeof message.request === "string" && message.request.length <= 80);
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
    request: event.data.request!,
    payload: event.data.payload,
  });
}

onMounted(() => window.addEventListener("message", receiveMessage));
onBeforeUnmount(() => window.removeEventListener("message", receiveMessage));
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
