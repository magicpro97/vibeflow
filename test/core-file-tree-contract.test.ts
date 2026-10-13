import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  FILE_STATUS,
  FILE_TREE_MAX_ENTRIES,
  type FileStatusLabel,
  UNMERGED_PORCELAIN_CODES,
  isUnmergedPorcelainCode,
} from "../src/core/file-tree-contract.js";
import type { FileTreeEntry } from "../src/server/files-tree-route.js";
import type { FilesTreeClientEntry } from "../src/ui/src/api-files.js";
import type { TreeFileEntry } from "../src/ui/src/files-tree.js";

type Same<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

// Server route, UI panel, and wire client all speak the one contract union.
const exactTypeParity = Object.freeze({
  ROUTE_ENTRY_STATUS: true satisfies Same<FileTreeEntry["status"], FileStatusLabel | undefined>,
  UI_ENTRY_STATUS: true satisfies Same<TreeFileEntry["status"], FileStatusLabel | undefined>,
  WIRE_ENTRY_STATUS: true satisfies Same<
    FilesTreeClientEntry["status"],
    FileStatusLabel | undefined
  >,
});

/** Repo-root-anchored source read — never process.cwd(). */
const source = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const moduleSpecifiers = (text: string): string[] =>
  [...text.matchAll(/(?:\bfrom\s+|^\s*import\s+|\bimport\s*\(\s*)"([^"]+)"/gmu)].map(
    (match) => match[1] ?? "",
  );

describe("shared file-tree contract", () => {
  test("freezes the status vocabulary, the entry cap, and the unmerged code table", () => {
    expect(Object.values(FILE_STATUS)).toEqual([
      "modified",
      "added",
      "deleted",
      "untracked",
      "renamed",
    ]);
    expect(FILE_TREE_MAX_ENTRIES).toBe(5000);
    expect([...UNMERGED_PORCELAIN_CODES]).toEqual(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
    for (const value of [FILE_STATUS, UNMERGED_PORCELAIN_CODES])
      expect(Object.isFrozen(value)).toBe(true);
  });

  test("accepts every FILE_STATUS value through the UI, route, and wire entry types", () => {
    const labels = Object.values(FILE_STATUS);
    const uiEntries: TreeFileEntry[] = labels.map((status) => ({ path: "f.txt", status }));
    const routeEntries: FileTreeEntry[] = labels.map((status) => ({ path: "f.txt", status }));
    const wireEntries: FilesTreeClientEntry[] = uiEntries;
    expect(uiEntries).toHaveLength(5);
    expect(routeEntries).toHaveLength(5);
    expect(wireEntries.map((entry) => entry.status)).toEqual(labels);
    expect(Object.values(exactTypeParity).every(Boolean)).toBe(true);
  });

  test("guards exactly the unmerged porcelain codes", () => {
    for (const code of UNMERGED_PORCELAIN_CODES) expect(isUnmergedPorcelainCode(code)).toBe(true);
    for (const value of ["M ", "A ", "D ", "??", "ZZ", "", null, 1])
      expect(isUnmergedPorcelainCode(value)).toBe(false);
  });

  test("stays dependency-free and browser-safe", () => {
    const contractSource = source("src/core/file-tree-contract.ts");
    expect(moduleSpecifiers(contractSource)).toEqual([]);
    expect(contractSource).not.toMatch(/\bnode:|\bBuffer\b|\bprocess(?:\.|\b)/u);
  });

  test("server, UI, and drawer consume the authority instead of redeclaring the vocabulary", () => {
    const consumers = [
      "src/server/files-tree-route.ts",
      "src/ui/src/files-tree.ts",
      "src/ui/src/api-files.ts",
      "src/ui/src/components/HomeFilesDrawer.vue",
    ];
    const rawStatusUnion = /["'](?:modified|added|deleted|untracked|renamed)["']\s*\|/u;
    for (const path of consumers) {
      const consumerSource = source(path);
      expect(consumerSource, `${path} imports the shared vocabulary`).toContain(
        "file-tree-contract.js",
      );
      expect(consumerSource, `${path} redeclares no status union`).not.toMatch(rawStatusUnion);
    }
  });
});
