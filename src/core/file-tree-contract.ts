/** Dependency-free Files-panel vocabulary shared by the server route and the browser drawer. */
const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const FILE_STATUS = Object.freeze({
  MODIFIED: "modified",
  ADDED: "added",
  DELETED: "deleted",
  UNTRACKED: "untracked",
  RENAMED: "renamed",
} as const);
export type FileStatusLabel = (typeof FILE_STATUS)[keyof typeof FILE_STATUS];

/** `git status --porcelain` XY pairs git emits for an unmerged (conflicted) path. */
export const UNMERGED_PORCELAIN_CODES = Object.freeze([
  "DD",
  "AU",
  "UD",
  "UA",
  "DU",
  "AA",
  "UU",
] as const);
export type UnmergedPorcelainCode = (typeof UNMERGED_PORCELAIN_CODES)[number];
export const isUnmergedPorcelainCode = (value: unknown): value is UnmergedPorcelainCode =>
  memberOf(UNMERGED_PORCELAIN_CODES, value);

/** A porcelain XY code split into its staged (index) and unstaged (worktree) halves. */
export interface FileChangeSplit {
  index?: FileStatusLabel;
  worktree?: FileStatusLabel;
  untracked?: boolean;
}

/** Split a porcelain XY code into index/worktree labels; unmerged or unknown → undefined halves. */
export function splitPorcelain(code: string): FileChangeSplit {
  if (code === "??") return { untracked: true };
  if (isUnmergedPorcelainCode(code)) return {};
  const half = (c: string): FileStatusLabel | undefined =>
    c === "M"
      ? FILE_STATUS.MODIFIED
      : c === "A"
        ? FILE_STATUS.ADDED
        : c === "D"
          ? FILE_STATUS.DELETED
          : c === "R"
            ? FILE_STATUS.RENAMED
            : c === "T"
              ? FILE_STATUS.MODIFIED
              : undefined;
  return { index: half(code[0] ?? ""), worktree: half(code[1] ?? "") };
}

/** Upper bound on listed entries; also rendered in the drawer's truncation copy. */
export const FILE_TREE_MAX_ENTRIES = 5000;
