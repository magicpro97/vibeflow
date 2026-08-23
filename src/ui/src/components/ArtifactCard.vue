<template>
  <article class="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-[10px] uppercase tracking-[0.24em] text-neutral-500">{{ artifact.artifact_type.replaceAll("_", " ") }}</p>
        <h3 class="mt-1 text-sm font-medium text-neutral-100">{{ artifact.artifact_id }}</h3>
        <p class="mt-1 text-[11px] text-neutral-500">
          {{ artifact.status }} · seq {{ artifact.last_seq }} · {{ new Date(artifact.ts).toLocaleString() }}
        </p>
      </div>
      <button
        type="button"
        class="btn-ghost shrink-0"
        aria-label="Open artifact trace"
        @click="$emit('show-trace', artifact.last_seq)"
      >
        Trace
      </button>
    </div>

    <div class="mt-3 flex flex-wrap gap-2">
      <button
        type="button"
        class="btn-secondary text-xs"
        :disabled="loading || !artifact.opaque_id"
        @click="togglePreview"
      >
        {{ loading ? "Loading…" : previewOpen ? "Hide preview" : "Preview" }}
      </button>
      <a
        v-if="artifact.opaque_id"
        class="btn-secondary text-xs no-underline"
        :href="artifactUrl"
        target="_blank"
        rel="noreferrer"
      >
        Download
      </a>
    </div>

    <p v-if="!artifact.opaque_id" class="mt-3 text-xs text-neutral-600">
      Preview unavailable until the runtime emits an opaque artifact reference.
    </p>
    <p v-else-if="error" class="mt-3 rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
      {{ error }}
    </p>
    <pre
      v-else-if="previewOpen && preview"
      class="mt-3 max-h-56 overflow-auto rounded border border-neutral-800 bg-neutral-950/80 p-3 text-[11px] text-neutral-300 whitespace-pre-wrap"
    >{{ preview }}</pre>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { conversationArtifactUrl } from "../conversation-api.js";
import type { ConversationArtifactView } from "../conversation-store.js";

const PREVIEW_BYTES = 48 * 1024;
const props = defineProps<{ conversationId: string; artifact: ConversationArtifactView }>();
defineEmits<{ "show-trace": [seq: number] }>();

const preview = ref("");
const previewOpen = ref(false);
const loading = ref(false);
const error = ref("");

const artifactUrl = computed(() =>
  props.artifact.opaque_id
    ? conversationArtifactUrl(props.conversationId, props.artifact.opaque_id)
    : "#",
);

async function readArtifactText(
  conversationId: string,
  opaqueId: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(conversationArtifactUrl(conversationId, opaqueId), {
    method: "GET",
    signal,
  });
  if (!response.ok) throw new Error(`artifact request failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return new TextDecoder("utf-8").decode(
    bytes.byteLength > PREVIEW_BYTES ? bytes.slice(0, PREVIEW_BYTES) : bytes,
  );
}

async function togglePreview() {
  if (!props.artifact.opaque_id) return;
  if (previewOpen.value) {
    previewOpen.value = false;
    return;
  }
  previewOpen.value = true;
  if (preview.value || loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    preview.value = await readArtifactText(props.conversationId, props.artifact.opaque_id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "artifact preview failed";
  } finally {
    loading.value = false;
  }
}
</script>
