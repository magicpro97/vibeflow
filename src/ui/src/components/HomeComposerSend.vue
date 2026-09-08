<script setup lang="ts">
import type { HomeComposerBusyCopy } from "../conversation-home-loading.js";

defineProps<{
  busy: HomeComposerBusyCopy;
  sendAsNew: boolean;
  sendLabel: string;
  disabled: boolean;
}>();
</script>

<template>
  <button
    class="home-send"
    :class="{
      'home-send--labeled': sendAsNew || busy.blocksSubmit,
      'home-send--busy': busy.blocksSubmit,
    }"
    type="submit"
    :disabled="disabled"
    :aria-label="sendLabel"
    :aria-busy="busy.blocksSubmit ? 'true' : 'false'"
  >
    <template v-if="busy.blocksSubmit">
      <span class="home-send__label">{{ busy.label }}</span>
      <span class="home-send__busy" aria-hidden="true"><i /><i /><i /></span>
    </template>
    <template v-else>
      <span v-if="sendAsNew" class="home-send__label">Send as new</span>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 12-6-4 12-2-5-6-1Z" /></svg>
    </template>
  </button>
</template>