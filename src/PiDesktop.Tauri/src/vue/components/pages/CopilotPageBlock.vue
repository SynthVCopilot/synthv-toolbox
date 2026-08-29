<script setup lang="ts">
defineProps<{ html: string }>();
</script>

<template>
  <div class="right-page-block copilot-page-block" v-html="html"></div>
</template>
