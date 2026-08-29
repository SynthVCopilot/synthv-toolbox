<script setup lang="ts">
defineProps<{ title: string; subtitle: string; bridgeConnected: boolean }>();
</script>

<template>
  <header class="topbar" data-tauri-drag-region>
    <div>
      <h1>{{ title }}</h1>
      <p>{{ subtitle }}</p>
    </div>
    <div class="top-actions">
      <span class="status-dot" :class="{ online: bridgeConnected }"></span>
      <span class="muted">Bridge {{ bridgeConnected ? "已连接" : "未连接" }}</span>
    </div>
  </header>
</template>
