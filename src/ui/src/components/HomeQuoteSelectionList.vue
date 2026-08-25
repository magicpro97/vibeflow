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
      class="home-quote-card"
      :data-status="chip.status"
    >
      <header>
        <strong>Quote {{ index + 1 }}</strong>
        <small>{{ chip.reference.author }} · Revision {{ chip.reference.revision_ordinal + 1 }}</small>
      </header>
      <p>{{ chip.reference.excerpt }}</p>
      <small>{{ chip.message }}</small>
      <div class="home-quote-card__actions">
        <button
          type="button"
          class="home-button"
          :aria-label="`Jump to source for quote ${index + 1}`"
          :disabled="!chip.canJump"
          @click="jumpToSource(chip.reference.source_key)"
        >
          Jump to source
        </button>
        <button
          type="button"
          class="home-button"
          :aria-label="`Move quote ${index + 1} earlier`"
          :disabled="index === 0"
          @click="store.moveQuoteReference(index, -1)"
        >
          Move earlier
        </button>
        <button
          type="button"
          class="home-button"
          :aria-label="`Move quote ${index + 1} later`"
          :disabled="index === chips.length - 1"
          @click="store.moveQuoteReference(index, 1)"
        >Move later</button>
        <button
          :id="quoteRemoveId(index)"
          type="button"
          class="home-button"
          :aria-label="`Remove quote ${index + 1}`"
          @click="removeQuote(chip.reference, index)"
        >Remove</button>
      </div>
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
