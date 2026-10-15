<template>
  <div v-if="notice" class="home-rail-notice" role="status">
    <span>{{ notice }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { describeHomeCatalogDegradedNotice } from "../conversation-home-loading.js";
import { useConversationHomeStore } from "../conversation-home-store.js";

const store = useConversationHomeStore();
/**
 * A degraded catalog still lists the healthy conversations, so the rail shows a quiet notice
 * instead of the unavailable panel: partial index, read-only, ordering sharpens on recovery.
 */
const notice = computed(() => describeHomeCatalogDegradedNotice(store.catalogHealth));
</script>
