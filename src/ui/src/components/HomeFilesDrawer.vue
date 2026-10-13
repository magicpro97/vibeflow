<template>
  <Transition name="home-drawer">
    <aside v-if="open" class="home-files-drawer" aria-label="Repository files">
      <header>
        <span><small>Repository</small><strong>Files</strong></span>
        <button ref="closeButton" type="button" aria-label="Close files" @click="emit('close')">×</button>
      </header>
      <label class="home-files-search">
        <span class="sr-only">Filter files</span>
        <input v-model="store.state.filter" type="search" placeholder="Filter by path…" />
      </label>
      <p v-if="store.state.loading" class="home-drawer-copy" role="status">Loading file list…</p>
      <p v-else-if="store.state.error" class="home-files-error" role="alert">{{ store.state.error }}</p>
      <p v-else-if="rows.length === 0" class="home-drawer-copy">No files match.</p>
      <ul v-else class="home-files-list">
        <li v-for="row in rows" :key="row.path">
          <button
            v-if="row.kind === 'dir'"
            type="button"
            :aria-expanded="row.expanded"
            :style="{ paddingLeft: `${0.5 + row.depth * 0.75}rem` }"
            @click="store.toggle(row.path)"
          >
            <span>{{ row.expanded ? "▾" : "▸" }} {{ row.label }}</span>
          </button>
          <button
            v-else
            type="button"
            :class="{ 'is-selected': row.path === store.state.selected }"
            :style="{ paddingLeft: `${0.5 + row.depth * 0.75}rem` }"
            @click="store.select(row.path)"
          >
            <span>{{ row.label }}</span>
            <em v-if="row.status" :data-status="row.status">{{ row.status }}</em>
          </button>
        </li>
      </ul>
      <p v-if="store.state.truncated" class="home-drawer-copy">
        Listing capped at 5000 files — narrow with the filter or use a terminal.
      </p>
      <section v-if="store.state.selected" class="home-files-preview" aria-label="Preview">
        <header>
          <code>{{ store.state.selected }}</code>
          <button type="button" @click="copyPath">Copy path</button>
          <button type="button" :disabled="store.state.preview === null" @click="download">
            Download
          </button>
        </header>
        <p v-if="store.state.previewLoading" class="home-drawer-copy" role="status">Loading…</p>
        <p v-else-if="store.state.previewError" class="home-files-error" role="alert">
          Cannot preview: {{ store.state.previewError }}
        </p>
        <pre v-else>{{ store.state.preview }}</pre>
      </section>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { filesApi } from "../api-files.js";
import { api } from "../api.js";
import { createFilesStore } from "../files-store.js";
import { panelRows } from "../files-tree.js";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

// The store takes injectable deps; production wires the real clients here.
// GET /api/file contracts (src/server/file-route.ts): 200 {ok:true, content} |
// 200 {ok:false, reason:"binary"} | 404/403/413 {error} — the last three make
// req() THROW (api.ts:48-61), which the store surfaces as previewError.
const store = createFilesStore({
  fetchTree: () => filesApi.filesTree(),
  readFile: (path: string) => api.readFile(path),
});

const closeButton = ref<HTMLButtonElement | null>(null);

const rows = computed(() =>
  panelRows(store.state.entries, store.state.expanded, store.state.filter),
);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    if (store.state.entries.length === 0) await store.load();
    await nextTick();
    closeButton.value?.focus();
  },
  { immediate: true },
);

async function copyPath(): Promise<void> {
  if (store.state.selected && navigator.clipboard) {
    await navigator.clipboard.writeText(store.state.selected);
  }
}

function download(): void {
  const path = store.state.selected;
  const content = store.state.preview;
  if (!path || content === null) return;
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = path.split("/").pop() ?? "file.txt";
  a.click();
  URL.revokeObjectURL(url);
}
</script>
