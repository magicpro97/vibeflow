<template>
  <section
    v-if="privateRangeOpen"
    id="home-private-range-panel"
    class="home-private-range-panel"
    aria-labelledby="home-private-range-title"
    @keydown.esc.stop="closePrivateRangePanel"
  >
    <div class="home-private-range-panel__copy">
      <strong id="home-private-range-title">
        {{ store.privateContextPresent ? "Replace private file range" : "Attach a private file range" }}
      </strong>
      <p>
        Stage an exact repo-relative excerpt for this message or new conversation. Home keeps only a
        generic presence indicator after the server accepts it.
      </p>
    </div>
    <div class="home-private-range-grid">
      <label>
        <span>File source</span>
        <select
          v-if="textAttachments.length && !usePathFallback"
          ref="privateAttachmentSelect"
          aria-label="Private range file"
          name="private-range-attachment"
          :value="selectedAttachmentName"
          @change="selectAttachment(($event.target as HTMLSelectElement).value)"
        >
          <option value="">Choose attached file</option>
          <option v-for="name in textAttachments" :key="name" :value="name">{{ name }}</option>
        </select>
        <button
          v-if="textAttachments.length"
          type="button"
          class="home-private-range-panel__source-toggle"
          @click="usePathFallback = !usePathFallback"
        >
          {{ usePathFallback ? "Choose attached file instead" : "Use repo path instead" }}
        </button>
        <span v-if="!textAttachments.length" class="home-private-range-panel__empty-source">Attach a text file above to choose it here.</span>
      </label>
      <label v-if="!textAttachments.length || usePathFallback">
        <span>{{ textAttachments.length ? "Path fallback" : "Path" }}</span>
        <input
          ref="privatePathInput"
          v-model="privateRangeDraft.path"
          type="text"
          name="private-range-path"
          autocomplete="off"
          spellcheck="false"
          placeholder="src/server.ts"
        />
        <span v-if="attachmentNames.length" class="home-private-range-panel__from-attach">
          Unsupported attachment types are excluded from private ranges.
        </span>
      </label>
      <label>
        <span>Start line</span>
        <input
          v-model.number="privateRangeDraft.startLine"
          type="number"
          min="1"
          step="1"
          inputmode="numeric"
          name="private-range-start"
        />
      </label>
      <label>
        <span>End line</span>
        <input
          v-model.number="privateRangeDraft.endLine"
          type="number"
          min="1"
          step="1"
          inputmode="numeric"
          name="private-range-end"
        />
      </label>
    </div>
    <div class="home-private-range-preview">
      <p v-if="previewLoading" class="home-private-range-preview__status">Đang đọc file…</p>
      <p v-else-if="previewError" class="home-private-range-preview__error" role="alert">
        {{ previewError }}
      </p>
      <div v-else-if="previewLines.length" class="home-private-range-preview__frame" role="group" aria-label="File preview — click a line to choose the range">
        <div
          v-for="(line, index) in previewLines"
          :key="window.from + index"
          class="home-private-range-preview__row"
          :class="{ 'home-private-range-preview__row--active': lineInRange(rangeDraft, window.from + index) }"
          :data-line="window.from + index"
          @click="pickPreviewLine(window.from + index)"
        >
          <span class="home-private-range-preview__gutter">{{ window.from + index }}</span>
          <code class="home-private-range-preview__code">{{ line }}</code>
        </div>
      </div>
      <p v-else class="home-private-range-preview__status">
        Nhập đường dẫn repo-relative để xem trước và chọn dòng.
      </p>
    </div>
    <div class="home-private-range-panel__actions">
      <button
        type="button"
        class="home-button home-button--primary"
        :disabled="privateRangeBusy"
        @click="stagePrivateRange"
      >
        {{ privateRangeBusy ? "Selecting…" : "Select range" }}
      </button>
      <button
        type="button"
        class="home-button"
        :disabled="privateRangeBusy"
        @click="resetPrivateRangeForm"
      >
        Reset
      </button>
      <button
        type="button"
        class="home-button"
        :disabled="privateRangeBusy"
        @click="closePrivateRangePanel"
      >
        Close
      </button>
    </div>
    <p v-if="privateRangeError" class="home-private-range-panel__error" role="alert">
      {{ privateRangeError }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { api } from "../api.js";
import { useHomePrivateRangeComposer } from "../composables/useHomePrivateRangeComposer.js";
import { useConversationHomeStore } from "../conversation-home-store.js";
import {
  canUseAttachmentForPrivateRange,
  privateRangePathForAttachment,
} from "../home-attachment.js";
import { useHomeAttachments } from "../home-attachments.js";
import {
  type PrivateRangePreviewDraft,
  lineInRange,
  parseFilePreviewError,
  previewWindow,
  selectRangeOnLine,
} from "../home-private-range-preview.js";

const emit = defineEmits<{ "open-change": [open: boolean] }>();
const store = useConversationHomeStore();
const { attachmentNames } = useHomeAttachments();
const textAttachments = computed(() =>
  attachmentNames.value.filter(canUseAttachmentForPrivateRange),
);
const privateAttachmentSelect = ref<HTMLSelectElement | null>(null);
const usePathFallback = ref(false);
const {
  privatePathInput,
  privateRangeOpen,
  privateRangeBusy,
  privateRangeError,
  privateRangeDraft,
  resetPrivateRangeForm,
  closePrivateRangePanel,
  openPrivateRangePanel,
  stagePrivateRange,
} = useHomePrivateRangeComposer({
  stagePrivateContext: store.stagePrivateContext,
});
const selectedAttachmentName = computed(
  () =>
    textAttachments.value.find(
      (name) => privateRangeDraft.path === privateRangePathForAttachment(name),
    ) ?? "",
);

const previewContent = ref("");
const previewLoading = ref(false);
const previewError = ref<string | null>(null);

watch(
  () => privateRangeDraft.path,
  async (path) => {
    const trimmed = path.trim();
    if (!trimmed) {
      previewContent.value = "";
      previewError.value = null;
      previewLoading.value = false;
      return;
    }
    previewLoading.value = true;
    try {
      const result = await api.readFile(trimmed, undefined, true);
      if (result.ok && result.content !== undefined && result.path === trimmed) {
        previewContent.value = result.content;
        previewError.value = null;
      } else {
        previewContent.value = "";
        previewError.value = parseFilePreviewError(result.reason);
      }
    } catch {
      previewContent.value = "";
      previewError.value = "Không thể đọc file.";
    } finally {
      previewLoading.value = false;
    }
  },
  { immediate: false },
);

const rangeDraft = computed<PrivateRangePreviewDraft>(() => ({
  path: privateRangeDraft.path,
  startLine: normalizeLine(privateRangeDraft.startLine),
  endLine: normalizeLine(privateRangeDraft.endLine),
}));
const allPreviewLines = computed(() =>
  previewContent.value ? previewContent.value.split("\n") : [],
);
const window = computed(() => previewWindow(rangeDraft.value, allPreviewLines.value.length));
const previewLines = computed(() => {
  const { from, to } = window.value;
  if (from === 0) return [];
  return allPreviewLines.value.slice(from - 1, to);
});

function normalizeLine(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null;
}

function pickPreviewLine(line: number) {
  Object.assign(privateRangeDraft, { ...selectRangeOnLine(rangeDraft.value, line) });
}

function selectAttachment(name: string) {
  if (!name) return;
  useAttachmentPath(name);
}

function useAttachmentPath(name: string) {
  Object.assign(privateRangeDraft, {
    path: privateRangePathForAttachment(name),
    startLine: 1,
    endLine: null,
  });
}

watch(
  () => attachmentNames.value.slice(),
  (names) => {
    if (
      privateRangeDraft.path.startsWith(".vibeflow/attachments/") &&
      !names.includes(privateRangeDraft.path.slice(".vibeflow/attachments/".length))
    ) {
      privateRangeDraft.path = "";
      privateRangeDraft.startLine = "";
      privateRangeDraft.endLine = "";
    }
  },
);

watch(
  privateRangeOpen,
  (open) => {
    emit("open-change", open);
    if (open) {
      usePathFallback.value = false;
      nextTick(() => privateAttachmentSelect.value?.focus() ?? privatePathInput.value?.focus());
    }
  },
  { immediate: true },
);
defineExpose({ open: openPrivateRangePanel });
</script>
