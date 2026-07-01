<template>
  <span class="relative inline-flex items-center group/tip" @mouseenter="checkPos" @focusin="checkPos">
    <span
      class="ml-1 text-[10px] text-neutral-600 cursor-default select-none hover:text-neutral-300 transition-colors leading-none"
      aria-label="More info"
      tabindex="0"
    >ⓘ</span>
    <span
      ref="tooltipEl"
      class="pointer-events-none absolute z-50
             w-52 sm:w-60 max-w-[min(15rem,calc(100vw-2rem))] px-3 py-2.5 rounded border border-neutral-700 bg-neutral-900
             text-xs text-neutral-200 leading-relaxed whitespace-normal
             opacity-0 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100 transition-opacity duration-150 shadow-xl
             bottom-full mb-1.5"
      :class="flipRight ? 'right-0' : 'left-0'"
      role="tooltip"
    >{{ tip }}</span>
  </span>
</template>

<script setup lang="ts">
import { ref } from "vue";

defineProps<{ tip: string }>();

const tooltipEl = ref<HTMLElement | null>(null);
const flipRight = ref(false);

function checkPos() {
  const el = tooltipEl.value;
  if (!el) return;
  // Temporarily measure: is left-0 tooltip going to overflow right?
  const iconRect = el.previousElementSibling?.getBoundingClientRect();
  if (!iconRect) return;
  const tipWidth = el.offsetWidth || 240;
  flipRight.value = iconRect.left + tipWidth > window.innerWidth - 8;
}
</script>
