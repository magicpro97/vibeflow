<script setup lang="ts">
import { computed } from "vue";
import type { HomeParticipant } from "../conversation-home-types.js";
import { emptyComposerSuggestionHint } from "../home-composer-suggestions.js";

const props = defineProps<{
  draft: string;
  participants: readonly HomeParticipant[];
}>();

const hint = computed(() => emptyComposerSuggestionHint(props.draft, props.participants));
</script>

<template>
  <p v-if="hint" class="home-composer__suggestion-hint">{{ hint }}</p>
</template>