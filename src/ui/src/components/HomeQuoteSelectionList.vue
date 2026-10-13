<template>
  <section
    v-if="chips.length"
    class="home-quote-stack home-quote-stack--selection"
    aria-label="Quoted sources"
    tabindex="0"
  >
    <article
      v-for="(chip, index) in chips"
      :key="`${chip.reference.root_session_id}:${chip.reference.source_key}`"
      class="home-quote-chip"
      :data-status="chip.status"
    >
      <button
        type="button"
        class="home-quote-chip__jump"
        :disabled="!chip.canJump"
        :aria-label="`Jump to source for quote ${index + 1}`"
        @click="jumpToSource(chip.reference.source_key)"
      >
        <strong>{{ chip.reference.author }}</strong>
        <span class="home-quote-chip__excerpt">{{ chip.reference.excerpt }}</span>
      </button>
      <span class="home-quote-chip__actions">
        <button
          type="button"
          aria-label="Move quote earlier"
          :disabled="index === 0"
          @click="store.moveQuoteReference(index, -1)"
        >
          ↑
        </button>
        <button
          type="button"
          aria-label="Move quote later"
          :disabled="index === chips.length - 1"
          @click="store.moveQuoteReference(index, 1)"
        >
          ↓
        </button>
        <button
          :id="quoteRemoveId(index)"
          type="button"
          :aria-label="`Dismiss quote ${index + 1}`"
          @click="removeQuote(chip.reference, index)"
        >
          ×
        </button>
      </span>
      <small v-if="chip.message">{{ chip.message }}</small>
    </article>
  </section>
</template>

<script setup lang="ts">
import { nextTick } from "vue";
import { homeTimelineMessageDomId } from "../conversation-home-authoring.js";
import { useConversationHomeStore } from "../conversation-home-store.js";
import type { HomeQuoteReference } from "../conversation-home-types.js";

const props = defineProps<{
  chips: Array<{
    reference: HomeQuoteReference;
    status: string;
    message: string;
    canJump: boolean;
  }>;
}>();

const store = useConversationHomeStore();
const quoteRemoveId = (index: number) => `home-quote-remove-${index + 1}`;

function jumpToSource(sourceKey: HomeQuoteReference["source_key"]) {
  const element = document.getElementById(homeTimelineMessageDomId(sourceKey));
  if (!(element instanceof HTMLElement)) return;
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  element.focus({ preventScroll: true });
}

async function removeQuote(reference: HomeQuoteReference, index: number) {
  store.removeQuoteReference(reference);
  await nextTick();
  if (!props.chips.length) {
    document.querySelector<HTMLTextAreaElement>("#home-composer")?.focus();
    return;
  }
  const nextIndex = Math.min(index, props.chips.length - 1);
  document.getElementById(quoteRemoveId(nextIndex))?.focus();
}
</script>
