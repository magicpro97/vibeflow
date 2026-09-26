/**
 * The win32-only gate is only evidence while it is actually wired.
 *
 * Two claims of the System One hook path hold nowhere else: the adapter's 10s spawn budget
 * (past it a non-zero exit becomes a blocked tool call) and the key file's owner-only DACL
 * (win32 reports 0o666 for every file, so a mode assertion there asserts nothing). Both live in
 * test/typesafe-hook-windows-live.test.ts, which SKIPS off win32 — a skipped assertion is
 * evidence of nothing — so the value of that file rests entirely on a Windows runner really
 * loading it.
 *
 * Nothing else notices when it does not. `release-prerequisites` consumes only
 * `needs.windows.result`, which is `success` whenever every PRESENT row passes, and the run step
 * is gated on the row's own string. So deleting the matrix entry, or renaming the suite value so
 * the step's `if` no longer matches while the row still runs, leaves every gate green and both
 * win32 claims permanently unverified. That is what this file pins.
 *
 * Cross-platform on purpose: it must run on the ordinary Linux job, which is the only place a
 * regression here would otherwise go unrecorded.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

/** The `suite:` values the windows job's matrix actually lists. */
function windowsMatrixSuites(text: string): string[] {
  const job = text.indexOf("windows:");
  expect(job).toBeGreaterThan(-1);
  const body = text.slice(job);
  // The matrix entries are `- suite: <name>`; stop at the job's `runs-on` so a later job's
  // matrix cannot be mistaken for this one.
  const runsOn = body.indexOf("runs-on:");
  const head = body.slice(0, runsOn === -1 ? body.length : runsOn);
  return [...head.matchAll(/^\s*-\s*suite:\s*(\S+)\s*$/gm)].map((m) => m[1] ?? "");
}

describe("the win32 gate is wired into both workflows", () => {
  test("ci.yml lists the typesafe-hook row and runs the live test on it", () => {
    const suites = windowsMatrixSuites(ci);
    expect(suites).toContain("typesafe-hook");
    // The step must be gated on THAT value, or a rename leaves the row running nothing.
    expect(ci).toContain("if: matrix.suite == 'typesafe-hook'");
    expect(ci).toContain("bun test --timeout 30000 test/typesafe-hook-windows-live.test.ts");
    // The live test needs the built artifact and node on PATH; both are gated on the same row.
    expect(ci).toContain("bun run build");
  });

  test("release.yml runs the same live test, so a release cannot skip it", () => {
    expect(release).toContain("bun test --timeout 30000 test/typesafe-hook-windows-live.test.ts");
    // The aggregate the release decision reads is the job result, so the job must exist.
    expect(release).toContain("WINDOWS_RESULT");
    expect(release).toContain("VF_REQUIRE_LIVE_WINDOWS");
  });

  test("the module-scope guard makes a non-Windows runner fail loudly, not skip to green", () => {
    const body = readFileSync(
      new URL("./typesafe-hook-windows-live.test.ts", import.meta.url),
      "utf8",
    );
    // Without this, VF_REQUIRE_LIVE_WINDOWS=1 on a misconfigured runner would import cleanly,
    // skip every assertion and report success. It has to sit at MODULE scope: inside a test (or
    // inside the skipped `liveWindowsTest` bodies) it would never run on the platform that needs
    // to complain.
    const guard = body.indexOf('process.env[LIVE_WINDOWS_ENV] === "1"');
    expect(guard).toBeGreaterThan(-1);
    expect(body).toContain("requires a real win32 runtime");
    const firstDescribe = body.indexOf("describe(");
    expect(firstDescribe).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstDescribe);
  });
});
