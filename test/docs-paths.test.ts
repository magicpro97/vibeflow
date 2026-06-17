/**
 * Doc-path freshness test (C1).
 *
 * The 4-CLI audit (2026-06-17) found 6+ docs referencing `.viteflow/` (typo).
 * Code uses `.vibeflow/` (src/core.ts:46 CTX_DIR = ".vibeflow").
 *
 * This test reads every docs/*.md and asserts no `.viteflow` string remains.
 * If someone re-introduces the typo, this test fails with the file + line.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const DOCS_DIR = join(import.meta.dir, "..", "docs");
const REPO_ROOT = join(import.meta.dir, "..");

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      out.push(...listMarkdownFiles(p));
    } else if (entry.endsWith(".md")) {
      out.push(p);
    }
  }
  return out;
}

describe("docs path references (C1)", () => {
  const files = listMarkdownFiles(DOCS_DIR);

  test("at least 1 doc file exists", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("no `.viteflow` typo in any doc", () => {
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        if (line.includes(".viteflow")) {
          offenders.push({
            file: relative(REPO_ROOT, file),
            line: idx + 1,
            text: line.trim().slice(0, 120),
          });
        }
      });
    }
    if (offenders.length > 0) {
      const msg = `Found \`.viteflow\` (typo) in docs. Code uses \`.vibeflow/\` (CTX_DIR).\n${offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n")}`;
      throw new Error(msg);
    }
    expect(offenders).toEqual([]);
  });
});
