<script setup lang="ts">
import { computed } from "vue";
import type { ShellPage } from "../shell";
import FeedbackStack from "./FeedbackStack.vue";
import AccountsPageBlock from "./pages/AccountsPageBlock.vue";
import CopilotPageBlock from "./pages/CopilotPageBlock.vue";
import StandardPageBlock from "./pages/StandardPageBlock.vue";

const props = defineProps<{
  page: ShellPage;
  html: string;
  noticeHtml: string;
  errorHtml: string;
}>();

const pageComponent = computed(() => {
  if (props.page === "accounts") return AccountsPageBlock;
  if (props.page === "copilot") return CopilotPageBlock;
  return StandardPageBlock;
});
</script>

<template>
  <section id="page-content" class="content" :class="{ 'content-flush': page === 'copilot' }">
    <FeedbackStack :notice-html="noticeHtml" :error-html="errorHtml" />
    <Transition name="page-block" mode="out-in">
      <component :is="pageComponent" :key="page" :html="html" />
    </Transition>
  </section>
</template>
