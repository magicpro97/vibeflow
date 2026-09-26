// test/typesafe-integration-gate.test.ts
//
// End-to-end System One gate tests THROUGH `hook()` — the only entry point the agent's
// tool call actually takes. Every assertion here is about what the process EMITS (exit code +
// JSON envelope), never about the source text, because the invariant under test is that a
// System One leg can never change what the local gate decided or delay it past the host's
// `spawnSync` kill budget (src/hooks/adapters.ts:281-285 turns a timeout into a BLOCK).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { RiskJudgeInject } from "../src/commands/hook-risk-integration.js";
import { hook } from "../src/commands/hooks.js";
import { RISK_LEVEL } from "../src/core/hook-contract.js";
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
  } & RiskJudgeInject = {},
): Promise<{ exitCode: number; stdout: string }> {
  const base = mkdtempSync(join(tmpdir(), "vf-ts-gate-"));
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
      judgeRisk: inject.judgeRisk ?? (async () => RISK_LEVEL.LOW),
    });
    return { exitCode, stdout: captured.join("\n") };
  } finally {
    console.log = origLog;
    process.chdir(orig);
    rmSync(base, { recursive: true, force: true });
  }
}

/** The FIRST emitted line is the decision envelope; later lines are the audit record. */
const decisionOf = (stdout: string): string =>
  JSON.parse(stdout.split("\n")[0] ?? "{}").hookSpecificOutput.permissionDecision as string;

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
  test("a held BUS lock cannot delay the tool gate (lockRetries: 0 drops the audit event)", async () => {
    // `Logbus.write` is not fire-and-forget in wall-clock terms: it queues onto
    // `this.chain` and `writeLocked` awaits `acquireLock()` with up to 100 x 50 ms of
    // retries, and the CLI sets `process.exitCode` instead of exiting, so those pending
    // timers keep `vf hook` alive past the host's 10 s spawnSync budget.
    const base = mkdtempSync(join(tmpdir(), "vf-ts-bus-"));
    const orig = process.cwd();
    process.chdir(base);
    try {
      const logs = join(base, CTX_DIR, "logs");
      mkdirSync(logs, { recursive: true });
      // Occupy the lock the way a concurrent hook process would.
      try {
        await lockfile.lock(join(logs, "current.log"), { retries: 0 });
      } catch {
        /* already locked by us is fine for this test's purpose */
      }
      const t0 = Date.now();
      const r = await runHook({ command: "rm -rf /tmp/x", typesafe: enabledSettings() });
      expect(Date.now() - t0).toBeLessThan(2_000);
      // The deterministic verdict still lands; only the audit line is dropped.
      expect(decisionOf(r.stdout)).toBe("deny");
    } finally {
      process.chdir(orig);
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
    let healthIoSeen: { lockWaitMs?: number; writeBudgetMs?: number } | undefined;
    await runHook({
      command: "wget http://x",
      typesafe: enabledSettings({ hookBusLockRetries: 5000 }),
      installLogbus: (opts: { lockRetries?: number }) => {
        busSeen.push(opts);
      },
      healthIo: (io: { lockWaitMs?: number; writeBudgetMs?: number }) => {
        healthIoSeen = io;
      },
    });
    expect(busSeen[0]?.lockRetries).toBe(HOOK_BUS_LOCK_RETRIES_MAX);
    expect(healthIoSeen?.lockWaitMs).toBe(0);
    expect(healthIoSeen?.writeBudgetMs).toBe(HOOK_HEALTH_WRITE_BUDGET_MS);
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
