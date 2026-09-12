<script setup lang="ts">
import { useHomeAttachments } from "../home-attachments.js";

const { attachmentNames, remove } = useHomeAttachments();
</script>

<template>
  <div
    v-if="attachmentNames.length"
    class="home-composer__attachments"
    aria-label="Attached files"
  >
    <span
      v-for="name in attachmentNames"
      :key="name"
      class="home-composer__attachment"
    >
      {{ name }}
      <button
        type="button"
        :aria-label="`Remove attachment ${name}`"
        title="Remove attachment"
        @click="remove(name)"
      >
        Remove
      </button>
    </span>
  </div>
</template>