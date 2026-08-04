<template>
  <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" role="dialog" aria-modal="true" aria-labelledby="policy-diff-title">
    <div class="w-full max-w-lg rounded border border-neutral-800 bg-neutral-950 p-5">
      <h2 id="policy-diff-title" class="font-semibold text-neutral-100">Review policy changes</h2>
      <p class="mt-2 text-xs text-neutral-400">Changes apply only after approval.</p>
      <ul class="mt-3 space-y-2 text-xs">
        <li v-for="entry in preview.diff" :key="entry.field" class="rounded border border-neutral-800 p-2">
          <div class="font-mono text-neutral-200">{{ entry.field }}</div>
          <div class="mt-1 break-all text-neutral-500">{{ JSON.stringify(entry.before) }} → {{ JSON.stringify(entry.after) }}</div>
        </li>
      </ul>
      <label v-if="preview.relaxation" class="mt-4 block text-xs text-amber-300">
        Type <code>ALLOW POLICY RELAXATION</code> to continue
        <input v-model="confirmation" class="mt-1 w-full rounded border border-neutral-700 bg-transparent px-2 py-1 text-neutral-100" />
      </label>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="px-3 py-1.5 text-xs text-neutral-400" @click="$emit('cancel')">Cancel</button>
        <button type="button" class="btn-primary" :disabled="preview.relaxation && confirmation !== confirmationText" @click="$emit('apply', confirmation)">Apply</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";

const confirmationText = "ALLOW POLICY RELAXATION";
defineProps<{ preview: import("../types.js").PolicyPreview }>();
defineEmits<{ cancel: []; apply: [confirmation: string] }>();
const confirmation = ref("");
</script>
