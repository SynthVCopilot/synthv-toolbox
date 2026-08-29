<script setup lang="ts">
defineProps<{ noticeHtml: string; errorHtml: string }>();
</script>

<template>
  <div v-if="noticeHtml || errorHtml" class="feedback-stack" aria-live="polite">
    <div v-if="noticeHtml" v-html="noticeHtml"></div>
    <div v-if="errorHtml" v-html="errorHtml"></div>
  </div>
</template>
