<template>
  <div
    class="home-loading-panel"
    :class="`home-loading-panel--${variant}`"
    role="status"
    aria-live="polite"
    :aria-label="variant === 'thread' ? 'Loading conversation' : undefined"
  >
    <header class="home-loading-panel__header">
      <span>{{ eyebrow }}</span>
      <strong>{{ title }}</strong>
    </header>
    <p class="home-loading-panel__copy">{{ detail }}</p>
    <ul class="home-loading-panel__checkpoints" :aria-label="listLabel">
      <li v-for="checkpoint in checkpoints" :key="checkpoint">{{ checkpoint }}</li>
    </ul>
    <div v-if="variant === 'thread'" class="home-loading-thread" aria-hidden="true">
      <article data-tone="human">
        <span class="home-loading-thread__avatar">Y</span>
        <div class="home-loading-thread__copy">
          <strong />
          <small />
          <span class="home-loading-thread__line" />
          <span class="home-loading-thread__line home-loading-thread__line--short" />
        </div>
      </article>
      <article data-tone="assistant">
        <span class="home-loading-thread__avatar">AI</span>
        <div class="home-loading-thread__copy">
          <strong />
          <small />
          <span class="home-loading-thread__line" />
          <span class="home-loading-thread__line home-loading-thread__line--medium" />
        </div>
      </article>
      <article data-tone="system">
        <span class="home-loading-thread__avatar">+</span>
        <div class="home-loading-thread__copy">
          <strong />
          <small />
          <span class="home-loading-thread__line home-loading-thread__line--medium" />
        </div>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  variant: "welcome" | "thread";
  eyebrow: string;
  title: string;
  detail: string;
  checkpoints: readonly string[];
  listLabel: string;
}>();
</script>
