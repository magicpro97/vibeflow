// test/commands-no-cycle.test.ts
//
// Enforces the ESM cycle rule from .vibeflow/plans/issue-80-split-commands.md:
// "No `src/commands/*.ts` may import from a sibling `src/commands/*.ts` directly.
// Cross-subcommand imports go through `src/commands/_shared.ts`. This prevents
// `init.ts` ↔ `doctor.ts` round-trips from being introduced later."
//
// Bun+ESM allows cycles silently (undefined binding for partially-initialized
// module). This test fails the build at PR time if a sibling import is added,
// so the cycle is caught at CI rather than at integration-test time.
//
// New code may only import `./_shared.js`. Exact legacy imports are frozen below
// so this gate catches every new edge while the phase plan retires existing debt.
//
// Added per OpenCode critique in 3-CLI debate (2026-06-18).

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

const COMMANDS_DIR = "src/commands";
const ALLOWED_HUB = "_shared";
const LEGACY_DIRECT_IMPORTS = new Set([
  "dispatch-reviewer-llm.ts:./orchestrate-reviewer.js",
  "dispatch-reviewer-llm.ts:./tools-detect.js",
  "dispatch-reviewer.ts:./dispatch-diff.js",
  "dispatch-reviewer.ts:./dispatch-reviewer-llm.js",
  "dispatch-runtime.ts:./dispatch-diff.js",
  "dispatch-runtime.ts:./dispatch-resources.js",
  "dispatch-runtime.ts:./dispatch-session-runtime.js",
  "hooks.ts:./tools-detect.js",
  "init-artifacts.ts:./tools-detect.js",
  "init.ts:./init-artifacts.js",
  "orchestrate.ts:./orchestrate-focus.js",
  "orchestrate.ts:./orchestrate-acquisition.js",
  "orchestrate.ts:./orchestrate-resolve.js",
  "pr-merge-when-green.ts:./pr-queue.js",
  "pr-queue-store.ts:./pr-queue-lock.js",
  "pr-queue.ts:./pr-queue-store.js",
  "pr.ts:./pr-gh.js",
  "pr.ts:./pr-merge-when-green.js",
  "pr.ts:./pr-queue.js",
  "run.ts:./orchestrate-acquisition.js",
  "skills.ts:./skills-draft.js",
  "tools-detect.ts:./orchestrate-reviewer.js",
  "tools-mcp-config.ts:./tools-mcp-antigravity.js",
  "tools.ts:./tools-mcp-config.js",
  "units-ingest.ts:./dispatch-reviewer.js",
  "verify.ts:./tools-detect.js",
  "verify.ts:./verify-report.js",
  "verify.ts:./waiver-gate.js",
]);

const files = readdirSync(COMMANDS_DIR)
  .filter((f) => f.endsWith(".ts"))
  .sort();

const siblingTargets = (filename: string, content: string): string[] => {
  const source = ts.createSourceFile(
    filename,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return [];
    }
    const specifier = statement.moduleSpecifier.text;
    return /^\.\/[^/]+\.js$/.test(specifier) ? [specifier] : [];
  });
};

describe("commands/ no sibling imports (ESM cycle rule, issue #80, phase 1/14)", () => {
  for (const f of files) {
    test(`${f} has no sibling imports (only _shared allowed)`, () => {
      const content = readFileSync(join(COMMANDS_DIR, f), "utf8");
      const matches: string[] = [];
      for (const specifier of siblingTargets(f, content)) {
        const target = specifier.slice(2, -3);
        if (target === ALLOWED_HUB) continue;
        if (LEGACY_DIRECT_IMPORTS.has(`${f}:${specifier}`)) continue;
        matches.push(`imported sibling: ${specifier}`);
      }
      expect(matches, `${f} must not add sibling imports (cycle rule)`).toEqual([]);
    });
  }

  test("parser catches multiline and hyphenated sibling imports", () => {
    expect(siblingTargets("canary.ts", 'import {\n  value\n} from "./helper-name.js";')).toEqual([
      "./helper-name.js",
    ]);
  });

  test("at least one file exists to test", () => {
    // Defensive: if the directory is empty, the test above silently passes.
    expect(files.length).toBeGreaterThan(0);
  });
});
