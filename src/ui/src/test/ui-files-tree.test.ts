const { describe, expect, test } = await import(String("bun:test"));
const { buildTree, filterPaths, groupChanges, panelRows } = await import("../files-tree.js");
import {
  FILE_STATUS,
  FILE_TREE_MAX_ENTRIES,
  type FileStatusLabel,
} from "../../../../src/core/file-tree-contract.js";
import type { DirNode, TreeNode } from "../files-tree.js";
import type { TreeFileEntry } from "../files-tree.js";

/** Find a dir node by path, failing loudly — no non-null assertions (biome bans them). */
function dirOf(nodes: TreeNode[], path: string): DirNode {
  const node = nodes.find((n) => n.path === path);
  if (!node || node.kind !== "dir") throw new Error(`expected dir ${path}`);
  return node;
}

describe("buildTree", () => {
  test("folds flat paths into nested dir nodes; dirs first, statuses survive", () => {
    const nodes = buildTree([
      { path: "src/a.ts", status: "modified" },
      { path: "src/deep/b.ts" },
      { path: "README.md" },
    ]);
    expect(nodes.map((n) => `${n.kind}:${n.path}`)).toEqual(["dir:src", "file:README.md"]);
    const src = dirOf(nodes, "src");
    expect(src.children.map((c) => `${c.kind}:${c.path}`)).toEqual([
      "dir:src/deep",
      "file:src/a.ts",
    ]);
    const file = src.children.find((c) => c.kind === "file");
    expect(file?.status).toBe("modified");
  });

  test("sorts same-kind siblings case-insensitively (dirs, then files)", () => {
    const nodes = buildTree([
      { path: "b.txt" },
      { path: "a.txt" },
      { path: "z/f.txt" },
      { path: "m/g.txt" },
    ]);
    expect(nodes.map((n) => n.path)).toEqual(["m", "z", "a.txt", "b.txt"]);
  });
});

describe("filterPaths", () => {
  test("case-insensitive substring match, empty query keeps all", () => {
    const entries = [{ path: "src/App.tsx" }, { path: "docs/readme.md" }];
    expect(filterPaths(entries, "")).toHaveLength(2);
    expect(filterPaths(entries, "app").map((e) => e.path)).toEqual(["src/App.tsx"]);
  });
});

describe("contract consumption", () => {
  test("the panel speaks the shared status vocabulary and cap", () => {
    const entries: TreeFileEntry[] = Object.values(FILE_STATUS).map((status) => ({
      path: "f.txt",
      status,
    }));
    expect(FILE_TREE_MAX_ENTRIES).toBe(5000);
    const typed: FileStatusLabel = FILE_STATUS.MODIFIED;
    expect(typed).toBe("modified");
    expect(panelRows(entries, new Set(), "").map((row) => row.status)).toEqual([
      ...Object.values(FILE_STATUS),
    ]);
  });
});

describe("panelRows", () => {
  const entries: TreeFileEntry[] = [
    { path: "src/deep/b.ts" },
    { path: "src/a.ts", status: "modified" },
    { path: "README.md" },
  ];

  test("browse mode: dirs collapse by default; expanding inlines children with depth", () => {
    const collapsed = panelRows(entries, new Set(), "");
    expect(collapsed.map((r) => `${r.kind}:${r.label}:${r.depth}`)).toEqual([
      "dir:src/:0",
      "file:README.md:0",
    ]);
    const srcOpen = panelRows(entries, new Set(["src"]), "");
    expect(srcOpen.map((r) => `${r.kind}:${r.label}:${r.depth}`)).toEqual([
      "dir:src/:0",
      "dir:deep/:1",
      "file:a.ts:1",
      "file:README.md:0",
    ]);
    const deepOpen = panelRows(entries, new Set(["src", "src/deep"]), "");
    expect(deepOpen.map((r) => `${r.kind}:${r.label}:${r.depth}`)).toEqual([
      "dir:src/:0",
      "dir:deep/:1",
      "file:b.ts:2",
      "file:a.ts:1",
      "file:README.md:0",
    ]);
    expect(deepOpen.find((r) => r.label === "a.ts")?.status).toBe("modified");
  });

  test("filter mode: flat hit list with full paths, no dirs", () => {
    const rows = panelRows(entries, new Set(), "readme");
    expect(rows.map((r) => `${r.kind}:${r.label}:${r.depth}`)).toEqual(["file:README.md:0"]);
    const withStatus = panelRows(entries, new Set(), "a.ts");
    expect(withStatus.map((r) => `${r.label}:${r.status ?? "-"}`)).toEqual(["src/a.ts:modified"]);
  });
});

describe("groupChanges", () => {
  const file = (path: string, split: Partial<TreeFileEntry> = {}): TreeFileEntry => ({
    path,
    ...split,
  });

  test("empty input yields three empty groups", () => {
    expect(groupChanges([])).toEqual({ staged: [], changes: [], untracked: [] });
  });

  test("staged-only entry joins staged only", () => {
    const entry = file("staged.ts", { index: "added" });
    const groups = groupChanges([entry]);
    expect(groups.staged).toEqual([entry]);
    expect(groups.changes).toEqual([]);
    expect(groups.untracked).toEqual([]);
  });

  test("worktree-only entry joins changes only", () => {
    const entry = file("changed.ts", { worktree: "modified" });
    const groups = groupChanges([entry]);
    expect(groups.staged).toEqual([]);
    expect(groups.changes).toEqual([entry]);
    expect(groups.untracked).toEqual([]);
  });

  test("MM entry joins BOTH staged and changes as the same object reference", () => {
    const entry = file("both.ts", { index: "modified", worktree: "modified" });
    const groups = groupChanges([entry]);
    expect(groups.staged).toHaveLength(1);
    expect(groups.changes).toHaveLength(1);
    expect(groups.staged[0]).toBe(groups.changes[0]);
    expect(groups.staged[0]).toBe(entry);
  });

  test("untracked entry joins untracked only", () => {
    const entry = file("new.ts", { untracked: true });
    const groups = groupChanges([entry]);
    expect(groups.untracked).toEqual([entry]);
    expect(groups.staged).toEqual([]);
    expect(groups.changes).toEqual([]);
  });

  test("untracked entry with a stray index half still stays out of staged", () => {
    const entry = file("weird.ts", { untracked: true, index: "added" });
    const groups = groupChanges([entry]);
    expect(groups.untracked).toEqual([entry]);
    expect(groups.staged).toEqual([]);
  });

  test("unmerged entry (no split fields) joins no group", () => {
    const entry = file("conflict.ts", { status: "modified" });
    const groups = groupChanges([entry]);
    expect(groups).toEqual({ staged: [], changes: [], untracked: [] });
  });

  test("mixed fixture partitions by staging state; counts and order hold", () => {
    const staged = file("s1.ts", { index: "added" });
    const worktreeOnly = file("w1.ts", { worktree: "deleted" });
    const both = file("mm.ts", { index: "modified", worktree: "modified" });
    const untracked = file("u1.ts", { untracked: true });
    const plain = file("plain.ts");
    const groups = groupChanges([staged, worktreeOnly, both, untracked, plain]);
    expect(groups.staged).toHaveLength(2);
    expect(groups.changes).toHaveLength(2);
    expect(groups.untracked).toHaveLength(1);
    expect(groups.staged).toEqual([staged, both]);
    expect(groups.changes).toEqual([worktreeOnly, both]);
    expect(groups.staged[1]).toBe(groups.changes[1]);
  });
});
