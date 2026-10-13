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

export const filesApi = {
  filesTree: () =>
    req<{ ok: boolean; entries: FilesTreeClientEntry[]; truncated: boolean }>(
      "GET",
      "/api/files/tree",
    ),
};
