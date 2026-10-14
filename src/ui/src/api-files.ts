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

export interface FilesDiffResponse {
  ok: boolean;
  diff?: string;
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
  fileDiff: (path: string, staged: boolean) =>
    req<FilesDiffResponse>(
      "GET",
      `/api/files/diff?path=${encodeURIComponent(path)}&staged=${staged ? 1 : 0}`,
    ),
};
