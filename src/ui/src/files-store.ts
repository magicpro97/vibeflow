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

  return { state, load, select, toggle };
}
