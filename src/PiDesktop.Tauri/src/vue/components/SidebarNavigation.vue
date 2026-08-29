<script setup lang="ts">
defineProps<{ html: string }>();
</script>

<template>
  <aside id="app-sidebar" class="sidebar" v-html="html"></aside>
</template>
