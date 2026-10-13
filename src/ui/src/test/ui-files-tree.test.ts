const { describe, expect, test } = await import(String("bun:test"));
const { buildTree, filterPaths, panelRows } = await import("../files-tree.js");
import type { DirNode, TreeNode } from "../files-tree.js";

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

describe("panelRows", () => {
  const entries = [
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
