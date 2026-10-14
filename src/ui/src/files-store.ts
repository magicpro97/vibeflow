// src/ui/src/files-store.ts — reactive state for the Files panel. No HTTP here:
// the reader/fetcher are injected so tests never touch the network.
import { reactive } from "vue";
import type { TreeFileEntry } from "./files-tree.js";

interface TreeResponse {
  ok: boolean;
  entries?: TreeFileEntry[];
  truncated?: boolean;
  reason?: string;
}
interface FileResponse {
  ok: boolean;
  path?: string;
  content?: string;
  reason?: string;
}

export interface FilesStoreDeps {
  fetchTree: () => Promise<TreeResponse>;
  readFile: (path: string) => Promise<FileResponse>;
  // Optional so every existing store test still compiles; the drawer injects
  // the real client calls (filesApi.stageFiles / unstageFiles).
  stagePaths?: (paths: string[]) => Promise<{ ok: boolean; reason?: string }>;
  unstagePaths?: (paths: string[]) => Promise<{ ok: boolean; reason?: string }>;
}

export interface FilesState {
  loading: boolean;
  error: string | null;
  entries: TreeFileEntry[];
  truncated: boolean;
  filter: string;
  expanded: Set<string>;
  selected: string | null;
  preview: string | null;
  previewError: string | null;
  previewLoading: boolean;
  staging: boolean;
}

export function createFilesStore(deps: FilesStoreDeps) {
  const state = reactive<FilesState>({
    loading: false,
    error: null,
    entries: [],
    truncated: false,
    filter: "",
    expanded: new Set<string>(),
    selected: null,
    preview: null,
    previewError: null,
    previewLoading: false,
    staging: false,
  });

  async function load(): Promise<void> {
    state.loading = true;
    state.error = null;
    try {
      const res = await deps.fetchTree();
      state.entries = res.entries ?? [];
      state.truncated = res.truncated === true;
      if (!res.ok) state.error = res.reason ?? "unavailable";
    } catch (err) {
      state.entries = [];
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.loading = false;
    }
  }

  // Monotonic selection token: only the newest select() may mutate preview
  // state, so a slow earlier response can neither overwrite a newer preview
  // nor clear its previewLoading.
  let selectionSeq = 0;

  async function select(path: string): Promise<void> {
    const seq = ++selectionSeq;
    state.selected = path;
    state.preview = null;
    state.previewError = null;
    state.previewLoading = true;
    try {
      const res = await deps.readFile(path);
      if (seq !== selectionSeq) return;
      if (res.ok && typeof res.content === "string") {
        state.preview = res.content;
      } else {
        state.previewError = res.reason ?? "unavailable";
      }
    } catch (err) {
      if (seq !== selectionSeq) return;
      state.previewError = err instanceof Error ? err.message : String(err);
    } finally {
      if (seq === selectionSeq) state.previewLoading = false;
    }
  }

  function toggle(path: string): void {
    if (state.expanded.has(path)) state.expanded.delete(path);
    else state.expanded.add(path);
  }

  // One mutation at a time: a call while `staging` is set is dropped on the
  // floor (the buttons render disabled anyway). On success the tree is
  // refetched so the index column matches git; on failure the reason keeps
  // `state.error`'s existing convention. `staging` resets in `finally`, so a
  // failed call can be retried.
  async function mutate(
    call: ((paths: string[]) => Promise<{ ok: boolean; reason?: string }>) | undefined,
    paths: string[],
  ): Promise<void> {
    if (state.staging || !call) return;
    state.staging = true;
    try {
      const res = await call(paths);
      if (!res.ok) {
        state.error = res.reason ?? "unavailable";
      } else {
        await load();
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.staging = false;
    }
  }

  return {
    state,
    load,
    select,
    toggle,
    stage: (paths: string[]) => mutate(deps.stagePaths, paths),
    unstage: (paths: string[]) => mutate(deps.unstagePaths, paths),
  };
}
