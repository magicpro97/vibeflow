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
//  - .github/actions-runner-auto-shutdown.sh is a hand-authored runner-ops doc
//    that still hardcodes a sample home path; PR-4 parametrizes it and removes
//    this skip. TODO(PR-4): drop RUNNER_OPS_TODO once that lands.

const HOME_PATH = /\/Users\/[^/\s"]+|\/home\/[^/\s"]+|C:\\Users\\[^\\\s"]+/;
const SKIP_EXT = /\.(md|markdown|ts|tsx|js|example|snap)$/;
const SKIP_DIR = /^docs\//;
// TODO(PR-4): remove when actions-runner-auto-shutdown.sh is parametrized.
const RUNNER_OPS_TODO = new Set([".github/actions-runner-auto-shutdown.sh"]);

describe("no machine-specific absolute path in tracked files", () => {
  test("git ls-files has no tracked non-doc file containing an absolute home path", () => {
    const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
      .split("\n")
      .filter((f) => f && !SKIP_EXT.test(f) && !SKIP_DIR.test(f) && !RUNNER_OPS_TODO.has(f));

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
