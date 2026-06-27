import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Guard: no machine-specific absolute home path may live in a TRACKED, non-doc
// file. `vf init` / `vf hooks emit` bake the current machine's absolute CLI and
// workspace paths into generated engine configs (.mcp.json, .codex/hooks.json,
// .github/copilot-hooks.json, …). Those files are now gitignored (see
// .gitignore + .vibeflow/.gitignore); this test fails if any such path
// re-enters git tracking — e.g. someone re-adds a generated config, or a new
// generator starts writing a tracked file with an absolute path.
//
// Skips:
//  - Docs / source / examples / snapshots legitimately contain illustrative
//    paths (a comment in adapters.ts, a sample in docs/, a *.example template).
//    The runner-ops files (.github/actions-runner-*) use __RUNNER_HOME__ /
//    __USER__ placeholders instead of a real home path, so they pass without a
//    skip.

const HOME_PATH = /\/Users\/[^/\s"]+|\/home\/[^/\s"]+|C:\\Users\\[^\\\s"]+/;
// Binary / generated / vendor files are skipped — reading them as utf8
// is slow (hundreds of font/image files) and they're never text-path concerns.
const SKIP_EXT =
  /\.(md|markdown|ts|tsx|js|mjs|cjs|example|snap|txt|toml|yml|yaml|json|css|html|svg|xml|conf|cfg|ini)$/;
const SKIP_DIR = /^docs\//;

describe("no machine-specific absolute path in tracked files", () => {
  test("git ls-files has no tracked non-doc file containing an absolute home path", () => {
    const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
      .split("\n")
      .filter((f) => f && !SKIP_EXT.test(f) && !SKIP_DIR.test(f));

    const offenders: string[] = [];
    for (const f of files) {
      let body: string;
      try {
        body = readFileSync(f, "utf8");
      } catch {
        continue; // binary / unreadable — not a text path leak
      }
      if (HOME_PATH.test(body)) offenders.push(f);
    }

    expect(offenders).toEqual([]);
  });
});
