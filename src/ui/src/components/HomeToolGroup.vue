<template>
  <section class="home-tool-group">
    <details>
      <summary class="home-tool-group__summary">
        <strong>{{ item.title }}</strong>
        <small>{{ item.body }}</small>
      </summary>
      <ul class="home-tool-group__list">
        <li v-for="tool in item.tools ?? []" :key="tool.id" :data-status="tool.status">
          <strong>{{ tool.tool }}</strong>
          <span class="home-tool-group__action">{{ tool.action }}</span>
          <span class="home-tool-group__status">{{ tool.status }}</span>
        </li>
      </ul>
    </details>
  </section>
</template>

<script setup lang="ts">
import type { RenderedHomeTimelineItem } from "../conversation-home-projection.js";

defineProps<{ item: RenderedHomeTimelineItem }>();
</script>
