<script setup lang="ts">
import { icon } from "../../icons";
import { useI18n } from "vue-i18n";

defineProps<{ title: string; subtitle: string; page: string; busy: boolean }>();
const refreshIcon = icon("sync", 17);
const { t } = useI18n();
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
          <span>{{ t("header.processing") }}</span>
        </div>
      </Transition>
      <div v-if="page === 'accounts'" class="topbar-account-actions">
        <button class="topbar-icon-button" data-profile-refresh :title="t('accounts.refresh')" :aria-label="t('accounts.refresh')" v-html="refreshIcon"></button>
        <button class="secondary compact" data-account-manager="global">{{ t("header.allSettings") }}</button>
        <button class="primary compact" data-account-manager="add">{{ t("header.addAccount") }}</button>
      </div>
    </div>
  </header>
</template>
