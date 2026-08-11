import { describe, expect, test } from "bun:test";
// Strict static gate: no process.chdir() in the highest-risk real-Git /
// worktree / verifier test files. These were converted to explicit child
// cwd fixtures; reintroducing a global cwd flip here regresses isolation.
//
// Exceptions are handled elsewhere: test/orchestrator/isolate-real-git.test.ts
// (and every other legacy file) keeps a narrow lazy-default regression and is
// intentionally NOT listed here — this gate is for the converted files only.
//
// Policy: legacy process.chdir call sites are allowed only where the exact
// baseline occurrence count per normalized line text still holds. Any NEW
// occurrence (extra count, or a line text not in the baseline) fails with
// file:line. The fingerprint is the trimmed line text + its count, which is
// stable across edits that move or relabel surrounding lines.
import { existsSync, readFileSync } from "node:fs";

const CONVERTED_HIGH_RISK = [
  "test/commands-pr.test.ts",
  "test/commands-worktree.test.ts",
  "test/verify-sandbox-554.test.ts",
  "test/server-file-route.test.ts",
  "test/server.test.ts",
];

// Baseline fingerprint: normalized (trimmed) chdir line text -> exact number
// of pre-existing legacy occurrences per file. Derived once from the current
// sources; do not edit to paper over new insertions. Files absent from this
// map have a zero baseline (every occurrence is an extraneous insertion).
const BASELINE = new Map<string, Map<string, number>>([
  [
    "test/commands-worktree.test.ts",
    new Map([
      ["process.chdir(dir);", 12],
      ["process.chdir(origCwd);", 1],
    ]),
  ],
  [
    "test/server.test.ts",
    new Map([
      ["process.chdir(dir);", 3],
      ["process.chdir(orig);", 3],
    ]),
  ],
]);

// Strip // and /* */ comments and quoted strings so a plain
// `process.chdir(` mention in a comment or a literal string is not a violation.
function stripCommentedCode(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const two = code.slice(i, i + 2);
    if (two === "//") {
      while (i < code.length && code[i] !== "\n") i++;
    } else if (two === "/*") {
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
    } else if (code[i] === '"' || code[i] === "'" || code[i] === "`") {
      const quote = code[i];
      i++;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === "\\") i++;
        i++;
      }
      if (i < code.length) i++;
    } else {
      out += code[i];
      i++;
    }
  }
  return out;
}

// Given comment/string-stripped lines and a per-text baseline count, return
// file:line entries for every chdir occurrence that exceeds the baseline.
function detectExtraneousChdir(lines: string[], baseline: Map<string, number>): string[] {
  const seen = new Map<string, number>();
  const violations: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = (lines[i] ?? "").trim();
    if (!text.includes("process.chdir(")) continue;
    const allowed = baseline.get(text) ?? 0;
    const n = (seen.get(text) ?? 0) + 1;
    seen.set(text, n);
    if (n > allowed) violations.push(`${i + 1}:${text}`);
  }
  return violations;
}

describe("cwd isolation policy (converted high-risk files)", () => {
  test("no converted high-risk test file exceeds its chdir baseline", () => {
    const violations: string[] = [];
    for (const rel of CONVERTED_HIGH_RISK) {
      expect(existsSync(rel), `${rel} should exist`).toBe(true);
      const source = readFileSync(rel, "utf8");
      const lines = stripCommentedCode(source).split("\n");
      const hits = detectExtraneousChdir(lines, BASELINE.get(rel) ?? new Map());
      violations.push(...hits.map((h) => `${rel}:${h}`));
    }
    expect(violations).toEqual([]);
  });

  test("comments and strings mentioning process.chdir are ignored", () => {
    const code = [
      "// process.chdir(orig); imminent removal",
      'const s = "process.chdir(dir);";',
      "  process.chdir(orig);",
    ].join("\n");
    const lines = stripCommentedCode(code).split("\n");
    const baseline = new Map([["process.chdir(orig);", 1]]);
    expect(detectExtraneousChdir(lines, baseline)).toEqual([]);
  });

  test("a synthetic extra occurrence is rejected by the scanner helper", () => {
    const lines = ["  process.chdir(dir);", "  process.chdir(dir);"];
    const baseline = new Map([["process.chdir(dir);", 1]]);
    expect(detectExtraneousChdir(lines, baseline)).toEqual(["2:process.chdir(dir);"]);
  });
});
