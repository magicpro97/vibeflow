<template>
  <section class="home-changes" aria-label="Working tree changes">
    <header class="home-changes__toolbar">
      <button
        class="home-changes__refresh"
        type="button"
        aria-label="Refresh changes"
        :disabled="store.state.loading"
        @click="store.load()"
      >
        Refresh
      </button>
    </header>
    <p
      v-if="store.state.loading && store.state.entries.length === 0"
      class="home-changes__note"
      role="status"
    >
      Loading changes…
    </p>
    <p v-else-if="store.state.error" class="home-changes__error" role="alert">
      Cannot read changes: {{ store.state.error }}
    </p>
    <p v-else-if="empty" class="home-changes__note">No changes — working tree is clean.</p>
    <template v-else>
      <section v-for="group in GROUPS" :key="group.key" class="home-change-group">
        <header class="home-change-group__header">
          <strong>{{ group.label }} ({{ groups[group.key].length }})</strong>
          <button
            class="home-change-group__all"
            type="button"
            :aria-label="group.bulkLabel"
            :disabled="groups[group.key].length === 0 || store.state.staging"
            @click="mutate(group, pathsOf(group.key))"
          >
            {{ group.bulkText }}
          </button>
        </header>
        <ul class="home-change-list">
          <li
            v-for="entry in groups[group.key]"
            :key="`${group.key}:${entry.path}`"
            class="home-change-row"
          >
            <!-- The path button toggles this row's inline diff; the diff itself
                 renders below the action button (wrapped onto its own line). -->
            <button
              class="home-change-row__path"
              type="button"
              :title="entry.path"
              @click="toggleDiffRow(group, entry)"
            >
              {{ entry.path }}
            </button>
            <em class="home-change-row__badge" :data-status="badgeFor(entry, group)">
              {{ badgeFor(entry, group) }}
            </em>
            <button
              class="home-change-row__action"
              type="button"
              :aria-label="`${group.verb} ${entry.path}`"
              :disabled="store.state.staging"
              @click="mutate(group, [entry.path])"
            >
              {{ group.glyph }}
            </button>
            <template v-if="isDiffOpen(group, entry)">
              <p v-if="store.state.diffLoading" class="home-changes__note" role="status">
                Loading diff…
              </p>
              <p v-else-if="store.state.diffError" class="home-changes__error" role="alert">
                Diff unavailable: {{ store.state.diffError }}
              </p>
              <template v-else-if="store.state.diff">
                <p v-if="store.state.diff.binary" class="home-changes__note">
                  Binary file — no text diff.
                </p>
                <template v-else-if="store.state.diff.kind === 'untracked'">
                  <p class="home-changes__note">
                    Untracked — stage it to diff; preview shows content.
                  </p>
                  <p v-if="previewFor(entry).loading" class="home-changes__note" role="status">
                    Loading preview…
                  </p>
                  <p v-else-if="previewFor(entry).error" class="home-changes__error" role="alert">
                    Cannot preview: {{ previewFor(entry).error }}
                  </p>
                  <!-- Raw content, NOT a diff: an untracked file has no patch body. -->
                  <pre
                    v-else-if="previewFor(entry).text !== null"
                    class="home-diff"
                  >{{ previewFor(entry).text }}</pre>
                </template>
                <template v-else>
                  <p v-if="store.state.diff.kind === 'empty'" class="home-changes__note">
                    No changes to show.
                  </p>
                  <p v-else-if="truncatedDiff()" class="home-changes__note">
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
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { FILE_STATUS, type FileStatusLabel } from "../../../core/file-tree-contract.js";
import { filesApi } from "../api-files.js";
import { api } from "../api.js";
import { classifyDiffLines } from "../diff-lines.js";
import { createFilesStore } from "../files-store.js";
import { type ChangeGroups, type TreeFileEntry, groupChanges } from "../files-tree.js";

// Own store instance — never the Files drawer's: the panel owns its refresh,
// staging lockout, and error surface. Same deps the drawer injects.
const store = createFilesStore({
  fetchTree: () => filesApi.filesTree(),
  readFile: (path: string) => api.readFile(path),
  stagePaths: (paths: string[]) => filesApi.stageFiles(paths),
  unstagePaths: (paths: string[]) => filesApi.unstageFiles(paths),
  diffPaths: (path: string, staged: boolean, untracked: boolean) =>
    filesApi.fileDiff(path, staged, untracked),
});

// Load once at mount; `Refresh changes` re-runs it.
onMounted(() => void store.load());

// Case-insensitive path order, same comparator style as files-tree's buildTree.
const groups = computed<ChangeGroups>(() => {
  const raw = groupChanges(store.state.entries);
  const sort = (entries: TreeFileEntry[]): TreeFileEntry[] =>
    [...entries].sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  return { staged: sort(raw.staged), changes: sort(raw.changes), untracked: sort(raw.untracked) };
});

const empty = computed(
  () =>
    groups.value.staged.length + groups.value.changes.length + groups.value.untracked.length === 0,
);

// The stage/unstage routes reject a call above STAGE_BUTTON_CAP = 500 paths
// (src/server/files-git-route.ts); the frozen literal keeps the browser bundle
// free of server imports. ponytail: import a shared const if the cap ever moves.
const STAGE_PATH_CAP = 500;

interface ChangeGroupSpec {
  key: keyof ChangeGroups;
  label: string;
  bulkText: string;
  bulkLabel: string;
  verb: string;
  glyph: string;
  split: "index" | "worktree" | null;
  call: (paths: string[]) => Promise<void>;
}

const GROUPS: readonly ChangeGroupSpec[] = [
  {
    key: "staged",
    label: "Staged",
    bulkText: "Unstage all",
    bulkLabel: "Unstage all changes",
    verb: "Unstage",
    glyph: "−",
    split: "index",
    call: store.unstage,
  },
  {
    key: "changes",
    label: "Changes",
    bulkText: "Stage all",
    bulkLabel: "Stage all changes",
    verb: "Stage",
    glyph: "+",
    split: "worktree",
    call: store.stage,
  },
  {
    key: "untracked",
    label: "Untracked",
    bulkText: "Stage all",
    bulkLabel: "Stage all changes",
    verb: "Stage",
    glyph: "+",
    split: null,
    call: store.stage,
  },
];

function pathsOf(key: keyof ChangeGroups): string[] {
  return groups.value[key].map((entry) => entry.path);
}

// ≤500 paths per call so a >500-entry group still stages in one click.
async function mutate(group: ChangeGroupSpec, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += STAGE_PATH_CAP) {
    await group.call(paths.slice(i, i + STAGE_PATH_CAP));
  }
}

function badgeFor(entry: TreeFileEntry, group: ChangeGroupSpec): FileStatusLabel | undefined {
  return group.split === null ? FILE_STATUS.UNTRACKED : entry[group.split];
}

// The diff store fetches; this component only projects it onto the clicked row.
const renderedDiff = computed(() => classifyDiffLines(store.state.diff?.text ?? ""));

function isDiffOpen(group: ChangeGroupSpec, entry: TreeFileEntry): boolean {
  const target = store.state.diffFor;
  return Boolean(
    target && target.path === entry.path && target.staged === (group.key === "staged"),
  );
}

function toggleDiffRow(group: ChangeGroupSpec, entry: TreeFileEntry): void {
  const open = isDiffOpen(group, entry);
  void store.toggleDiff(entry.path, group.key === "staged", group.key === "untracked");
  // Untracked rows have no patch body: the route flags the kind and the existing
  // readFile preview supplies the content (never classified as diff text).
  if (group.key === "untracked" && !open) void store.select(entry.path);
}

function truncatedDiff(): boolean {
  return (store.state.diff?.truncated ?? false) || renderedDiff.value.truncated;
}

function previewFor(entry: TreeFileEntry): {
  loading: boolean;
  error: string | null;
  text: string | null;
} {
  // `select` writes one preview slot; a row that is not the selected path is
  // still waiting for its fetch.
  if (store.state.selected !== entry.path) return { loading: true, error: null, text: null };
  return {
    loading: store.state.previewLoading,
    error: store.state.previewError,
    text: store.state.preview,
  };
}
</script>
