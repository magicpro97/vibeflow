<template>
  <div class="home-message-quotes" aria-label="Persisted quoted sources">
    <article
      v-for="quote in quoteRefs"
      :key="`${quote.quotingMessageId}-${quote.quoteOrder}-${quote.target.target_event_id}`"
      class="home-message-quote"
    >
      <header>
        <strong>Quote {{ quote.quoteOrder }}</strong>
        <small>{{ author(quote.target) }}</small>
      </header>
      <p>{{ quote.target.preview_text }}</p>
      <button type="button" class="home-button" @click="$emit('jump', quote.target.target_event_id)">
        Jump to source
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
