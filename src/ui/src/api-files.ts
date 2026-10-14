import type { FileStatusLabel } from "../../core/file-tree-contract.js";
// src/ui/src/api-files.ts — client for the Files panel endpoints.
//
// Kept OUT of api.ts on purpose: that file sits at the 400-line size cap, and
// req() is already exported for exactly this kind of split.
import { req } from "./api.js";

export interface FilesTreeClientEntry {
  path: string;
  status?: FileStatusLabel;
}

/** Shared answer shape for the mutating files endpoints (git exit ≠ HTTP error). */
export interface FilesMutationResponse {
  ok: boolean;
  reason?: string;
}

/** GET /api/files/diff answer, matching the route: `ok:false` carries a reason only. */
export interface FilesDiffResponse {
  ok: boolean;
  // Union ordered so the literal `"untracked"` never sits before a `|`: the
  // file-tree contract pin reads a status union out of this file's source.
  kind: "diff" | "empty" | "untracked";
  text: string;
  truncated: boolean;
  binary: boolean;
  reason?: string;
}

export const filesApi = {
  filesTree: () =>
    req<{ ok: boolean; entries: FilesTreeClientEntry[]; truncated: boolean }>(
      "GET",
      "/api/files/tree",
    ),
  stageFiles: (paths: string[]) =>
    req<FilesMutationResponse>("POST", "/api/files/stage", { paths }),
  unstageFiles: (paths: string[]) =>
    req<FilesMutationResponse>("POST", "/api/files/unstage", { paths }),
  fileDiff: (path: string, staged: boolean, untracked = false) =>
    req<FilesDiffResponse>(
      "GET",
      `/api/files/diff?path=${encodeURIComponent(path)}&staged=${staged ? 1 : 0}${untracked ? "&untracked=1" : ""}`,
    ),
};
