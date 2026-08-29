<script setup lang="ts">
import type { ShellState } from "./shell";
import SidebarNavigation from "./components/SidebarNavigation.vue";
import PageHeader from "./components/PageHeader.vue";
import PageViewport from "./components/PageViewport.vue";
import OverlayHost from "./components/OverlayHost.vue";

defineProps<{ state: ShellState }>();
</script>

<template>
  <div id="app-shell" class="app-shell" :class="{ 'sidebar-collapsed': state.sidebarCollapsed }">
    <SidebarNavigation :html="state.sidebarHtml" />
    <main class="main">
      <PageHeader
        :title="state.title"
        :subtitle="state.subtitle"
        :bridge-connected="state.bridgeConnected"
      />
      <PageViewport
        :page="state.page"
        :html="state.pageHtml"
        :notice-html="state.noticeHtml"
        :error-html="state.errorHtml"
      />
    </main>
  </div>
  <OverlayHost :html="state.overlayHtml" />
</template>
