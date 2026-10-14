<template>
  <section class="home-files-panel" aria-label="Repository files">
    <label class="home-files-search">
      <span class="sr-only">Filter files</span>
      <input
        v-model="store.state.filter"
        class="home-input"
        type="search"
        placeholder="Filter by path…"
      />
    </label>
    <p v-if="store.state.loading" class="home-drawer-copy" role="status">Loading file list…</p>
    <p v-else-if="store.state.error" class="home-files-error" role="alert">{{ store.state.error }}</p>
    <p v-else-if="rows.length === 0" class="home-drawer-copy">No files match.</p>
    <ul v-else class="home-files-list">
      <li v-for="row in rows" :key="row.path" class="home-files-row">
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
        <button
          v-if="diffable(row)"
          class="home-files-row__diff"
          type="button"
          :aria-label="`Diff ${row.path}`"
          @click="store.toggleDiff(row.path, false)"
        >
          Diff
        </button>
        <!-- Inline diff under the toggled row; same renderer contract as the
             Changes panel (the store's diff slot is per store instance). -->
        <template v-if="diffOpen(row)">
          <p v-if="store.state.diffLoading" class="home-drawer-copy" role="status">Loading diff…</p>
          <p v-else-if="store.state.diffError" class="home-files-error" role="alert">
            Diff unavailable: {{ store.state.diffError }}
          </p>
          <template v-else-if="store.state.diff">
            <p v-if="store.state.diff.binary" class="home-drawer-copy">Binary file — no text diff.</p>
            <template v-else>
              <p v-if="store.state.diff.kind === 'empty'" class="home-drawer-copy">
                No changes to show.
              </p>
              <p v-else-if="truncatedDiff()" class="home-drawer-copy">
                Diff truncated — showing the first lines.
              </p>
              <pre v-if="renderedDiff.lines.length > 0" class="home-diff"
                ><span
                  v-for="(line, index) in renderedDiff.lines"
                  :key="index"
                  :class="`home-diff--${line.kind}`"
                  >{{ line.text }}</span
                ></pre>
            </template>
          </template>
        </template>
      </li>
    </ul>
    <p v-if="store.state.truncated" class="home-drawer-copy">
      Listing capped at {{ FILE_TREE_MAX_ENTRIES }} files — the filter cannot reach omitted
      entries; search externally.
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
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { FILE_STATUS, FILE_TREE_MAX_ENTRIES } from "../../../core/file-tree-contract.js";
import { filesApi } from "../api-files.js";
import { api } from "../api.js";
import { classifyDiffLines } from "../diff-lines.js";
import { createFilesStore } from "../files-store.js";
import { type PanelRow, panelRows } from "../files-tree.js";

// Own store instance — never the Changes panel's: the diff slot and the
// selection token live on the instance, so a Files-tab toggle cannot disturb
// the Changes tab. Same deps the panel injects there.
const store = createFilesStore({
  fetchTree: () => filesApi.filesTree(),
  readFile: (path: string) => api.readFile(path),
  diffPaths: (path: string, staged: boolean, untracked: boolean) =>
    filesApi.fileDiff(path, staged, untracked),
});

// Load once at mount; the sidebar keeps the instance alive across tab switches.
onMounted(() => void store.load());

const rows = computed(() =>
  panelRows(store.state.entries, store.state.expanded, store.state.filter),
);

// The store fetches; this component only projects it onto the clicked row.
const renderedDiff = computed(() => classifyDiffLines(store.state.diff?.text ?? ""));

// Only a tracked file whose combined status is `modified` has a worktree patch
// body worth fetching (untracked rows have none).
function diffable(row: PanelRow): boolean {
  return row.kind === "file" && row.status === FILE_STATUS.MODIFIED;
}

// This panel always diffs the worktree side, so `staged` is always false.
function diffOpen(row: PanelRow): boolean {
  const target = store.state.diffFor;
  return Boolean(target && target.path === row.path && target.staged === false);
}

function truncatedDiff(): boolean {
  return (store.state.diff?.truncated ?? false) || renderedDiff.value.truncated;
}

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
