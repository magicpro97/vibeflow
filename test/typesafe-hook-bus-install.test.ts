// test/typesafe-hook-bus-install.test.ts
//
// The seam's bus install is a process-wide side effect. Two pins:
//   1. a REFUSED call (breaker open) must not install at all - the audit routing of the
//      process is not mutated for a call the guard never makes;
//   2. the DEFAULT installer must not replace a bus the process already had - `installLogbus`
//      is NOT idempotent (`new Logbus` stamps a fresh `runId`), so calling it unconditionally
//      split one process's audit lines across two runIds.
// `wget http://x` is the REACHING fixture (src/hooks/risk-semantic.ts): deterministic LOW with
// a network token, so `shouldConsultSemantic` enters the seam instead of returning early.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hook } from "../src/commands/hooks.js";
import { RISK_LEVEL, type RiskLevel } from "../src/core/hook-contract.js";
import { getLogbus, installLogbus, setLogbusForTests } from "../src/logbus.js";
import { BREAKER_DEFAULTS } from "../src/typesafe-breaker.js";
import { FAILURE_CLASS, TYPESAFE_STATE } from "../src/typesafe-health-file.js";
import { DEFAULT_TYPESAFE_SETTINGS, type TypesafeSettings } from "../src/typesafe-settings.js";

const REACHING = "wget http://x";

function enabledSettings(): TypesafeSettings {
  return {
    ...DEFAULT_TYPESAFE_SETTINGS,
    enabled: true,
    timeoutMs: 10_000,
    hookTimeoutMs: 1500,
    callSites: { ...DEFAULT_TYPESAFE_SETTINGS.callSites },
  };
}

/** Drive the real `hook()` in a temp repo; only the exit code is needed here. */
async function runHook(options: {
  base: string;
  installLogbus?: (opts: { dir: string; lockRetries?: number }) => void;
  judgeRisk?: () => Promise<RiskLevel>;
}): Promise<number> {
  const fakeStdin = {
    on: (event: string, cb: (chunk: Buffer) => void) => {
      if (event === "data")
        setImmediate(() =>
          cb(
            Buffer.from(
              JSON.stringify({
                hook_event_name: "PreToolUse",
                tool_name: "Bash",
                tool_input: { command: REACHING },
              }),
            ),
          ),
        );
      return fakeStdin;
    },
    once: () => fakeStdin,
    resume: () => {},
    pause: () => {},
  };
  const origLog = console.log;
  console.log = () => {};
  try {
    return await hook({
      ...(options.installLogbus === undefined ? {} : { installLogbus: options.installLogbus }),
      ...(options.judgeRisk === undefined ? {} : { judgeRisk: options.judgeRisk }),
      typesafe: enabledSettings(),
      stdin: fakeStdin as never,
      stdinTimeoutMs: 100,
      userRoot: options.base,
    });
  } finally {
    console.log = origLog;
  }
}

describe("the seam's bus install is bounded by the guard's decision", () => {
  test("a refused call installs nothing", async () => {
    // The breaker record is planted OPEN (with a future `cooldown_until`), so the guard's
    // `allowCall` refuses before the judge lambda would run. Pre-fix the seam installed the
    // bus BEFORE `withTypesafeGuard`, so this refusal still replaced the process-wide bus.
    const base = mkdtempSync(join(tmpdir(), "vf-bus-refused-"));
    const orig = process.cwd();
    process.chdir(base);
    try {
      // Every field of the record guard is supplied, because `isTypesafeHealth` rejects a record
      // WHOLE (`{ schema_version: 1, state: "open" }` alone decodes to `idle`) and a rejected
      // record would let the guard ALLOW — the pin would then pass without exercising a refusal.
      writeFileSync(
        join(base, "typesafe-health.json"),
        JSON.stringify({
          schema_version: 1,
          state: TYPESAFE_STATE.OPEN,
          fail_streak: 3,
          consecutive_trips: BREAKER_DEFAULTS.failStreakLimit,
          cooldown_ms: BREAKER_DEFAULTS.cooldownBaseMs,
          cooldown_until: new Date(Date.now() + 3_600_000).toISOString(),
          last_class: FAILURE_CLASS.SERVER,
        }),
      );
      const seen: Array<{ dir: string; lockRetries?: number }> = [];
      let posts = 0;
      const exitCode = await runHook({
        base,
        installLogbus: (opts: { dir: string; lockRetries?: number }) => {
          seen.push(opts);
        },
        judgeRisk: async () => {
          posts += 1;
          return RISK_LEVEL.LOW;
        },
      });
      expect(exitCode).toBe(0);
      expect(posts).toBe(0); // the breaker refused: the judge was never consulted
      expect(seen).toHaveLength(0);
    } finally {
      process.chdir(orig);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("the default installer keeps a bus the process already had", async () => {
    // No `installLogbus` injection: the seam's DEFAULT installer runs. A bus is active in the
    // process (as an in-process caller's would be), so the seam must reuse it rather than
    // replace it with a fresh runId.
    const base = mkdtempSync(join(tmpdir(), "vf-bus-keep-"));
    const busDir = mkdtempSync(join(tmpdir(), "vf-bus-keep-log-"));
    const existing = installLogbus({ dir: busDir, runId: "test-existing" });
    const orig = process.cwd();
    process.chdir(base);
    try {
      const exitCode = await runHook({ base, judgeRisk: async () => RISK_LEVEL.LOW });
      expect(exitCode).toBe(0);
      expect(getLogbus()).toBe(existing);
    } finally {
      process.chdir(orig);
      setLogbusForTests(null);
      rmSync(base, { recursive: true, force: true });
      rmSync(busDir, { recursive: true, force: true });
    }
  });
});
