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
// Allowed: `import { ... } from "./_shared.js"` (the cross-import hub)
// Forbidden: any other `./<name>.js` import in src/commands/*.ts
//
// Added per OpenCode critique in 3-CLI debate (2026-06-18).

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const COMMANDS_DIR = "src/commands";
const ALLOWED_HUB = "_shared";

const files = readdirSync(COMMANDS_DIR)
  .filter((f) => f.endsWith(".ts"))
  .sort();

describe("commands/ no sibling imports (ESM cycle rule, issue #80, phase 1/14)", () => {
  for (const f of files) {
    test(`${f} has no sibling imports (only _shared allowed)`, () => {
      const content = readFileSync(join(COMMANDS_DIR, f), "utf8");
      // Match relative imports to other commands/ files.
      // Allow "./_shared.js" exactly. Reject "./<anything-else>.js".
      const siblingImportRegex = /^import\s.+from\s+["']\.\/([a-z_]+)\.js["'];?/gm;
      const matches: string[] = [];
      for (
        let m = siblingImportRegex.exec(content);
        m !== null;
        m = siblingImportRegex.exec(content)
      ) {
        const target = m[1];
        if (target === ALLOWED_HUB) continue;
        matches.push(`imported sibling: ${target}.js`);
      }
      expect(matches, `${f} must not import siblings (cycle rule)`).toEqual([]);
    });
  }

  test("at least one file exists to test", () => {
    // Defensive: if the directory is empty, the test above silently passes.
    expect(files.length).toBeGreaterThan(0);
  });
});
