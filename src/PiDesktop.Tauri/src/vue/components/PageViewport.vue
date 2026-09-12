<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ShellPage } from "../shell";
import FeedbackStack from "./FeedbackStack.vue";
import AccountsPageBlock from "./pages/AccountsPageBlock.vue";
import CopilotPageBlock from "./pages/CopilotPageBlock.vue";
import StandardPageBlock from "./pages/StandardPageBlock.vue";
import PluginPageFrame from "./PluginPageFrame.vue";
import type { RegisteredPluginPage } from "../pluginRegistry";

const props = defineProps<{
  page: ShellPage;
  html: string;
  noticeHtml: string;
  errorHtml: string;
  pluginPage?: RegisteredPluginPage;
}>();

const pageOrder: ShellPage[] = [
  "home",
  "accounts",
  "import",
  "quality",
  "lyrics",
  "history",
  "copilot",
  "components",
  "bridge",
  "connections",
  "settings",
  "about",
];

const pageMotion = ref("");

const pageComponent = computed(() => {
  if (props.pluginPage) return PluginPageFrame;
  if (props.page === "accounts") return AccountsPageBlock;
  if (props.page === "copilot") return CopilotPageBlock;
  return StandardPageBlock;
});

watch(() => props.page, (next, previous) => {
  if (next === previous) return;
  pageMotion.value = pageOrder.indexOf(next) >= pageOrder.indexOf(previous)
    ? "page-block-forward"
    : "page-block-backward";
});
</script>

<template>
  <section id="page-content" class="content" :class="{ 'content-flush': page === 'copilot' || Boolean(pluginPage) }">
    <FeedbackStack :notice-html="noticeHtml" :error-html="errorHtml" />
    <component :is="pageComponent" :key="page" :html="html" :page="pluginPage" :class="pageMotion" />
  </section>
</template>
