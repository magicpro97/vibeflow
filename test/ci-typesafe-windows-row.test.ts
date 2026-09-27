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

/** One step's own lines: from its `- name:` to the next step, so checks see the whole mapping. */
/** Text of the call starting at `callAt`, up to its matching close paren. */
function callText(src: string, callAt: number): string {
  let depth = 0;
  for (let i = src.indexOf("(", callAt); i < src.length; i++) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(callAt, i + 1);
    }
  }
  return src.slice(callAt);
}

function stepBlock(job: string, marker: string): string {
  const from = job.indexOf(marker);
  expect(from).toBeGreaterThan(-1);
  const rest = job.slice(from);
  const nextStep = rest.indexOf("\n      - ");
  return nextStep === -1 ? rest : rest.slice(0, nextStep);
}

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

/**
 * One top-level job's block, so an assertion can say which JOB a step belongs to.
 *
 * A whole-file `toContain` cannot: a command moved into another job is still present as text, and
 * the job that must run it can stay green while running nothing.
 */
function jobBlock(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:`);
  expect(start).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = /\n {2}[a-z][\w-]*:\s*$/m.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

describe("the win32 gate is wired into both workflows", () => {
  test("ci.yml lists the typesafe-hook row and runs the live test on it", () => {
    const suites = windowsMatrixSuites(ci);
    expect(suites).toContain("typesafe-hook");
    // Scoped to the JOB, not the file. As whole-file substrings all of these survived moving the
    // step into any other job - the matrix row is unchanged, the strings still occur, and the
    // count still matches - while `matrix.suite` is null there, so the step skips and the Windows
    // job reports success with both win32 claims unverified. `jobBlock` was applied to release.yml
    // only, which is exactly the asymmetry this closes.
    const windowsJob = jobBlock(ci, "windows");
    // `if:` and `run:` were asserted as two independent whole-file substrings, so swapping the
    // run body for anything else, or parking the real command on a decoy step, left both green.
    // Anchoring the gate to end-of-line matters on its own: `toContain("if: matrix.suite ==
    // 'typesafe-hook'")` is a prefix with no terminator, so appending `&& matrix.suite ==
    // 'package-smoke'` kept it matching while the step could never run.
    expect(windowsJob).toContain(
      "if: matrix.suite == 'typesafe-hook'\n        run: bun test --timeout 30000 test/typesafe-hook-windows-live.test.ts",
    );
    // The live test needs the built artifact and node on PATH, and both must be gated on the same
    // row. Assert the GATING, not the string `bun run build`: that string also occurs in four
    // other jobs, so `toContain("bun run build")` could not fail for a change confined to this
    // job — which is exactly what this assertion claims to cover.
    const gatedOnRow =
      "if: matrix.suite == 'package-smoke' || matrix.suite == 'home-ui-bootstrap' || matrix.suite == 'typesafe-hook'";
    expect(windowsJob.split(gatedOnRow).length - 1).toBe(2);
    // One gates `actions/setup-node`, the other gates the build step itself.
    expect(windowsJob).toContain(`${gatedOnRow}\n        run: bun run build`);
    // `uses:` precedes `if:` on the setup-node step, unlike the build step above.
    expect(windowsJob).toContain(`uses: actions/setup-node@v4\n        ${gatedOnRow}`);
    // And the step must still be able to FAIL its job. `continue-on-error: true` inserted anywhere
    // in the step leaves the `if:`+`run:` pair byte-identical, and the row then reports success
    // with both win32 claims unverified - `WINDOWS_RESULT` reads success and the release decision
    // proceeds. Asserting the step's text is not the same as asserting the step can fail.
    const step = stepBlock(windowsJob, "- name: Live Windows typesafe hook budget");
    expect(step).toContain("run: bun test --timeout 30000 test/typesafe-hook-windows-live.test.ts");
    // The WHOLE step, not just the text before `run:`. A YAML mapping key may sit after `run:` in
    // the same step, so a scan that stops at `run:` walks straight past `continue-on-error` there.
    expect(step).not.toContain("continue-on-error");
    // And not at the JOB level either: `jobs.<id>.continue-on-error` is valid there and would make
    // the whole row contribute success while every step in it fails.
    expect(jobBlock(ci, "windows")).not.toContain("continue-on-error");
    // The aggregate the release gate reads must still exist, or a green row decides nothing.
    expect(ci).toContain("WINDOWS_RESULT: ${{ needs.windows.result }}");
  });

  test("release.yml runs the same live test, and runs it inside the Windows job", () => {
    // Belonging to the right JOB is the whole point: moved into the ubuntu `verify` job the
    // command still exists, `WINDOWS_RESULT` and `VF_REQUIRE_LIVE_WINDOWS` still exist as
    // substrings, and `needs.windows-owned-process.result` stays success — a release would ship
    // with no win32 evidence and every assertion here would still pass.
    const inWindowsJob = jobBlock(release, "windows-owned-process");
    expect(inWindowsJob).toContain(
      "run: bun test --timeout 30000 test/typesafe-hook-windows-live.test.ts",
    );
    expect(jobBlock(release, "verify")).not.toContain(
      "run: bun test --timeout 30000 test/typesafe-hook-windows-live.test.ts",
    );
    // Same two ways out as ci.yml: the step must not be defeatable, and the job result must still
    // be able to stop the release.
    const releaseStep = stepBlock(
      inWindowsJob,
      "- name: Windows typesafe hook budget release gate",
    );
    expect(releaseStep).toContain(
      "run: bun test --timeout 30000 test/typesafe-hook-windows-live.test.ts",
    );
    expect(releaseStep).not.toContain("continue-on-error");
    // "Same two ways out as ci.yml" was only true for the step. The JOB-level escape applies to
    // release.yml too: `jobs.<id>.continue-on-error` makes needs.<id>.result success even when the
    // live test fails, and the prereq guard reads exactly that.
    expect(inWindowsJob).not.toContain("continue-on-error");
    // Unlike the ci.yml row this step has no matrix, so it is unconditional: an `if:` appearing at
    // this indent is the release gate being switched off, and the run line would still match.
    expect(releaseStep).not.toContain("\n        if:");
    expect(release).toContain('if ($env:WINDOWS_RESULT -ne "success")');
    // The aggregate the release decision reads is the job result, so the job must exist.
    expect(release).toContain("WINDOWS_RESULT");
    // The row is only loud because the JOB runs on Windows and hands the live test its arming env.
    // Move either to another job and the platform selector becomes `test.skip`, the module-scope
    // guard has no env to fire on, and the whole thing reports success with 2 skips while both
    // win32 claims are unverified - with WINDOWS_RESULT reading success. A whole-file `toContain`
    // for the env name did not pin any of that; these are scoped to the jobs that must carry them.
    for (const job of [jobBlock(ci, "windows"), inWindowsJob]) {
      expect(job).toContain("runs-on: windows-latest");
      expect(job).toContain('VF_REQUIRE_LIVE_WINDOWS: "1"');
    }
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
    // The guard above only fires on a runner that is NOT win32. On windows-latest it passes, so
    // the two assertions in that file are real only because of this selector: a one-token edit to
    // `const liveWindowsTest = test.skip;` skips both, `bun test` exits 0, and every assertion in
    // THIS file still passes because they all read text. Nothing else in the repo pins it.
    expect(body).toContain(
      "const liveWindowsTest = process.platform === RUNTIME_PLATFORM.WINDOWS ? test : test.skip;",
    );
    // The row exists for the 10s spawn budget, which is the number this test's own docstring and
    // the workflows' comments both name. Raising it here would silently change what CI verified.
    expect(body).toContain("const HOOK_BUDGET_MS = 10_000;");
    // The declaration alone is not the claim. The budget is what the test's timing assertion uses,
    // so pin that the assertion reads it rather than a literal that could drift away from the const.
    expect(body).toContain("expect(elapsed).toBeLessThan(HOOK_BUDGET_MS);");
    // The DACL half needs the same treatment: it is the other win32-only claim, and `.toBe(true)`
    // against the reader with an identity witness is the only shape that can fail when a writer
    // stops enforcing owner-only. A loosened matcher here would leave the row green over it.
    const aclAt = body.indexOf("windowsVerifyPathAcl(");
    expect(aclAt).toBeGreaterThan(-1);
    const aclCall = callText(body, aclAt);
    expect(aclCall).toContain("identity: descriptorIdentity(fd),");
    // The matcher that closes THIS call, not any `.toBe(true)` elsewhere in the file - a bare
    // `toContain` matched another assertion and left the probe green when the DACL one was loosened.
    // `expect(<call>).toBe(true)` - the comma closes the argument, so the matcher follows it.
    expect(/^,\s*\)\s*\.toBe\(true\);/.test(body.slice(aclAt + aclCall.length).trimStart())).toBe(
      true,
    );
  });
});
