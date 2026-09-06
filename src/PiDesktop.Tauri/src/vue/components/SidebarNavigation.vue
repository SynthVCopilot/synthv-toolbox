<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{ html: string }>();

const sidebar = ref<HTMLElement>();
const indicatorStyle = ref<Record<string, string>>({ opacity: "0" });
let resizeObserver: ResizeObserver | undefined;
let frame: number | undefined;

function updateIndicator(): void {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    frame = undefined;
    const container = sidebar.value;
    const selected = container?.querySelector<HTMLElement>(".nav-item.active");
    if (!container || !selected) {
      indicatorStyle.value = { opacity: "0" };
      return;
    }
    const sidebarBounds = container.getBoundingClientRect();
    const selectedBounds = selected.getBoundingClientRect();
    const navigation = selected.closest<HTMLElement>(".nav");
    const navigationBounds = navigation?.getBoundingClientRect();
    if (navigationBounds && (selectedBounds.top < navigationBounds.top || selectedBounds.bottom > navigationBounds.bottom)) {
      indicatorStyle.value = { opacity: "0" };
      return;
    }
    const height = Math.min(16, selectedBounds.height);
    indicatorStyle.value = {
      height: `${height}px`,
      opacity: "1",
      transform: `translate(${Math.round(selectedBounds.left - sidebarBounds.left)}px, ${Math.round(selectedBounds.top - sidebarBounds.top + (selectedBounds.height - height) / 2)}px)`,
    };
  });
}

function preserveNavigationPosition(): void {
  const previousScrollTop = sidebar.value?.querySelector<HTMLElement>(".nav")?.scrollTop ?? 0;
  void nextTick(() => {
    const navigation = sidebar.value?.querySelector<HTMLElement>(".nav");
    const selected = navigation?.querySelector<HTMLElement>(".nav-item.active");
    if (!navigation || !selected) {
      updateIndicator();
      return;
    }
    navigation.scrollTop = Math.min(previousScrollTop, Math.max(0, navigation.scrollHeight - navigation.clientHeight));
    const navigationBounds = navigation.getBoundingClientRect();
    const selectedBounds = selected.getBoundingClientRect();
    if (selectedBounds.top < navigationBounds.top) navigation.scrollTop += selectedBounds.top - navigationBounds.top;
    else if (selectedBounds.bottom > navigationBounds.bottom) navigation.scrollTop += selectedBounds.bottom - navigationBounds.bottom;
    updateIndicator();
  });
}

onMounted(() => {
  resizeObserver = new ResizeObserver(updateIndicator);
  if (sidebar.value) resizeObserver.observe(sidebar.value);
  sidebar.value?.addEventListener("scroll", updateIndicator, true);
  updateIndicator();
});

watch(() => props.html, preserveNavigationPosition, { flush: "pre" });

onBeforeUnmount(() => {
  if (frame !== undefined) cancelAnimationFrame(frame);
  resizeObserver?.disconnect();
  sidebar.value?.removeEventListener("scroll", updateIndicator, true);
});
</script>

<template>
  <aside id="app-sidebar" ref="sidebar" class="sidebar">
    <span class="sidebar-selection-indicator" aria-hidden="true" :style="indicatorStyle"></span>
    <div class="sidebar-content" v-html="html"></div>
  </aside>
</template>
