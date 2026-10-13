<template>
  <div class="home-message-quotes" aria-label="Persisted quoted sources">
    <article
      v-for="quote in quoteRefs"
      :key="`${quote.quotingMessageId}-${quote.quoteOrder}-${quote.target.target_event_id}`"
      class="home-quote-chip"
    >
      <button
        type="button"
        class="home-quote-chip__jump"
        :aria-label="`Jump to source for quote ${quote.quoteOrder}`"
        @click="$emit('jump', quote.target.target_event_id)"
      >
        <strong>{{ author(quote.target) }}</strong>
        <span class="home-quote-chip__excerpt">{{ quote.target.preview_text }}</span>
      </button>
    </article>
  </div>
</template>

<script setup lang="ts">
import type { HomeQuoteProjection } from "../conversation-home-types.js";

defineProps<{
  quoteRefs: Array<{ quotingMessageId: string; quoteOrder: number; target: HomeQuoteProjection }>;
  author: (target: HomeQuoteProjection) => string;
}>();
defineEmits<{ jump: [targetEventId: string] }>();
</script>
