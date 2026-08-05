<template>
  <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" role="dialog" aria-modal="true" aria-labelledby="curator-setup-title">
    <div class="w-full max-w-3xl rounded border border-neutral-800 bg-neutral-950 p-5">
      <h2 id="curator-setup-title" class="font-semibold text-neutral-100">Review CI Curator workflow</h2>
      <p class="mt-2 text-xs text-neutral-400">Review exact file diff. No file changes until confirmation.</p>
      <p v-if="preview.existing" class="mt-2 text-xs text-amber-300">Workflow already exists. Confirming replaces it with reviewed content.</p>
      <pre class="mt-3 max-h-[55vh] overflow-auto rounded border border-neutral-800 bg-neutral-900 p-3 text-[11px] leading-5 text-neutral-300 whitespace-pre-wrap">{{ preview.diff }}</pre>
      <label class="mt-4 block text-xs text-neutral-300">
        Type <code>{{ preview.confirmation }}</code> to continue
        <input v-model="confirmation" class="mt-1 w-full rounded border border-neutral-700 bg-transparent px-2 py-1 font-mono text-neutral-100" aria-label="CI workflow confirmation" />
      </label>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="px-3 py-1.5 text-xs text-neutral-400" @click="$emit('cancel')">Cancel</button>
        <button type="button" class="btn-primary" :disabled="confirmation !== preview.confirmation" @click="$emit('apply', confirmation)">Create workflow</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import type { CuratorSetupPreview } from "../types.js";

defineProps<{ preview: CuratorSetupPreview }>();
defineEmits<{ cancel: []; apply: [confirmation: string] }>();
const confirmation = ref("");
</script>
