<script setup lang="ts">
defineProps<{ html: string }>();
</script>

<template>
  <div id="overlay-layer" v-html="html"></div>
</template>
