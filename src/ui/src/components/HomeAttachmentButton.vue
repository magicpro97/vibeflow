<script setup lang="ts">
import { computed, ref } from "vue";
import type { Engine } from "../../../core/agent-contract.js";
import { engineAttachmentSupport } from "../../../core/attachment-support.js";
import { api } from "../api.js";
import { HOME_ENGINE_AUTO, useHomeEngines } from "../composables/useHomeEngines.js";
import type { AttachmentEngineRow } from "../home-attachment.js";
import {
  attachmentPickerAccept,
  gateAttachment,
  resolveAttachmentEngine,
} from "../home-attachment.js";
import { useHomeAttachments } from "../home-attachments.js";

const props = defineProps<{
  disabled: boolean;
}>();

const { add } = useHomeAttachments();
const { selection, statuses, pick } = useHomeEngines();
const fileInput = ref<HTMLInputElement | null>(null);
const hint = ref("");
const uploading = ref(false);

const autoMode = computed(() => selection.value === HOME_ENGINE_AUTO);
const rows = computed<AttachmentEngineRow[]>(() =>
  statuses.value.map((row) => ({
    engine: row.engine,
    ready: row.level === "ready",
    admitted: row.available,
  })),
);
const resolvedEngine = computed<Engine | null>(() => {
  if (selection.value === HOME_ENGINE_AUTO)
    return resolveAttachmentEngine(HOME_ENGINE_AUTO, rows.value);
  return selection.value;
});
const support = computed(() =>
  resolvedEngine.value ? engineAttachmentSupport(resolvedEngine.value) : null,
);

/** A CLI with no attachment support hides the button entirely. */
const visible = computed(() => support.value !== null && resolvedEngine.value !== null);
const accept = computed(() => (support.value ? attachmentPickerAccept(support.value) : ""));
const buttonTitle = computed(() => {
  if (!visible.value) return "";
  const engine = String(resolvedEngine.value);
  return autoMode.value
    ? `Attach a file; auto picks a CLI that supports it (${engine})`
    : `Attach a file (${engine})`;
});

function pickFile() {
  hint.value = "";
  fileInput.value?.click();
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const gate = gateAttachment(file.name, resolvedEngine.value, rows.value, autoMode.value);
  if (!gate.ok) {
    hint.value = gate.reason;
    return;
  }
  // Auto mode may pick a different, capable CLI for this file.
  if (autoMode.value) pick(gate.engine);
  uploading.value = true;
  try {
    const result = await api.upload(file);
    const attachment = result.attachment as { name: string; size: number };
    hint.value = `Attached ${attachment.name}`;
    add(attachment.name);
  } catch (error) {
    hint.value = error instanceof Error ? error.message : "Upload failed";
  } finally {
    uploading.value = false;
  }
}
</script>

<template>
  <span v-if="visible" class="home-attach">
    <button
      type="button"
      :disabled="props.disabled || uploading"
      :title="buttonTitle"
      :aria-label="`Attach a file (${String(resolvedEngine)})`"
      @click="pickFile"
    >
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M9 4v8a2 2 0 0 0 4 0V5a4 4 0 0 0-8 0v8a6 6 0 0 0 12 0V4h2v9a8 8 0 0 1-16 0V4h2Z" /></svg>
      Attach
    </button>
    <input
      ref="fileInput"
      class="home-attach__input"
      type="file"
      :accept="accept"
      :aria-label="`Attach a file (${String(resolvedEngine)})`"
      :disabled="props.disabled || uploading"
      @change="onFile"
    />
    <span v-if="hint" class="home-attach__hint" role="status">{{ hint }}</span>
  </span>
</template>