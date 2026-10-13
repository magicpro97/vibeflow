// src/ui/src/files-tree.ts — pure helpers for the Files panel (no Vue imports).
export interface TreeFileEntry {
  path: string;
  status?: string;
}

export interface DirNode {
  name: string;
  path: string;
  kind: "dir";
  children: TreeNode[];
}
export interface FileNode {
  name: string;
  path: string;
  kind: "file";
  status?: string;
}
export type TreeNode = DirNode | FileNode;

/** Fold flat `a/b/c.txt` paths into nested nodes; dirs first, then files, both case-insensitive. */
export function buildTree(entries: TreeFileEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const dirs = new Map<string, DirNode>();
  const dirNode = (path: string): DirNode => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const node: DirNode = { name: path.split("/").pop() ?? path, path, kind: "dir", children: [] };
    dirs.set(path, node);
    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (parentPath) dirNode(parentPath).children.push(node);
    else roots.push(node);
    return node;
  };
  for (const entry of entries) {
    const cut = entry.path.lastIndexOf("/");
    const file: FileNode = {
      name: cut === -1 ? entry.path : entry.path.slice(cut + 1),
      path: entry.path,
      kind: "file",
      ...(entry.status ? { status: entry.status } : {}),
    };
    if (cut === -1) roots.push(file);
    else dirNode(entry.path.slice(0, cut)).children.push(file);
  }
  const sort = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    for (const node of nodes) if (node.kind === "dir") sort(node.children);
    return nodes;
  };
  return sort(roots);
}

/** Case-insensitive substring filter over flat entries; empty query keeps everything. */
export function filterPaths(entries: TreeFileEntry[], query: string): TreeFileEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((entry) => entry.path.toLowerCase().includes(q));
}

export interface PanelRow {
  path: string;
  label: string;
  depth: number;
  kind: "dir" | "file";
  status?: string;
  expanded: boolean;
}

/** Flat render rows for the drawer: filtered mode = flat hit list (full paths);
 *  browse mode = the tree with expanded dirs inlined, depth drives the indent. */
export function panelRows(
  entries: TreeFileEntry[],
  expanded: ReadonlySet<string>,
  filter: string,
): PanelRow[] {
  const query = filter.trim();
  if (query) {
    return filterPaths(entries, query).map((entry) => {
      const row: PanelRow = {
        path: entry.path,
        label: entry.path,
        depth: 0,
        kind: "file",
        expanded: false,
      };
      if (entry.status) row.status = entry.status;
      return row;
    });
  }
  const rows: PanelRow[] = [];
  const walk = (nodes: TreeNode[], depth: number): void => {
    for (const node of nodes) {
      const isExpanded = node.kind === "dir" && expanded.has(node.path);
      const row: PanelRow = {
        path: node.path,
        label: node.kind === "dir" ? `${node.name}/` : node.name,
        depth,
        kind: node.kind,
        expanded: isExpanded,
      };
      if (node.kind === "file" && node.status) row.status = node.status;
      rows.push(row);
      if (node.kind === "dir" && isExpanded) walk(node.children, depth + 1);
    }
  };
  walk(buildTree(entries), 0);
  return rows;
}
