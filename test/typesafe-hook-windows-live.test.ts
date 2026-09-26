/**
 * Live Windows gate for the TypeSafe hook path and the key file.
 *
 * Two of this feature's riskiest claims are only testable on a real win32 runtime: the hook
 * adapter's `spawnSync` budget (a non-zero exit past it becomes `decision: "block"`, so a
 * fail-open judge that runs slow blocks a tool call — `src/hooks/adapters.ts`), and the key
 * file being owner-only where POSIX mode bits do not exist (mode bits report 0o666 for every
 * file on win32, so a mode assertion there passes without checking anything).
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
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasPrivateMode } from "../src/durability/posix-fs-semantics.js";
import { RUNTIME_PLATFORM } from "../src/durability/process-identity-contract.js";

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

describe("live Windows typesafe hook path", () => {
  liveWindowsTest(
    "an enabled judge stays inside the spawn budget on a real win32 runtime",
    () => {
      const root = mkdtempSync(join(tmpdir(), "vf-typesafe-win-"));
      try {
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
          { cwd: root, env, input: JSON.stringify({ tool: "Read", args: {} }), timeout: 20_000 },
        );
        const elapsed = Date.now() - started;
        // The hook path's whole contract is this number: past 10000 ms the adapter's non-zero exit
        // becomes decision "block" and a fail-open judge has blocked a tool call.
        expect(elapsed).toBeLessThan(HOOK_BUDGET_MS);
        const decision = JSON.parse(run.stdout.toString() || "{}");
        expect(decision.decision).not.toBe("block");
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
      const home = { ...process.env, USERPROFILE: root, HOME: root };
      execFileSync(nodeExecPathOrThrow(), [cliEntry, "config", "typesafe", "key"], {
        cwd: root,
        env: home,
        input: "not-a-real-key\n",
      });
      const path = join(root, ".vibeflow", "typesafe.env");
      // Only the DACL answers the question on this platform, so the assertion goes through the
      // same authority the writer used — with the descriptor the stat came from, not a
      // placeholder: the DACL check reopens the path, so binding it to the fd is what makes the
      // answer about THIS object.
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        expect(hasPrivateMode(fstatSync(fd), 0o777, 0o600, path, fd)).toBe(true);
      } finally {
        closeSync(fd);
      }
      expect(readFileSync(path, "utf8")).toContain("TYPESAFE_API_KEY=");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
