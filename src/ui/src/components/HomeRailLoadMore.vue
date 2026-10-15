<template>
  <div v-if="store.paging.catalog.nextCursor" class="home-rail-state">
    <button
      type="button"
      class="home-button"
      :disabled="store.paging.catalog.loadingMore"
      @click="store.loadMoreSessions()"
    >{{ store.paging.catalog.loadingMore ? "Loading…" : "Load more conversations" }}</button>
  </div>
</template>

<script setup lang="ts">
import { useConversationHomeStore } from "../conversation-home-store.js";

const store = useConversationHomeStore();
</script>
