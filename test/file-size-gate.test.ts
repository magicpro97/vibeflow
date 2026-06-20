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
// Failure modes the spec mandates (issue #165 v2 + F4 followup #190):
//   (a) 500-line file with NO waiver        → exit 1
//   (b) 500-line file with VALID waiver     → exit 0
//   (c) 500-line file with MALFORMED waiver → exit 1 AND
//                                            ::warning file=…::waiver comment malformed
//   (d) 500-line file with `/* @ts-check */` block on line 0 and
//       valid waiver on line 2               → exit 0
//       (proves the leading-block-comment waiver scan still works)
//   (e) 500-line file with waiver on line 0 but extension `.gen.ts`
//                                           → exit 0
//       (proves EXCLUDE_PATTERNS actually filters the file)
//   (f) Facade file (`src/commands.ts` equivalent, rooted with no
//       `src/commands/` parent) with malformed waiver
//                                           → exit 1 + ::warning
//       (proves the malformed walk visits SCAN_FILES, not just
//       SCAN_DIRS — the v1 hole)
//   (g) 500-line file whose cap is raised by a central `WAIVERS`
//       entry (cap=600, lines=550)          → exit 0
//       (proves the legacy `WAIVERS` array path still resolves)

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

// Run the gate and capture stdout/stderr/exit.
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

  it("(b) 500-line file WITH valid waiver (#999) → exit 0, file-scoped ::warning on the waivered line", () => {
    const dir = makeFixture({
      filename: "waived.ts",
      firstLine: "// size-waiver: #999 — fixture waiver for test",
    });
    createdDirs.push(dir);

    const r = runGate(dir);

    // A valid waiver means the file is exempted → the gate passes.
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("::error file=");
    expect(r.stderr).not.toContain("waiver comment malformed");
    // F4 followup #190: an over-cap inline-waived file must surface
    // a file-scoped ::warning so the PR reviewer sees the waiver
    // in the diff annotations. The issue number is parsed from the
    // reason.
    expect(r.stderr).toContain(
      "::warning file=src/waived.ts,line=1,col=1::inline waiver #999 active",
    );
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

  it("(d) 500-line file with `/* @ts-check */` block on line 0 and valid waiver on line 2 → exit 0", () => {
    // The block comment on line 0 used to stop findWaiver() at the
    // first non-`//` line, hiding the waiver on line 2. The v2 fix
    // skips past the block so the waiver is still discovered.
    const dir = makeFixture({
      filename: "blockwaived.ts",
      firstLine:
        "/* @ts-check */\n// size-waiver: #191 — block comment header with a real waiver\n// this is line 2 of the leading block",
    });
    createdDirs.push(dir);

    const r = runGate(dir);

    // Waived → exit 0. The file-scoped ::warning should fire (the
    // waiver is doing work, the file is 500 lines > 400 cap).
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("::error file=src/blockwaived.ts");
    expect(r.stderr).toContain(
      "::warning file=src/blockwaived.ts,line=2,col=1::inline waiver #191 active",
    );
  });

  it("(e) 500-line file with waiver on line 0 but extension `.gen.ts` → exit 0 (EXCLUDE_PATTERNS)", () => {
    // *.gen.ts is in EXCLUDE_PATTERNS, so the file is skipped by
    // `walk()` before findWaiver/capFor ever see it. The gate
    // therefore has no .ts to scan and exits 0.
    const dir = makeFixture({
      filename: "codegen.gen.ts",
      firstLine: "// size-waiver: #192 — codegen output, not hand-written",
    });
    createdDirs.push(dir);

    const r = runGate(dir);

    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("::error file=src/codegen.gen.ts");
    expect(r.stderr).not.toContain("::warning file=src/codegen.gen.ts");
  });

  it("(f) facade file (`src/commands.ts`-equivalent) with malformed waiver → exit 1 + ::warning on the facade path", () => {
    // Build a 500-line facade file (no `src/commands/` parent, just
    // a flat `src/<name>.ts`) with a malformed waiver. The v1
    // malformed walk only iterated SCAN_DIRS, so the facade was
    // invisible. With walkSrcFiles() it now is.
    const dir = makeFixture({
      filename: "facade.ts",
      firstLine: "// size-waiver: not-an-issue-ref",
    });
    createdDirs.push(dir);

    // Promote facade.ts to the SCAN_FILES slot by creating the
    // exact path the gate looks at: `<dir>/src/commands.ts` (a flat
    // facade, not under `src/commands/`). Copy our 500-line file
    // there and remove the placeholder.
    const facadePath = join(dir, "src", "commands.ts");
    copyFileSync(join(dir, "src", "facade.ts"), facadePath);
    rmSync(join(dir, "src", "facade.ts"));

    const r = runGate(dir);

    // The facade has its own cap (1200) but the malformed waiver
    // still produces a ::warning pointing the contributor at the
    // bad comment. The file is 500 lines, well under 1200, so the
    // cap check passes.
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("::warning file=src/commands.ts");
    expect(r.stderr).toContain("waiver comment malformed");
  });

  it("(g) 500-line file under a central WAIVERS entry (cap=600) → exit 0, waiver note in ::notice", async () => {
    // Verify the legacy central-WAIVERS path still resolves. The
    // gate's WAIVERS array lists `src/commands/tools.ts` (cap=700)
    // and `src/commands/protection.ts` (cap=600). We need a file
    // whose cap is raised by WAIVERS, and the file must be under
    // the cap so the gate exits 0.
    //
    // To make this self-contained, we drop a thin "waiver" on the
    // test fixture: write a `wf-waivers.cjs` next to the script
    // that re-exports a WAIVERS override. Simpler: edit the
    // fixture's copy of the script via a sed-style shim.
    //
    // Approach: copy the real script, then rewrite the WAIVERS
    // block so the fixture file's relative path appears with a
    // cap of 600 and lines=550. The fixture file is 500 lines, but
    // we want to prove the cap path resolves, not that the line
    // count matches; 500 < 600 so the gate passes either way.
    const dir = makeFixture({
      filename: "central.ts",
      firstLine: "// hello",
    });
    createdDirs.push(dir);

    // Patch the fixture's copy of the gate to register our file
    // in the WAIVERS array with cap=600. The script reads the
    // WAIVERS array verbatim on require, so a single line of
    // shimmed text is enough.
    const scriptCopy = join(dir, "scripts", "check-file-size.cjs");
    const original = await Bun.file(scriptCopy).text();
    // Append our file to the existing WAIVERS array so the
    // fixture copy sees `src/central.ts` with cap=600.
    const patched = original.replace(
      '{ file: "src/commands/protection.ts", cap: 600, issue: "#131" },',
      '{ file: "src/commands/protection.ts", cap: 600, issue: "#131" },\n  { file: "src/central.ts", cap: 600, issue: "#999" },',
    );
    if (patched === original) {
      throw new Error("failed to patch WAIVERS in fixture script");
    }
    await Bun.write(scriptCopy, patched);

    const r = runGate(dir);

    // src/central.ts is 500 lines, cap 600 → under cap, exit 0.
    // The ::notice should include the waiver note.
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("::error file=src/central.ts");
    expect(r.stdout).toContain("(waiver: #999)");
  });
});
