<template>
  <div class="home-collapsible">
    <p>{{ expanded ? body : preview }}</p>
    <button type="button" class="home-button" :aria-expanded="expanded" @click="expanded = !expanded">
      {{ expanded ? "Show less" : "Show full answer" }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { collapsePreview } from "../lib/message-collapse.js";

const props = defineProps<{ body: string }>();
const expanded = ref(false);
const preview = computed(() => collapsePreview(props.body));
</script>
