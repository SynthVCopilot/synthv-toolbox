<script setup lang="ts">
import { computed, ref, watch } from "vue";
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

const pageOrder: ShellPage[] = [
  "home",
  "accounts",
  "toolbox",
  "lyrics",
  "history",
  "copilot",
  "components",
  "bridge",
  "mcp",
  "settings",
];

const pageTransition = ref("page-block-forward");

const pageComponent = computed(() => {
  if (props.page === "accounts") return AccountsPageBlock;
  if (props.page === "copilot") return CopilotPageBlock;
  return StandardPageBlock;
});

watch(() => props.page, (next, previous) => {
  if (next === previous) return;
  pageTransition.value = pageOrder.indexOf(next) >= pageOrder.indexOf(previous)
    ? "page-block-forward"
    : "page-block-backward";
});
</script>

<template>
  <section id="page-content" class="content" :class="{ 'content-flush': page === 'copilot' }">
    <FeedbackStack :notice-html="noticeHtml" :error-html="errorHtml" />
    <div class="page-block-host">
      <Transition :name="pageTransition">
        <component :is="pageComponent" :key="page" :html="html" />
      </Transition>
    </div>
  </section>
</template>
