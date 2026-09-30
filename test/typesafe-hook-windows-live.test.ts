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
  existsSync,
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
        const env = {
          ...process.env,
          USERPROFILE: root,
          HOME: root,
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
            timeout: 20_000,
          },
        );
        const elapsed = Date.now() - started;
        // The hook path's whole contract is this number: past 10000 ms the adapter's non-zero exit
        // becomes a blocked tool call, so a fail-open judge that runs slow has blocked a call it is
        // not allowed to block.
        expect(elapsed).toBeLessThan(HOOK_BUDGET_MS);
        // The audit leg is the only witness that the judge was really inside the measured window.
        // `installLogbus` runs inside `integrateRiskJudge` AFTER all four gate conditions pass
        // (src/commands/hook-risk-integration.ts), and it is installed "on the enabled path only:
        // the disabled hook installs nothing" - so this file existing separates "the judge ran"
        // from "the payload short-circuited before it".
        expect(existsSync(join(ctxDir, "logs", "current.log"))).toBe(true);
        // The verdict itself. A well-formed payload is answered in the host's native shape, so
        // `permissionDecision` is where the decision lives; reading only the flat `decision` field
        // would compare `undefined` against "block" and pass without checking anything.
        const out = parseHookStdout(run.stdout.toString()) as {
          hookSpecificOutput?: { permissionDecision?: string };
          decision?: string;
        };
        expect(out.hookSpecificOutput?.permissionDecision ?? out.decision).toBeDefined();
        expect(out.hookSpecificOutput?.permissionDecision ?? out.decision).not.toBe("block");
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
      // catches the failed verdict, calls `migrateHandle`, re-runs the verdict and then returns
      // true unconditionally. Asserting through it mutates the file it just created and then
      // checks that the mutation worked, so a writer that stopped enforcing owner-only would still
      // pass and this gate could not catch the regression it exists for. `windowsVerifyPathAcl`
      // only reads. The descriptor is the identity witness: the check reopens the path, so binding
      // it is what makes the answer about THIS object rather than whatever now holds that name.
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
      expect(readFileSync(path, "utf8")).toContain("TYPESAFE_API_KEY=");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
