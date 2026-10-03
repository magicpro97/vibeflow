/**
 * Live Windows gate for the TypeSafe hook path and the key file.
 *
 * Two of this feature's riskiest claims are only testable on a real win32 runtime: the hook
 * adapter's `spawnSync` budget (a non-zero exit past it becomes a blocked tool call, so a
 * fail-open judge that runs slow has blocked a call it is not allowed to block —
 * `src/hooks/adapters.ts`), and the key file being owner-only where POSIX mode bits do not exist
 * (mode bits report 0o666 for every file on win32, so a mode assertion there passes without
 * checking anything).
 *
 * Off win32 both assertions are skipped, and a skipped assertion is evidence of nothing — hence
 * the `windows:` matrix row in `.github/workflows/ci.yml` and the release gate in
 * `.github/workflows/release.yml`. VF_REQUIRE_LIVE_WINDOWS=1 fails the job loudly instead of
 * skipping to green when a misconfigured runner is not actually Windows.
 *
 * The shipped artifact is driven, not `src/`: the Windows command is `bin/vf.mjs`, which
 * launches `dist/cli.js` with Node, and the koffi backend only loads under Node — spawning
 * `process.execPath` here would exercise the bun runtime instead.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  constants,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_PLATFORM } from "../src/durability/process-identity-contract.js";
import { descriptorIdentity, windowsVerifyPathAcl } from "../src/durability/windows-acl-ops.js";
import { WINDOWS_AUTHORITY_PATH_KIND } from "../src/durability/windows-private-contract.js";

const LIVE_WINDOWS_ENV = "VF_REQUIRE_LIVE_WINDOWS";
const LIVE_WINDOWS_TIMEOUT_MS = 30_000;
/** The adapter's spawn budget; past it the hook contract is broken even on exit status 0. */
const HOOK_BUDGET_MS = 10_000;
const repoRoot = dirname(dirname(fileURLToPath(new URL(import.meta.url))));
const cliEntry = join(repoRoot, "dist", "cli.js");
const nodeExecPath = Bun.which("node");
const liveWindowsTest = process.platform === RUNTIME_PLATFORM.WINDOWS ? test : test.skip;

if (process.env[LIVE_WINDOWS_ENV] === "1" && process.platform !== RUNTIME_PLATFORM.WINDOWS) {
  throw new Error(`${LIVE_WINDOWS_ENV}=1 requires a real win32 runtime`);
}

function nodeExecPathOrThrow(): string {
  if (nodeExecPath === null) {
    throw new Error("node is not on PATH; the shipped bin/vf.mjs launches dist/cli.js with Node");
  }
  return nodeExecPath;
}

/**
 * Read the decision out of the hook's stdout the way its OWN consumer does.
 *
 * `src/hooks/adapters.ts` documents the shape: the runner prints the JSON envelope on the FIRST line and
 * a free-form "[hook] ..." log on the second, and the adapter parses only the first line so the trailing
 * log cannot poison the parse. This case used to `JSON.parse` the whole stdout and therefore asserted a
 * contract the product does not have - which only a real win32 run could reveal, because the case is
 * gated to that platform. Empty stdout still means "no decision".
 */
function parseHookStdout(raw: string): unknown {
  const text = (raw.split("\n", 1)[0] ?? "").trim();
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`hook stdout first line is not JSON: ${JSON.stringify(text.slice(0, 400))}`);
  }
}

describe("live Windows typesafe hook path", () => {
  liveWindowsTest(
    "an enabled judge stays inside the spawn budget on a real win32 runtime",
    () => {
      const root = mkdtempSync(join(tmpdir(), "vf-typesafe-win-"));
      try {
        // ARM the judge. `readSettings(cwd())` reads `<cwd>/.vibeflow/SETTINGS.json` and the spawn
        // below runs with cwd = root, so this file is what puts the judge legs inside the measured
        // window. With the shipped default (`enabled: false`) `integrateRiskJudge` returns before
        // installing anything, and the number below would measure node's cold start instead.
        const ctxDir = join(root, ".vibeflow");
        mkdirSync(ctxDir, { recursive: true });
        writeFileSync(
          join(ctxDir, "SETTINGS.json"),
          JSON.stringify({ typesafe: { enabled: true } }),
        );
        // A key that cannot authenticate: the judge must fail OPEN and return fast. The budget is
        // what is under test, not the vendor's availability.
        // `VF_USER_VIBEFLOW_ROOT` is the root the CLI resolves health/key paths from, and
        // test/preload.ts sets it for every `bun test` run - so without the override below the child
        // inherited the preload's temp dir and the breaker's file landed outside this test's root.
        // HOME/USERPROFILE alone cannot redirect it: the env var wins first (see `userVibeflowDir`).
        const env = {
          ...process.env,
          USERPROFILE: root,
          HOME: root,
          VF_USER_VIBEFLOW_ROOT: root,
          TYPESAFE_API_KEY: "not-a-real-key",
        };
        const started = Date.now();
        const run = spawnSync(
          nodeExecPathOrThrow(),
          [cliEntry, "hook", "--event", "pre-tool-use"],
          {
            cwd: root,
            env,
            // A payload the parser accepts. `{tool, args}` alone matches no known shape, so
            // `parseHookInput` returns null and the CLI fail-closes to a block on EVERY run -
            // which is not what this row exists to measure. The command is also what makes
            // `shouldConsultSemantic` true, one of the four conditions on the judge path.
            input: JSON.stringify({
              event: "pre-tool-use",
              tool: "Bash",
              command: "curl https://example.com",
            }),
            // Below bun's own budget for this test (LIVE_WINDOWS_TIMEOUT_MS, 30 s) and past the
            // 10 s timing budget: a HANG trips this timeout and surfaces through the error
            // branch below WITH the child's stderr, while a slow-but-finishing run between 10 s
            // and 20 s stays a timing failure instead of a hang. At 60 s a hung child instead
            // starved until bun killed the test itself - no stderr, defeating the branch below.
            timeout: 20_000,
          },
        );
        // A non-zero exit or a spawn error is reported with the child's stderr, so a broken run is
        // diagnosable instead of arriving as a timing number.
        if (run.error || run.status !== 0) {
          throw new Error(
            `hook child did not finish cleanly: status=${run.status} error=${run.error?.message ?? "-"}\nstderr tail: ${run.stderr.toString().slice(-800)}`,
          );
        }
        const elapsed = Date.now() - started;
        // The hook path's whole contract is this number: past 10000 ms the adapter's non-zero exit
        // becomes a blocked tool call, so a fail-open judge that runs slow has blocked a call it is
        // not allowed to block.
        expect(elapsed).toBeLessThan(HOOK_BUDGET_MS);
        // The witness that the judge was really inside the measured window is the breaker's OWN
        // record: `withTypesafeGuard` stamps `last_call = {at, caller: "risk", ms}` into the health
        // file on EVERY attempt - success or fail-open - so a win32 regression that deletes,
        // short-circuits or reorders the `judge(...)` call leaves it absent. The previous witness
        // (`logs/current.log` exists) proved only what `installLogbus` proves: it runs BEFORE the
        // judge module is even imported, so its file exists with the judge call removed - the row
        // stayed green for the failure mode it names.
        const health = JSON.parse(readFileSync(join(root, "typesafe-health.json"), "utf8")) as {
          last_call?: { caller?: string; at?: string; ms?: number };
        };
        expect(health.last_call?.caller).toBe("risk");
        const attemptedAt = Date.parse(health.last_call?.at ?? "");
        expect(Number.isFinite(attemptedAt)).toBe(true);
        // And it sits INSIDE the window this test measured: the spawn began at `started`, the
        // attempt happened before the child exited, so a stamp from any other run (a previous
        // test's root, say) cannot satisfy this.
        expect(attemptedAt).toBeGreaterThanOrEqual(started);
        expect(attemptedAt).toBeLessThanOrEqual(started + elapsed);
        // The verdict itself. A well-formed payload is answered in the host's native shape, so
        // `permissionDecision` is where the decision lives; reading only the flat `decision` field
        // would compare `undefined` against a verdict and pass without checking anything.
        //
        // The assertion is the SPECIFIC fail-open value, not `not.toBe("block")`: the envelope
        // never carries the literal "block" (`presentDecision` maps it to "deny"), so the negative
        // form could not fail even when the judge blocked the call - it was vacuous.
        const out = parseHookStdout(run.stdout.toString()) as {
          hookSpecificOutput?: { permissionDecision?: string };
          decision?: string;
        };
        expect(out.hookSpecificOutput).toBeDefined();
        expect(out.hookSpecificOutput?.permissionDecision).toBe("allow");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    LIVE_WINDOWS_TIMEOUT_MS,
  );

  liveWindowsTest("the key file is owner-only by DACL on a real win32 runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-typesafe-win-"));
    try {
      // `homedir()` is where the shipped CLI resolves `~/.vibeflow`, so the child gets a throwaway
      // home instead of the runner's. USERPROFILE is the win32 source; HOME covers the POSIX run.
      const home = {
        ...process.env,
        USERPROFILE: root,
        HOME: root,
        // `typesafeEnvPath` resolves `VF_USER_VIBEFLOW_ROOT` BEFORE the home directory, and
        // test/preload.ts sets it for every `bun test` run - so the child inherited the preload's
        // temp dir and this test asserted on a path the CLI never wrote. HOME/USERPROFILE alone
        // cannot redirect it.
        VF_USER_VIBEFLOW_ROOT: root,
      };
      execFileSync(nodeExecPathOrThrow(), [cliEntry, "config", "typesafe", "key"], {
        cwd: root,
        env: home,
        input: "not-a-real-key\n",
      });
      // The key sits under the USER root, and `VF_USER_VIBEFLOW_ROOT` IS that root (it is
      // `~/.vibeflow`, not its parent) - so the file is beside `root`, not under the repo's
      // `.vibeflow` that holds SETTINGS.json. Deriving it here instead of asking the product made this
      // case look one directory too deep; it survived review and every local gate because it only ever
      // runs on a real win32 runtime.
      const path = join(root, "typesafe.env");
      // Only the DACL answers the question on this platform, so the assertion goes through the
      // same authority the writer used - but the VERIFY leg of it, not the ensure leg.
      // `hasPrivateMode` routes to `windowsEnsurePrivateAcl`, which is repair-then-recheck: it
      // catches the failed verdict, calls `migrateHandle` and re-runs the verdict, so it REPAIRS on
      // the way (it does return false when the verdict still fails after migration - that hard
      // error is what SECURITY_MODEL.md means by "not a degradation"). Asserting through it would
      // mutate the file it just created and then check that the mutation worked, so a writer that
      // stopped enforcing owner-only would still pass and this gate could not catch the regression
      // it exists for. `windowsVerifyPathAcl` only reads. The descriptor is the identity witness:
      // the check reopens the path, so binding it is what makes the answer about THIS object.
      //
      // Inheritance from the just-sealed `root` cannot satisfy this verdict on the writer's behalf,
      // so this assertion still fails if the file-level leg is deleted: the verdict requires
      // `control & SE_DACL_PROTECTED` (a DACL that arrived by propagation is NOT protected - the
      // parent's protection cannot propagate) and, for a FILE, `ace.flags === 0` (every propagated
      // ACE carries `INHERITED_ACE`, 0x10). test/windows-private-authority.test.ts pins both refusal
      // shapes structurally: `{ control: 0 }` and `{ ace.flags: 1 }` both throw.
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        expect(
          windowsVerifyPathAcl(path, WINDOWS_AUTHORITY_PATH_KIND.FILE, {
            identity: descriptorIdentity(fd),
          }),
        ).toBe(true);
      } finally {
        closeSync(fd);
      }
      // Segment-compared, never whole-file: `toContain(readFileSync(...))` renders the file's
      // contents into the failure message - the secret-to-error-string path this contract forbids -
      // and the prefix-only form stayed green for a writer that stored an EMPTY value. The boolean
      // forms keep the raw line out of any failure output while proving the exact fake key
      // round-tripped (round-72 review, ci SB).
      const [keyLine] = readFileSync(path, "utf8").split(/\r?\n/);
      expect(keyLine?.startsWith("TYPESAFE_API_KEY=")).toBe(true);
      expect(keyLine?.slice("TYPESAFE_API_KEY=".length) === "not-a-real-key").toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
