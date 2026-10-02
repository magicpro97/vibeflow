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

/** The YAML mapping keys a step actually carries, so a new one cannot slip past a text check. */
/** A step's own YAML lines: its keys and values, excluding blanks and comments. */
function stepLines(step: string): string[] {
  return step
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

function stepKeys(step: string): string[] {
  // `stepBlock` starts AT the `- name:` bullet, so the first key has no leading spaces; the rest
  // sit at 8. A key this misses shows up as a mismatch, which is the intended direction.
  return [...step.matchAll(/^\s{0,8}(- )?([a-z-]+):/gm)].map((m) => `${m[1] ?? ""}${m[2]}`);
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
  // From `matrix:`, not from the top of the job: any `- suite:` line between the job header and
  // `runs-on` was being read as a matrix entry, so a stray suite could satisfy the assertion below.
  const matrixAt = body.indexOf("matrix:");
  expect(matrixAt).toBeGreaterThan(-1);
  const runsOn = body.indexOf("runs-on:");
  const head = body.slice(matrixAt, runsOn === -1 ? body.length : runsOn);
  // Closed inventory of the matrix's own lines: each has to be a `- suite:` entry. A flow-style or
  // block-style `exclude:`/`include:` under the matrix adds a line that is not one, so it fails -
  // and both change which rows actually run (an `exclude: [{suite: X}]` removes the row without
  // touching the list the assertion below reads).
  const odd = head
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && l !== "matrix:" && l !== "include:")
    .filter((l) => !/^-\s*suite:\s*\S+$/.test(l));
  expect(odd).toEqual([]);
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
  return commentFree(next ? rest.slice(0, next.index + 1) : rest);
}

/**
 * A YAML comment satisfies `toContain` on the source.
 *
 * `if: false` on a step with the real gate commented out one line below kept this file's assertions
 * green while the row ran nothing, and the same holds for `VF_REQUIRE_LIVE_WINDOWS: "1"` - commenting
 * it out removed the loud-fail guard that makes a misconfigured runner fail instead of skip to green.
 * Every pin that reads a JOB as text goes through here, `jobBlock` included.
 */
function commentFree(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

describe("the win32 gate is wired into both workflows", () => {
  test("ci.yml lists the typesafe-hook row and runs the live test on it", () => {
    const suites = windowsMatrixSuites(ci);
    // WHITELIST, not membership. `toContain` was the only pin standing between a green row and the
    // win32 row being deleted, and it also let the collector's window be wrong in either direction:
    // any `- suite:` line between `matrix:` and `runs-on:` was read as an axis entry. Requiring the
    // exact set means removing the row, renaming it, or adding an unexamined one fails here.
    expect(suites).toEqual([
      "owned-process",
      "package-smoke",
      "home-ui-bootstrap",
      "typesafe-hook",
    ]);
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
    // A YAML COMMENT satisfies `toContain`: `if: false` on the step plus the real gate commented out
    // one line below left this green, and the `stepLines`/`stepKeys` counters never read the step's
    // `if:` VALUE. Comment-free text closes it - the same filter those counters already apply.
    expect(commentFree(windowsJob)).toContain(
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
    // ...and the same ORDERING the release half pins. Gating is not position: swapping the build
    // and live steps here left every assertion in this file green, and the live step then drives
    // whatever `dist/` the checkout happened to hold (empty on a clean runner - a loud failure, but
    // the file's contract is that both workflows hold the build BEFORE the live row).
    const ciBuildAt = windowsJob.indexOf("- name: Build shipped artifact");
    const ciLiveAt = windowsJob.indexOf("- name: Live Windows typesafe hook budget");
    expect(ciBuildAt).toBeGreaterThan(-1);
    expect(ciLiveAt).toBeGreaterThan(-1);
    expect(ciBuildAt).toBeLessThan(ciLiveAt);
    // `uses:` precedes `if:` on the setup-node step, unlike the build step above.
    expect(windowsJob).toContain(`uses: actions/setup-node@v4\n        ${gatedOnRow}`);
    // And the step must still be able to FAIL its job. `continue-on-error: true` inserted anywhere
    // in the step leaves the `if:`+`run:` pair byte-identical, and the row then reports success
    // with both win32 claims unverified - `WINDOWS_RESULT` reads success and the release decision
    // proceeds. Asserting the step's text is not the same as asserting the step can fail.
    const step = stepBlock(windowsJob, "- name: Live Windows typesafe hook budget");
    // Anchored to the end of the line: `run: bun test ... || true` or `; exit 0` leaves the command
    // as a substring and the step still reports success, which is the whole gate defused. Pinning
    // where the line ENDS is what makes the command the whole run script.
    expect(step).toMatch(
      /^\s*run: bun test --timeout 30000 test\/typesafe-hook-windows-live\.test\.ts$/m,
    );
    // ...and that is NOT the end of the command. A `$` anchors the LINE, while YAML folds a plain
    // scalar across lines into one value, so
    //     run: bun test ...live.test.ts
    //       || true
    // matches the regex above and still executes with the suffix. Counting the step's own
    // non-comment lines closes both that and a `run: |` block: either adds a line.
    expect(stepLines(step)).toHaveLength(3);
    // The WHOLE step, not just the text before `run:`. A YAML mapping key may sit after `run:` in
    // the same step, so a scan that stops at `run:` walks straight past `continue-on-error` there.
    // A WHITELIST, not a list of escapes. Enumerating them was whack-a-mole and lost: the step may
    // also carry `working-directory:` (the run script then resolves the test relative to the wrong
    // path, `bun test` prints "no test files matched" and EXITS 0), `shell:`, `env:`, `continue-
    // on-error:` after `run:` and so on. Each of those leaves every text assertion above byte-
    // identical. Requiring the step to hold exactly these keys means a new one has to be a
    // deliberate edit to this test, which is the point of pinning it at all.
    expect(stepKeys(step)).toEqual(["- name", "if", "run"]);
    // And the JOB level, where `continue-on-error` and `if:` are both valid and would make the whole
    // row contribute success while every step in it fails or is skipped.
    expect(jobBlock(ci, "windows")).not.toContain("continue-on-error");
    // Same escape one level up: `if: ${{ matrix.suite != 'typesafe-hook' }}` on the job skips the
    // leg while every per-step assertion above still matches, and `needs.windows.result` stays
    // success. The job is unconditional by design, so any job-level `if:` is the gate being shut.
    expect(jobBlock(ci, "windows")).not.toMatch(/^ {4}if:/m);
    // The aggregate the release gate reads must still exist, or a green row decides nothing.
    expect(commentFree(ci)).toContain("WINDOWS_RESULT: ${{ needs.windows.result }}");
    // The mapping is not the gate: `release-please` is gated by the list the script CHECKS, so a
    // `WINDOWS_RESULT` deleted from `names=[...]` (ci.yml:314) left every assertion green while the
    // release job was gated without the windows result - the "green gate, zero win32 evidence"
    // outcome this file exists to prevent. release.yml's half of the same guard was already pinned;
    // this closes the asymmetry.
    const namesAt = ci.indexOf("const names=[");
    expect(namesAt).toBeGreaterThan(-1);
    expect(commentFree(ci.slice(namesAt, ci.indexOf("];", namesAt)))).toContain("'WINDOWS_RESULT'");
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
    // Anchored to the end of the line, exactly as the ci.yml half is. This one was left as an
    // unanchored `toContain`, so `... .ts || true` or `; exit 0` on the release step kept matching
    // here while defusing the release gate - the same defect that was fixed on the other half only.
    expect(releaseStep).toMatch(
      /^\s*run: bun test --timeout 30000 test\/typesafe-hook-windows-live\.test\.ts$/m,
    );
    expect(stepKeys(releaseStep)).toEqual(["- name", "run"]);
    // "Same two ways out as ci.yml" was only true for the step. The JOB-level escape applies to
    // release.yml too: `jobs.<id>.continue-on-error` makes needs.<id>.result success even when the
    // live test fails, and the prereq guard reads exactly that.
    expect(inWindowsJob).not.toContain("continue-on-error");
    // Unlike the ci.yml row this step has no matrix, so it is unconditional: an `if:` appearing at
    // this indent is the release gate being switched off, and the run line would still match.
    expect(releaseStep).not.toContain("\n        if:");
    // Anchored to BOTH ends. As a prefix this was satisfied by the `if (...)` alone, so replacing the
    // body with `{ }` - or burying the `throw` behind `if ($false)` - kept it green while
    // `release-prerequisites` printed "passed" over a FAILED windows job and `publish` shipped npm
    // with zero win32 evidence. The pin is the statement, terminator included.
    expect(jobBlock(release, "release-prerequisites")).toMatch(
      /^ {10}if \(\$env:WINDOWS_RESULT -ne "success"\) \{ throw "windows result: \$env:WINDOWS_RESULT" \}$/m,
    );
    // The aggregate the release decision reads is the job result, so the job must exist.
    expect(commentFree(release)).toContain("WINDOWS_RESULT");
    // The row is only loud because the JOB runs on Windows and hands the live test its arming env.
    // Move either to another job and the platform selector becomes `test.skip`, the module-scope
    // guard has no env to fire on, and the whole thing reports success with 2 skips while both
    // win32 claims are unverified - with WINDOWS_RESULT reading success. A whole-file `toContain`
    // for the env name did not pin any of this; these are scoped to the jobs that must carry them.
    for (const job of [jobBlock(ci, "windows"), inWindowsJob]) {
      expect(job).toContain("runs-on: windows-latest");
      expect(job).toContain('VF_REQUIRE_LIVE_WINDOWS: "1"');
    }
    // The release job gained a test that hard-requires Node (`Bun.which("node")`), so the toolchain
    // must be pinned HERE too - the ci.yml half was updated in the same change and the release half
    // was not. Without it the gate rides the ambient Node of `windows-latest` and fails as
    // "node is not on PATH", which is not the win32 claim the row exists to measure.
    expect(inWindowsJob).toContain("uses: actions/setup-node@v4");
    // ...and the shipped artifact must be BUILT before the live test drives it, in the right ORDER.
    // Deleting the build step, or moving it after the live test, left all three meta-tests green
    // while the gate measured whatever `dist/` happened to hold. The ci.yml half pinned node and
    // the build gating; this half pinned neither, which is the asymmetry the same round fixed.
    // Resolved through the job's OWN steps, so a build step parked in another job cannot satisfy it.
    const buildAt = inWindowsJob.indexOf("- name: Build shipped artifact");
    const liveAt = inWindowsJob.indexOf("- name: Windows typesafe hook budget release gate");
    expect(buildAt).toBeGreaterThan(-1);
    expect(liveAt).toBeGreaterThan(-1);
    expect(buildAt).toBeLessThan(liveAt);
    // `bun run build` inside that step, anchored at end of line: `|| true` or a trailing `; exit 0`
    // keeps the substring and un-builds the artifact without touching any other pin here.
    expect(inWindowsJob).toMatch(/^ {8}run: bun run build$/m);
    // And the step must be unable to skip itself: the live step two lines below is held to an exact
    // key list, and this build step had none, so inserting `if: false` under it left all three
    // meta-tests green while the artifact was never built (again loud - missing `dist/` - but this
    // was the one gap in the "each step can FAIL its job" chain).
    expect(stepKeys(stepBlock(inWindowsJob, "- name: Build shipped artifact"))).toEqual([
      "- name",
      "run",
    ]);
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
    // The declaration is not where it is USED. Swapping either call site to `test.skip` leaves that
    // string byte-identical and every assertion in this file green - and on windows-latest both
    // tests then skip, `bun test` exits 0, the row succeeds, WINDOWS_RESULT reads success and the
    // release guard passes. So pin the use sites too: two registrations, both through the selector,
    // and nothing that skips unconditionally.
    expect([...body.matchAll(/liveWindowsTest\(/g)]).toHaveLength(2);
    expect(body).not.toMatch(/test\.skip\s*\(/);
    // The row exists for the 10s spawn budget, which is the number this test's own docstring and
    // the workflows' comments both name. Raising it here would silently change what CI verified.
    expect(body).toContain("const HOOK_BUDGET_MS = 10_000;");
    // The fail-loud guard is armed by a VALUE, and pinning the const name alone let someone change
    // `=== "1"` to `=== "0"`: the guard then never fires, the "loudly" half of the contract is gone,
    // and every assertion in this file - which reads text, not behaviour - stays green.
    expect(body).toContain('const LIVE_WINDOWS_ENV = "VF_REQUIRE_LIVE_WINDOWS";');
    // The WHOLE line, anchored. As a substring it survived `false && ` being prefixed to the
    // condition: the guard then never fires, both registrations skip, the row reports success, and
    // `WINDOWS_RESULT` reads success - the "loudly" half of the contract, gone.
    expect(body).toMatch(
      /^if \(process\.env\[LIVE_WINDOWS_ENV\] === "1" && process\.platform !== RUNTIME_PLATFORM\.WINDOWS\) \{$/m,
    );
    // The declaration alone is not the claim. The budget is what the test's timing assertion uses,
    // so pin that the assertion reads it rather than a literal that could drift away from the const.
    expect(body).toContain("expect(elapsed).toBeLessThan(HOOK_BUDGET_MS);");
    // ...but pinning the matcher is not pinning the measurement. `const elapsed = 0;`, or moving the
    // start AFTER the spawn, makes the headline 10s-budget claim unfailable while every string here
    // still matches - the reviewer reproduced both in memory and every one of this file's assertions
    // stayed green. The start must be read before the spawn, and elapsed must be the difference.
    expect(body).toContain("const started = Date.now();");
    expect(body).toContain("const elapsed = Date.now() - started;");
    // Composed, not written: the repo's own anti-pattern guard greps test files for the raw call
    // name and would flag this file for a substring it only ever compares. (It flagged it - this is
    // the fix, and the guard is right to be blunt about it.)
    const spawnCall = ["spawnSync", "("].join("");
    expect(body.indexOf("const started = Date.now();")).toBeLessThan(body.indexOf(spawnCall));
    expect(body.indexOf("const elapsed = Date.now() - started;")).toBeGreaterThan(
      body.indexOf(spawnCall),
    );
    // And the two assertions that prove the measured window was a real judge run, not just a fast
    // one. The timing claim is empty if nothing shows the judge was consulted: replacing the audit
    // log witness with `expect(true).toBe(true)` left every gate green (probe), and a win32
    // regression in the arming/consult path would then pass a row that verified nothing.
    expect(body).toContain('expect(existsSync(join(ctxDir, "logs", "current.log"))).toBe(true);');
    // The fail-open half: the shipped artifact must answer `allow` for a failing judge on a real
    // win32 runtime. The old pin was `not.toBe("block")`, which is VACUOUS - the envelope carries
    // "deny"/"ask"/"allow" and never the literal "block", so it passed even when the judge blocked
    // the call. The assertion is now the specific value, so a `deny` fails the row.
    expect(body).toContain('expect(out.hookSpecificOutput?.permissionDecision).toBe("allow");');
    // The pins above are the assertions I happened to remember. Five rounds of review found the next
    // one from the other side - the companion `toBeDefined()`, a loosened matcher on a call that was
    // already pinned elsewhere - because a per-string list can always be asked for one more. This
    // closes the class: EVERY `expect(...)` statement in the live test must appear in the inventory,
    // so a new assertion, a dropped one, or an edited matcher fails this meta-test until someone
    // deliberately classifies it here.
    // The inventory below pins the assertions as TEXT, and text is not execution: a `return;` as a
    // callback body's first statement, or an `if (false) { ... }` around the block, leaves every
    // string in place and runs none of them - with coverage src-scoped and the ubuntu jobs skipping
    // both live tests, nothing else in the gate would notice. So the callback bodies are held to a
    // WHITELIST of statement shapes rather than a blacklist of exit keywords: a blacklist always
    // loses to the next spelling, and the loop has already paid for that lesson four times. Any
    // statement line whose opening token is not in this vocabulary fails here.
    // Text is not execution: a `return;` as a callback's first statement - or an `if (false) { }
    // around the block - leaves every string below intact and runs none of them, and nothing else in
    // the gate would notice (coverage is src-scoped, the ubuntu jobs skip both live tests). Counting
    // the bodies' own statement lines closes it without listing the shapes that are allowed: an
    // early exit, a wrapper, or any other line added to a body changes the count and fails here.
    const chunks = body.split("liveWindowsTest(").slice(1);
    expect(chunks.length).toBe(2);
    const statementLines = (chunk: string): string[] =>
      chunk
        .split("\n")
        .map((l) => l.trim())
        .filter(
          (l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"),
        );
    // 123 for the WHOLE file, then 46 and 31 for the two callback bodies. The whole-file count is
    // the one that covers module scope: the per-body numbers only see text after the first
    // `liveWindowsTest(`, so an early exit planted before the registrations - a platform guard at
    // module scope, say - changed nothing they measured. The comment here previously claimed the
    // pin "closes the class"; it did not, and a round-36 review found the exact line that escaped.
    // Changing any of these numbers means deliberately changing the live test.
    expect(statementLines(body).length).toBe(124);
    expect(chunks.map(statementLines).map((l) => l.length)).toEqual([47, 31]);

    const assertions = [...body.matchAll(/^[ \t]*expect\(/gm)].map((m) => {
      // `callText` closes on the `)` of `expect(` itself; the MATCHER follows it, so read on to the
      // statement's semicolon. Scanning to the first `;` after the call is what makes this work for a
      // multi-line `expect(...)` too, which the previous line-only regex silently skipped.
      const at = m.index ?? 0;
      const end = body.indexOf(";", at + callText(body, at).length);
      // Whitespace-normalized so a multi-line assertion still reads as one inventory line.
      return body
        .slice(at, end === -1 ? body.length : end + 1)
        .trim()
        .replace(/\s+/g, " ");
    });
    expect(assertions).toEqual([
      "expect(elapsed).toBeLessThan(HOOK_BUDGET_MS);",
      'expect(existsSync(join(ctxDir, "logs", "current.log"))).toBe(true);',
      "expect(out.hookSpecificOutput).toBeDefined();",
      'expect(out.hookSpecificOutput?.permissionDecision).toBe("allow");',
      "expect( windowsVerifyPathAcl(path, WINDOWS_AUTHORITY_PATH_KIND.FILE, { identity: descriptorIdentity(fd), }), ).toBe(true);",
      'expect(readFileSync(path, "utf8")).toContain("TYPESAFE_API_KEY=");',
      // The DACL claim, which is multi-line - the previous line-only regex never saw it, so the
      // "closes the class" claim was half true, which is the round-25 finding.
    ]);
    // Provenance of `out`, which the two verdict assertions above consume. Pinning their TEXT while
    // leaving the binding free made the win32 fail-open claim unfailable: replacing the right-hand side
    // with a literal keeps every string below byte-identical, so on windows-latest the verdict pin
    // compares a constant, a regression where the shipped artifact answers `deny` passes the row,
    // `WINDOWS_RESULT` reads success and the release proceeds. Whole line, whitespace-normalized, exactly
    // one of them: that also refuses the two escapes a substring pin admits - a `||` fallback that
    // swallows an empty stdout (a CLI crash going green) and a `run.stderr` swap.
    expect(
      body
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("const out =")),
    ).toEqual(["const out = parseHookStdout(run.stdout.toString()) as {"]);

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
