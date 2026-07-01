<template>
  <nav class="flex items-center overflow-x-hidden" aria-label="Progress">
    <template v-for="(step, i) in steps" :key="step.n">
      <!-- Connector -->
      <div
        v-if="i > 0"
        class="w-6 md:w-10 h-px mx-0.5 md:mx-1 flex-shrink-0 transition-colors duration-300"
        :class="stage > step.n - 1 ? 'bg-neutral-600' : 'bg-neutral-800/80'"
      />

      <!-- Step -->
      <button
        type="button"
        class="flex items-center gap-1.5 px-2 py-1 rounded transition-all duration-150 select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-950"
        :class="
          stage === step.n
            ? 'text-white bg-white/[0.08]'
            : store.isStageReachable(step.n)
              ? 'text-neutral-400 hover:text-neutral-200 cursor-pointer'
              : 'text-neutral-600 cursor-default'
        "
        :disabled="!store.isStageReachable(step.n)"
        :tabindex="!store.isStageReachable(step.n) ? -1 : 0"
        :aria-current="stage === step.n ? 'step' : undefined"
        :aria-label="`${step.label} — ${stage > step.n ? 'completed' : stage === step.n ? 'current' : 'not yet available'}`"
        @click="store.isStageReachable(step.n) && stage !== step.n && $emit('select', step.n)"
      >
        <span class="w-4 flex items-center justify-center flex-shrink-0">
          <span v-if="stage > step.n" class="text-[10px] text-neutral-600">✓</span>
          <span v-else-if="stage === step.n" class="w-1.5 h-1.5 rounded-full bg-white block" />
          <span v-else class="w-1 h-1 rounded-full bg-neutral-700 block mx-auto" />
        </span>
        <span class="text-[11px] hidden lg:inline" :class="stage === step.n ? 'font-medium' : ''">{{ step.label }}</span>
      </button>
    </template>
  </nav>
</template>

<script setup lang="ts">
import { useVfStore } from "../store.js";

defineProps<{ stage: 1 | 2 | 3 | 4 }>();
defineEmits<{ select: [n: 1 | 2 | 3 | 4] }>();

const store = useVfStore();

const steps: { n: 1 | 2 | 3 | 4; label: string }[] = [
  { n: 1, label: "Describe" },
  { n: 2, label: "Plan" },
  { n: 3, label: "Run" },
  { n: 4, label: "Verify" },
];
</script>
