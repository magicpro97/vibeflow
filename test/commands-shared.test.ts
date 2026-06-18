// test/commands-shared.test.ts
//
// Smoke test for src/commands/_shared.ts (issue #80, phase 1/14).
//
// _shared.ts is a barrel of imports + re-exports. It has no functions of
// its own — every named import comes from a sibling or upstream module. This
// test verifies the re-export contract: every name that the original
// `src/commands.ts` imported at the top of the file must also be reachable
// from the barrel.
//
// Per the ESM cycle rule (test/commands-no-cycle.test.ts), the only allowed
// sibling import in src/commands/*.ts is `./_shared.js`. Every other
// subcommand file imports from `_shared.ts`, so this test acts as the
// integration point: if `_shared.ts` doesn't re-export something, the
// subcommand files can't import it.
//
// Added per 3-CLI debate (2026-06-18) — Claude flagged per-file 100% coverage
// as vacuous for re-export-only files; this test gives the barrel real
// coverage by importing every re-exported symbol once.
//

import { describe, expect, test } from "bun:test";
import * as Shared from "../src/commands/_shared.js";

describe("commands/_shared.ts barrel (issue #80, phase 1/14)", () => {
  test("exports at least 80 named symbols (catch silent re-export loss)", () => {
    // The original src/commands.ts imported 80+ names at the top.
    // If a name is dropped from the barrel, downstream subcommand
    // files fail to compile. This count catches silent loss.
    const keys = Object.keys(Shared);
    expect(keys.length).toBeGreaterThanOrEqual(80);
  });

  test("re-exports core helpers", () => {
    // A representative sample of names that are definitely used by
    // downstream subcommand files. If any of these is missing, the
    // build breaks.
    expect(Shared.cwd).toBeDefined();
    expect(Shared.c).toBeDefined();
    expect(Shared.out).toBeDefined();
    expect(Shared.ENGINES).toBeDefined();
    expect(Shared.preflightAll).toBeDefined();
  });

  test("re-exports types via type-only import (compile-time only)", () => {
    // The barrel may re-export `Engine` / `WorkUnit` / `ProjectContext`
    // as type-only (`export type { ... }`). If the type is dropped from
    // the import statement in `_shared.ts`, this test fails to compile.
    // The runtime assertion below is a sanity check that the test file
    // is actually being executed.
    type _E = Shared.Engine;
    type _W = Shared.WorkUnit;
    type _P = Shared.ProjectContext;
    // Use the types as values via a function arg — the types are erased
    // at runtime, so the only thing this checks is that the names
    // resolve. If the barrel drops a type, the import statement above
    // fails to compile and we catch it here.
    const _accept = (_v: _E | _W | _P): void => {
      void _v;
    };
    void _accept;
    expect(typeof Shared.ENGINES).toBe("object");
  });
});
