<template>
  <section v-if="store.privateContextPresent" class="home-quote-stack" aria-label="Private file range">
    <article class="home-quote-card" data-status="ready">
      <header>
        <strong>Private file range ready</strong>
        <small>Bound privately to this exact send</small>
      </header>
      <p>
        VibeFlow has staged one private excerpt. Its path, line range, and content are not retained in
        Home or exposed on the public timeline.
      </p>
      <div class="home-quote-card__actions">
        <button type="button" class="home-button" :disabled="store.privateContextDiscarding" @click="$emit('change')">Change</button>
        <button
          type="button"
          class="home-button"
          :disabled="store.privateContextDiscarding"
          @click="store.discardPrivateContext()"
        >
          {{ store.privateContextDiscarding ? "Removing…" : "Remove" }}
        </button>
      </div>
    </article>
  </section>
</template>

<script setup lang="ts">
import { useConversationHomeStore } from "../conversation-home-store.js";

defineEmits<{ change: [] }>();
const store = useConversationHomeStore();
</script>
