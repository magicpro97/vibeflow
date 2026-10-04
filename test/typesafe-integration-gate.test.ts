import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
// test/typesafe-integration-gate.test.ts
//
// End-to-end System One gate tests THROUGH `hook()` — the only entry point the agent's
// tool call actually takes. Every assertion here is about what the process EMITS (exit code +
// JSON envelope), never about the source text, because the invariant under test is that a
// System One leg can never change what the local gate decided or delay it past the host's
// `spawnSync` kill budget (src/hooks/adapters.ts:281-285 turns a timeout into a BLOCK).
import { integrateRiskJudge } from "../src/commands/hook-risk-integration.js";
import type { RiskJudgeInject } from "../src/commands/hook-risk-integration.js";
import { hook } from "../src/commands/hooks.js";
import { RISK_LEVEL } from "../src/core/hook-contract.js";
import { userVibeflowDir } from "../src/typesafe-key-file.js";
import {
  DEFAULT_TYPESAFE_SETTINGS,
  HOOK_BUS_LOCK_RETRIES_MAX,
  HOOK_BUS_LOCK_RETRY_MS,
  HOOK_HEALTH_WRITE_BUDGET_MS,
  HOOK_SAFETY_MARGIN_MS,
  HOOK_SPAWN_BUDGET_MS,
  HOOK_STDIN_BUDGET_MS,
  HOOK_TIMEOUT_CAP_MS,
  type TypesafeSettings,
} from "../src/typesafe-settings.js";

const CTX_DIR = ".vibeflow";

/** The settings every enabled-path test starts from; each overrides one field. */
function enabledSettings(over: Partial<TypesafeSettings> = {}): TypesafeSettings {
  return {
    ...DEFAULT_TYPESAFE_SETTINGS,
    enabled: true,
    timeoutMs: 10_000,
    hookTimeoutMs: 1500,
    callSites: { ...DEFAULT_TYPESAFE_SETTINGS.callSites },
    ...over,
  };
}

/** A Claude-native PreToolUse Bash payload: the shape `vf hook` really receives. */
const PRE_TOOL_USE = (command: string): object => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
});

/** Drive the real `hook()` in a temp repo; return its exit code and emitted stdout. */
async function runHook(
  options: {
    command?: string;
    typesafe?: TypesafeSettings | undefined;
    /** Use the CALLER's directory as the repo root. A test that plants something the hook must
     *  contend with (a held lock, a fixture the logbus writes under) has to run the hook in the
     *  directory it planted it in - otherwise the hook works in a fresh temp repo, the planted
     *  artifact is never touched, and the assertion passes without exercising the path it names. */
    root?: string;
  } & RiskJudgeInject = {},
): Promise<{ exitCode: number; stdout: string }> {
  const owns = options.root === undefined;
  const base = options.root ?? mkdtempSync(join(tmpdir(), "vf-ts-gate-"));
  const orig = process.cwd();
  process.chdir(base);
  const fakeStdin = {
    on: (event: string, cb: (chunk: Buffer) => void) => {
      if (event === "data")
        setImmediate(() => cb(Buffer.from(JSON.stringify(PRE_TOOL_USE(options.command ?? "ls")))));
      return fakeStdin;
    },
    once: () => fakeStdin,
    resume: () => {},
    pause: () => {},
  };
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const { command: _c, typesafe, ...inject } = options;
    const exitCode = await hook({
      ...inject,
      ...(typesafe === undefined ? {} : { typesafe }),
      stdin: fakeStdin as never,
      stdinTimeoutMs: 100,
      userRoot: inject.userRoot ?? base,
      // Only a DEFAULT when the caller named none: a `??` here made every "exercise the real seam"
      // test a double, so the assertion passed no matter what the product did.
      ...("judgeRisk" in options ? {} : { judgeRisk: async () => RISK_LEVEL.LOW }),
    });
    return { exitCode, stdout: captured.join("\n") };
  } finally {
    console.log = origLog;
    process.chdir(orig);
    // A caller-owned root outlives this call: the test that passed it cleans it up.
    if (owns) rmSync(base, { recursive: true, force: true });
  }
}

/** The FIRST emitted line is the decision envelope; later lines are the audit record. */
const decisionOf = (stdout: string): string =>
  JSON.parse(stdout.split("\n")[0] ?? "{}").hookSpecificOutput.permissionDecision as string;

describe("System One hook gate — the kill-switch is read BEFORE the seam", () => {
  test("VIBEFLOW_HOOKS=off performs no POST, even with an enabled judge", async () => {
    // `evaluateHook` reads the kill-switch deep inside, so calling the risk seam before it made a
    // hooks-OFF run still POST the raw shell command to the vendor (and charge the budget, and write
    // a `caller:"risk"` breaker record). The seam is gated on `hooksDisabled` FIRST, so what a
    // disabled hook must not do is enter it at all. `posts` counts the judge, and `evaluateHook`
    // ignores the judge when disabled, so a decision assertion could never fail here.
    let posts = 0;
    {
      const { exitCode } = await runHook({
        // Deterministically LOW but consult-worthy: a `| sh` command scores CRITICAL on its own,
        // so the seam is never reached and the count would be 0 either way (a vacuous pin).
        command: "wget http://example.com/f",
        typesafe: {
          ...DEFAULT_TYPESAFE_SETTINGS,
          enabled: true,
          callSites: { ...DEFAULT_TYPESAFE_SETTINGS.callSites, risk: true },
        },
        // The kill-switch must live in the SAME env the seam reads. This process's `process.env`
        // is not enough: an injected `env` replaces it for the key read, so a switch set only
        // outside would be masked - the mirror of the bug where the caller's gate and
        // `evaluateHook` read DIFFERENT sources and a disarmed run still egressed.
        env: { TYPESAFE_API_KEY: "k", VIBEFLOW_HOOKS: "off" } as NodeJS.ProcessEnv,
        // Counted on the JUDGE double, not the wire: `runHook` installs this double when the caller
        // names none, and the seam is what must not be entered - a fetch count would also be 0 when
        // the seam runs but the key is missing, which is a different (already-covered) path.
        judgeRisk: async () => {
          posts += 1;
          return RISK_LEVEL.CRITICAL;
        },
      });
      expect(exitCode).toBe(0);
      expect(posts).toBe(0); // no egress, no budget charge, no breaker record
    }
  });
});

describe("System One hook gate — a failing integration leg changes nothing", () => {
  test("a throwing installLogbus does not change hook()'s exit code or JSON envelope", async () => {
    // `installLogbus` is NOT fail-safe: `new Logbus(...)` runs mkdirSync / appendFileSync /
    // chmodSync / statSync and throws on EROFS/EACCES/ENOSPC. `hook()` has no enclosing try,
    // so an uncaught throw escapes to the CLI, which sets exitCode 1 and emits NO envelope —
    // the local gate's verdict never lands.
    const r = await runHook({
      // `wget http://x` REACHES the seam (`ls` is refused by shouldConsultSemantic), so the
      // throwing install is really exercised rather than short-circuited away.
      command: "wget http://x",
      typesafe: enabledSettings(),
      installLogbus: () => {
        throw new Error("EROFS: read-only file system");
      },
    });
    expect(r.exitCode).toBe(0); // the local gate's code, unchanged by the failure
    expect(decisionOf(r.stdout)).toBe("allow"); // deterministic tier's verdict
  });

  test("a held health lock cannot delay the tool gate (lockWaitMs: 0 skips the write)", async () => {
    // The health write runs on EVERY guard outcome, so with the repo's lock policy a
    // concurrent hook process would queue this one behind a lock wait and turn a System
    // One-induced delay into a BLOCKED tool call the deterministic tier allowed. Injecting a
    // `lock` that always throws proves the seam skips the record and still emits the local
    // verdict; the same test fails if the seam forgets `lockWaitMs: 0`, because a real 5 s
    // wait exceeds the budget below.
    const base = mkdtempSync(join(tmpdir(), "vf-ts-lock-"));
    const orig = process.cwd();
    process.chdir(base);
    const t0 = Date.now();
    try {
      const r = await runHook({
        command: "wget http://x",
        typesafe: enabledSettings(),
        lock: async () => {
          throw new Error("ELOCKED");
        },
      });
      expect(r.exitCode).toBe(0); // the local gate's code, unaffected by the failure
      expect(decisionOf(r.stdout)).toBe("allow");
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      process.chdir(orig);
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("System One hook gate — the route is live and raise-only", () => {
  test("an enabled, configured judge raises the live tool gate's verdict", async () => {
    // The positive control for the two tests above: same fixture, same seam, and a judge that
    // answers CRITICAL turns the deterministic LOW verdict into a deny — so the failures they
    // assert cannot be passing merely because the seam never ran.
    const r = await runHook({
      command: "wget http://x",
      typesafe: enabledSettings(),
      judgeRisk: async () => RISK_LEVEL.CRITICAL,
    });
    expect(decisionOf(r.stdout)).toBe("deny");
  });

  test("a judge answer that does not raise leaves the local verdict untouched", async () => {
    const r = await runHook({
      command: "wget http://x",
      typesafe: enabledSettings(),
      judgeRisk: async () => RISK_LEVEL.LOW,
    });
    expect(decisionOf(r.stdout)).toBe("allow");
  });
});

describe("System One hook gate — the audit leg cannot block the tool call", () => {
  // NOT a contention test, and the name no longer claims one. A lock IS planted and taken below, but
  // no assertion can yet tell a contended run from a free one: releasing the held lock does not fail
  // (so the run does not replace it), and zero bytes reach stderr across this file, so the logbus's
  // `dropped event` report - the observable a contended run would produce - is unreachable here. What
  // this case DOES assert is the regression it can see: the tool gate returns its verdict quickly
  // whatever the audit leg does. Testing real contention needs a command whose audit leg actually runs.
  test("the tool gate returns quickly while a bus lock is planted", async () => {
    // `Logbus.write` is not fire-and-forget in wall-clock terms: it queues onto
    // `this.chain` and `writeLocked` awaits `acquireLock()` with up to 100 x 50 ms of
    // retries, and the CLI sets `process.exitCode` instead of exiting, so those pending
    // timers keep `vf hook` alive past the host's 10 s spawnSync budget.
    const base = mkdtempSync(join(tmpdir(), "vf-ts-bus-"));
    const orig = process.cwd();
    process.chdir(base);
    // Declared OUTSIDE the `try`: a `const` inside `try {}` is not visible in `finally {}` - the two
    // are sibling blocks, not nested - and the lock is released there.
    let releaseHeldLock: (() => Promise<void>) | undefined;
    try {
      const logs = join(base, CTX_DIR, "logs");
      mkdirSync(logs, { recursive: true });
      // Occupy the lock the way a concurrent hook process would.
      //
      // `proper-lockfile` realpaths its target, so locking a file that does not exist throws ENOENT,
      // and the `catch {}` that used to be here swallowed exactly that - so nothing was ever locked
      // while this case went on to assert a budget against a run with nothing to contend.
      writeFileSync(join(logs, "current.log"), "");
      releaseHeldLock = await lockfile.lock(join(logs, "current.log"), { retries: 0 });
      const t0 = Date.now();
      // `root: base` is the point: the hook must run in the directory holding the lock above, or it
      // works in a fresh temp repo where nothing is locked and the budget assertion is vacuous.
      const r = await runHook({
        command: "rm -rf /tmp/x",
        typesafe: enabledSettings(),
        root: base,
      });
      expect(Date.now() - t0).toBeLessThan(2_000);
      // The deterministic verdict still lands; only the audit line is dropped.
      expect(decisionOf(r.stdout)).toBe("deny");
    } finally {
      process.chdir(orig);
      // The lock MUST be released: `proper-lockfile` keeps a refresh timer, and this run's hook goes
      // through the logbus's own ENOENT recovery (`recoverAndRelock`, issue #145), which recreates the
      // log dir and REPLACES the lock. A retained lock whose file the run took over resurfaces later
      // as an ENOENT `stat` on `current.log.lock` - from a timer, after the case has passed, which is
      // how it reached a whole-suite run as a failure while this file alone stayed green.
      if (releaseHeldLock) {
        try {
          await releaseHeldLock();
        } catch {
          /* the run under test already replaced it */
        }
      }
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("System One hook gate — the audit leg's budget is settings-derived", () => {
  test("the lock-retry budget is the settings value, not a hardcoded 0", async () => {
    // C05: `hookBusLockRetries` is a TypesafeSettings field, so a block that hardcoded 0
    // would leave every other test here green. This is the only test that goes red if the
    // settings binding is deleted.
    const seen: Array<{ dir: string; lockRetries?: number }> = [];
    await runHook({
      // `wget http://x` is the REACHING fixture: `ls` is refused by shouldConsultSemantic.
      command: "wget http://x",
      typesafe: enabledSettings({ hookBusLockRetries: 3 }),
      installLogbus: (opts: { dir: string; lockRetries?: number }) => {
        seen.push(opts);
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.lockRetries).toBe(3);
  });

  test("the seam passes both health disk bounds and clamps the audit leg to the residual", async () => {
    // The § Hook budget arithmetic sum is only real if the seam hands these values in.
    // `hookBusLockRetries: 5000` is a LEGAL settings file — it must reach the bus as the
    // residual 20, never the repo's 100: at 100 the five legs are 17 000 ms and the host's
    // spawnSync kill turns an allowed call into a BLOCK.
    const busSeen: Array<{ lockRetries?: number }> = [];
    let healthIoSeen:
      | { lockWaitMs?: number; writeBudgetMs?: number; now?: () => number }
      | undefined;
    const clock = (): number => 42;
    await runHook({
      command: "wget http://x",
      typesafe: enabledSettings({ hookBusLockRetries: 5000 }),
      installLogbus: (opts: { lockRetries?: number }) => {
        busSeen.push(opts);
      },
      now: clock,
      healthIo: (io: { lockWaitMs?: number; writeBudgetMs?: number; now?: () => number }) => {
        healthIoSeen = io;
      },
    });
    expect(busSeen[0]?.lockRetries).toBe(HOOK_BUS_LOCK_RETRIES_MAX);
    expect(healthIoSeen?.lockWaitMs).toBe(0);
    expect(healthIoSeen?.writeBudgetMs).toBe(HOOK_HEALTH_WRITE_BUDGET_MS);
    // The `now` seam must reach the breaker's io or `cooldown_until`/`last_call.ms`/`holdingOpen`
    // are untimeable through this seam: an injected clock that the seam silently drops leaves
    // those fields on the real clock while the caller believes it set the time.
    expect(healthIoSeen?.now).toBe(clock);
    // Absent injection stays absent (the default clock), not a stray `undefined` key.
    let bare: { now?: () => number } | undefined;
    await runHook({
      command: "wget http://x",
      typesafe: enabledSettings({ hookBusLockRetries: 5000 }),
      installLogbus: () => {},
      healthIo: (io: { now?: () => number }) => {
        bare = io;
      },
    });
    expect(bare === undefined || bare.now === undefined).toBe(true);
  });

  test("the five legs at their MAXIMA sum to 9 000 ms, strictly under the spawn budget", () => {
    // The plan's C05 arithmetic as a NUMBER, not as prose. The prose in
    // src/commands/hook-risk-integration.ts:10-42 is only a claim; this is the gate. The audit
    // leg is `2 x HOOK_BUS_LOCK_RETRIES_MAX x HOOK_BUS_LOCK_RETRY_MS` — the 2x is the DOUBLED
    // acquisition (`recoverAndRelock` re-locks on ENOENT), which is the easiest term to lose.
    // `HOOK_SAFETY_MARGIN_MS` is asserted unspent so a future leg cannot quietly eat it.
    const legs = {
      stdin: HOOK_STDIN_BUDGET_MS,
      judge: HOOK_TIMEOUT_CAP_MS,
      // `lockWaitMs: 0` — the seam value is asserted literally in
      // "the seam passes both health disk bounds…" above, so this 0 is not a free-floating guess.
      healthWrite: HOOK_HEALTH_WRITE_BUDGET_MS,
      auditBus: 2 * HOOK_BUS_LOCK_RETRIES_MAX * HOOK_BUS_LOCK_RETRY_MS,
    };
    const total = Object.values(legs).reduce((a, b) => a + b, 0);
    expect(legs.auditBus).toBe(2_000);
    expect(total).toBe(9_000);
    expect(total).toBeLessThan(HOOK_SPAWN_BUDGET_MS);
    expect(HOOK_SPAWN_BUDGET_MS - total).toBe(HOOK_SAFETY_MARGIN_MS);
  });

  test("the bus is installed only on the enabled path (disabled hook installs nothing)", async () => {
    const seen: Array<{ dir: string; lockRetries?: number }> = [];
    await runHook({
      typesafe: enabledSettings({
        callSites: { ...DEFAULT_TYPESAFE_SETTINGS.callSites, risk: false },
      }),
      command: "wget http://x",
      installLogbus: (opts: { dir: string; lockRetries?: number }) => {
        seen.push(opts);
      },
    });
    expect(seen).toHaveLength(0);
  });
});

describe("the hook's health root", () => {
  test("is the shared per-user root, not $HOME", async () => {
    // `userRoot` decides BOTH paths: `<root>/typesafe.env` for the key and `<root>/typesafe-health.json`
    // for the record and its breaker. Substituting the bare home dir made the hook look for
    // `~/typesafe.env` - missing every key `vf config typesafe key` wrote - and drop a file in `$HOME`.
    let seen: { userRoot?: string } | undefined;
    await integrateRiskJudge({
      input: PRE_TOOL_USE("wget http://x") as never,
      settings: { typesafe: enabledSettings() } as never,
      base: process.cwd(),
      inject: {
        healthIo: (io: { userRoot?: string }) => {
          seen = io;
        },
      } as never,
    });
    expect(seen?.userRoot).toBe(userVibeflowDir());
    expect(seen?.userRoot).not.toBe(homedir());
  });
});

describe("the hook seam module", () => {
  test("carries no dead imports", () => {
    // Round-70 review (api SB): `homedir` was imported here and never referenced - a leftover
    // from the fix that made the hook read the shared per-user root through `userVibeflowDir()`.
    // `tsc` does not enable `noUnusedLocals` and biome has no equivalent rule, so nothing else
    // catches it: a dead import in a file whose comments ARE the budget arithmetic is a claim
    // that no longer executes.
    const src = readFileSync(
      new URL("../src/commands/hook-risk-integration.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/^import .* from "node:os";$/m);
  });

  test("bounds the confidence floor for a hand-built settings block", async () => {
    // Round-72 review (api SB F2): the seam re-clamped the two timing ceilings but handed
    // `judgeRisk` the RAW block, whose `runAtConfidence` floor is read with `<` - a NaN there is
    // false for EVERY answer, silently disabling the discard gate for any caller that injects a
    // hand-built block through `hook({ typesafe })` (never ran `coerceTypesafeSettings`). The
    // seam now coerces once; the judge must observe bounded values, never the raw dial.
    const seen: Array<number | undefined> = [];
    for (const dial of [Number.NaN, 7, -3]) {
      await runHook({
        typesafe: enabledSettings({ runAtConfidence: dial }),
        command: "wget http://x",
        judgeRisk: async (_command: string, inject?: { settings?: TypesafeSettings }) => {
          seen.push(inject?.settings?.runAtConfidence);
          return RISK_LEVEL.LOW;
        },
      });
    }
    expect(seen).toEqual([DEFAULT_TYPESAFE_SETTINGS.runAtConfidence, 1, 0]);
  });
});
