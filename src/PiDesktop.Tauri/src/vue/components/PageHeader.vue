<script setup lang="ts">
import { icon } from "../../icons";

defineProps<{ title: string; subtitle: string; page: string; busy: boolean }>();
const refreshIcon = icon("sync", 17);
</script>

<template>
  <header class="topbar" data-tauri-drag-region>
    <div>
      <h1>{{ title }}</h1>
      <p>{{ subtitle }}</p>
    </div>
    <div class="topbar-status-group">
      <Transition name="busy-chip">
        <div v-if="busy" class="top-actions operation-progress" role="status" aria-live="polite">
          <span class="mini-spinner"></span>
          <span>处理中</span>
        </div>
      </Transition>
      <div v-if="page === 'accounts'" class="topbar-account-actions">
        <button class="topbar-icon-button" data-profile-refresh title="刷新账号状态" aria-label="刷新账号状态" v-html="refreshIcon"></button>
        <button class="secondary compact" data-account-manager="global">全部设置</button>
        <button class="primary compact" data-account-manager="add">添加账号</button>
      </div>
    </div>
  </header>
</template>
