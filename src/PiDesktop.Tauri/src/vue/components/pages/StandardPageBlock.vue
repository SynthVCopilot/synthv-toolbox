<script setup lang="ts">
defineProps<{ html: string }>();
</script>

<template>
  <div class="right-page-block standard-page-block" v-html="html"></div>
</template>
