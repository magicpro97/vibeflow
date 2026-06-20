// Sentinel test for the file-size gate (issue #165, F4).
//
// Exercises the gate end-to-end through its real CLI surface — a child
// `node` process that runs `scripts/check-file-size.cjs` against a
// throwaway fixture repo. We do NOT import the script's `main()`
// directly, because the gate's REPO_ROOT is computed from
// `__dirname/..` and is not injectable.
//
// The fixture repo lives under `mkdtempSync(join(tmpdir(), "vf-f4-"))`
// and is fully torn down after each case — no `git status` pollution,
// no risk of leaking a 500-line file into the real `src/`.
//
// Three failure modes the spec mandates (issue #165 v2):
//   (a) 500-line file with NO waiver        → exit 1
//   (b) 500-line file with VALID waiver     → exit 0
//   (c) 500-line file with MALFORMED waiver → exit 1 AND
//                                            ::warning file=…::waiver comment malformed

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync as cpSpawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_PATH = join(import.meta.dir, "..", "scripts", "check-file-size.cjs");

// Build a 500-line fixture file. `firstLine` is the leading line of
// the file (either a waiver comment, a `// hello`, or any other
// single-line prelude); lines 2..500 are identical filler so the
// file crosses the 400-line cap by 100 lines.
function buildFixtureFile(firstLine: string, body = "export const x = 1;"): string {
  const lines: string[] = [firstLine];
  while (lines.length < 500) lines.push(body);
  return `${lines.join("\n")}\n`;
}

// Create a throwaway repo at `<dir>` with a single 500-line file
// `<dir>/src/<filename>.ts` whose first line is `firstLine`, plus the
// `check-file-size.cjs` script at `<dir>/scripts/` so its
// `__dirname/..` lands on `<dir>`.
function makeFixture(opts: { filename: string; firstLine: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-f4-gate-"));
  // No "type": "module" — the gate is CJS.
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "0.0.0" }, null, 2)}\n`,
  );
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", opts.filename), buildFixtureFile(opts.firstLine));
  // Copy the real script into `<dir>/scripts/` so its
  // `__dirname = <dir>/scripts` and the script's REPO_ROOT
  // (computed as `__dirname/..`) resolves to <dir>. That mirrors the
  // production layout exactly: in the real repo the script lives at
  // `<repo>/scripts/check-file-size.cjs` and walks `<repo>/src/`.
  mkdirSync(join(dir, "scripts"));
  copyFileSync(SCRIPT_PATH, join(dir, "scripts", "check-file-size.cjs"));
  return dir;
}

function runGate(fixtureDir: string): { status: number | null; stdout: string; stderr: string } {
  const r = cpSpawnSync("node", [join(fixtureDir, "scripts", "check-file-size.cjs")], {
    cwd: fixtureDir,
    encoding: "utf8",
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

describe("file-size gate (scripts/check-file-size.cjs)", () => {
  let createdDirs: string[] = [];

  beforeEach(() => {
    createdDirs = [];
  });

  afterEach(() => {
    for (const d of createdDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; tmpdir is wiped by the OS eventually
      }
    }
  });

  it("(a) 500-line file with NO waiver → exit 1, ::error file=src/big.ts", () => {
    const dir = makeFixture({ filename: "big.ts", firstLine: "// hello" });
    createdDirs.push(dir);

    const r = runGate(dir);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("::error file=src/big.ts");
  });

  it("(b) 500-line file WITH valid waiver (#999) → exit 0, no error annotations", () => {
    const dir = makeFixture({
      filename: "waived.ts",
      firstLine: "// size-waiver: #999 — fixture waiver for test",
    });
    createdDirs.push(dir);

    const r = runGate(dir);

    // A valid waiver means the file is exempted → the gate passes.
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("::error file=");
    expect(r.stderr).not.toContain("::warning file=");
  });

  it("(c) 500-line file with MALFORMED waiver (no #\\d+) → exit 1 + ::warning file=…::waiver comment malformed + ::error file=…", () => {
    const dir = makeFixture({
      filename: "malformed.ts",
      firstLine: "// size-waiver: not-an-issue-ref",
    });
    createdDirs.push(dir);

    const r = runGate(dir);

    // The malformed waiver on src/malformed.ts is treated as
    // un-waived, so the gate exits 1 (file is 500 lines > 400 cap).
    expect(r.status).toBe(1);
    // The gate emits a ::warning annotation for the malformed comment.
    expect(r.stderr).toContain("::warning file=src/malformed.ts");
    expect(r.stderr).toContain("waiver comment malformed");
    // And the malformed file is reported as a real violation
    // (::error), because the cap is enforced.
    expect(r.stderr).toContain("::error file=src/malformed.ts");
  });
});
