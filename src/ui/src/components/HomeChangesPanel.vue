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
            <!-- Phase D wires the inline diff onto this button; until then selection is inert. -->
            <button class="home-change-row__path" type="button" :title="entry.path">
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
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { FILE_STATUS, type FileStatusLabel } from "../../../core/file-tree-contract.js";
import { api } from "../api.js";
import { filesApi } from "../api-files.js";
import { createFilesStore } from "../files-store.js";
import { groupChanges, type ChangeGroups, type TreeFileEntry } from "../files-tree.js";

// Own store instance — never the Files drawer's: the panel owns its refresh,
// staging lockout, and error surface. Same deps the drawer injects.
const store = createFilesStore({
  fetchTree: () => filesApi.filesTree(),
  readFile: (path: string) => api.readFile(path),
  stagePaths: (paths: string[]) => filesApi.stageFiles(paths),
  unstagePaths: (paths: string[]) => filesApi.unstageFiles(paths),
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
</script>
