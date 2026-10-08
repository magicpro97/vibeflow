<template>
  <nav v-if="entries.length > 1" class="home-prompt-rail" aria-label="Prompts in this conversation">
    <button
      v-for="entry in entries"
      :key="entry.id"
      type="button"
      class="home-prompt-rail__tick"
      :data-label="entry.label"
      :title="entry.label"
      @click="$emit('jump', entry.anchorKey)"
    >
      <span class="sr-only">Jump to prompt: {{ entry.label }}</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import type { PromptRailEntry } from "../lib/prompt-rail.js";

defineProps<{ entries: PromptRailEntry[] }>();
defineEmits<{ jump: [anchorKey: string] }>();
</script>
