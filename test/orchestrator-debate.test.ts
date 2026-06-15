import { describe, expect, test } from "bun:test";
import type { DebatePosition, DebateResult, WorkUnit } from "../src/core.js";
import {
  DEFAULT_MAX_DEBATE_ROUNDS,
  DEBATE_PROFILES,
  debateContinue,
  debateRoundPrompts,
  reviewDebatePrompt,
  synthesizeResult,
  unitDebatePrompt,
  type DebateRound,
} from "../src/orchestrator/debate.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleUnit: WorkUnit = {
  name: "auth-rewrite",
  status: "pending",
  confidence: 0,
  skills_used: ["security-audit"],
  scope: ["src/auth/**", "test/auth/**"],
  spec: "Rewrite auth to use JWT",
  gates: { build: "pass", lint: "pass", test: "pass", review: "pending" },
  resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
};

const samplePosition: DebatePosition = {
  agent: "proposer",
  claim: "JWT is the right call",
  evidence: ["src/auth/legacy.ts:10", "spec/req-auth.md:3"],
};

const sampleChallengerPosition: DebatePosition = {
  agent: "challenger",
  claim: "Refresh token rotation is missing",
  evidence: ["src/auth/jwt.ts:42"],
};

const baseRound: DebateRound = {
  round: 1,
  question: "Should we use JWT?",
  context: "PR #123 auth-rewrite",
};

// ---------------------------------------------------------------------------
// DEBATE_PROFILES — shape of the three subagent roles
// ---------------------------------------------------------------------------

describe("orchestrator/debate: DEBATE_PROFILES", () => {
  test("exposes proposer/challenger/judge with matching role field", () => {
    expect(DEBATE_PROFILES.proposer.role).toBe("proposer");
    expect(DEBATE_PROFILES.challenger.role).toBe("challenger");
    expect(DEBATE_PROFILES.judge.role).toBe("judge");
  });

  test("every profile has non-empty instruction and agentType", () => {
    for (const k of ["proposer", "challenger", "judge"] as const) {
      const p = DEBATE_PROFILES[k];
      expect(p.agentType.length).toBeGreaterThan(0);
      expect(p.instruction.length).toBeGreaterThan(0);
    }
  });

  test("DEFAULT_MAX_DEBATE_ROUNDS is a positive integer", () => {
    expect(DEFAULT_MAX_DEBATE_ROUNDS).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_MAX_DEBATE_ROUNDS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// debateRoundPrompts — branches on challengerPosition / proposerPosition
// ---------------------------------------------------------------------------

describe("orchestrator/debate: debateRoundPrompts", () => {
  test("first round: no positions yet — proposer omits rebuttal, challenger falls back to review instruction", () => {
    const r = debateRoundPrompts(baseRound);
    // Proposer: no previous challenger rebuttal section
    expect(r.proposerPrompt).toContain("## Question");
    expect(r.proposerPrompt).toContain("## Context");
    expect(r.proposerPrompt).not.toContain("Previous Challenger Rebuttal");
    // Challenger: falls back to CHALLENGER_REVIEW_INSTRUCTION
    expect(r.challengerPrompt).toContain("Review the context and find every possible flaw");
    expect(r.challengerPrompt).not.toContain("Proposer's Claim");
    // Judge: no proposer/challenger sections
    expect(r.judgePrompt).not.toContain("## Proposer");
    expect(r.judgePrompt).not.toContain("## Challenger Rebuttal");
  });

  test("with proposer position only: challenger references proposer, judge shows proposer section, proposer has no rebuttal", () => {
    const round: DebateRound = {
      ...baseRound,
      proposerPosition: samplePosition,
    };
    const r = debateRoundPrompts(round);
    // Challenger sees proposer
    expect(r.challengerPrompt).toContain("Proposer's Claim");
    expect(r.challengerPrompt).toContain(samplePosition.claim);
    // Judge sees proposer
    expect(r.judgePrompt).toContain("## Proposer");
    expect(r.judgePrompt).toContain(samplePosition.claim);
    // Judge does not see challenger
    expect(r.judgePrompt).not.toContain("## Challenger Rebuttal");
    // Proposer still has no challenger rebuttal
    expect(r.proposerPrompt).not.toContain("Previous Challenger Rebuttal");
  });

  test("with challenger position only: proposer references challenger, judge shows challenger", () => {
    const round: DebateRound = {
      ...baseRound,
      challengerPosition: sampleChallengerPosition,
    };
    const r = debateRoundPrompts(round);
    // Proposer includes challenger rebuttal
    expect(r.proposerPrompt).toContain("Previous Challenger Rebuttal");
    expect(r.proposerPrompt).toContain(sampleChallengerPosition.claim);
    // Challenger does NOT see proposer's claim (proposerPosition is falsy)
    expect(r.challengerPrompt).not.toContain("Proposer's Claim");
    // Judge sees challenger
    expect(r.judgePrompt).toContain("## Challenger Rebuttal");
    expect(r.judgePrompt).toContain(sampleChallengerPosition.claim);
    // Judge does not see proposer
    expect(r.judgePrompt).not.toContain("## Proposer");
  });

  test("with both positions: proposer+challenger+judge all include both sides", () => {
    const round: DebateRound = {
      ...baseRound,
      proposerPosition: samplePosition,
      challengerPosition: sampleChallengerPosition,
    };
    const r = debateRoundPrompts(round);
    expect(r.proposerPrompt).toContain("Previous Challenger Rebuttal");
    expect(r.challengerPrompt).toContain("Proposer's Claim");
    expect(r.judgePrompt).toContain("## Proposer");
    expect(r.judgePrompt).toContain("## Challenger Rebuttal");
    // All three contain the question and context
    for (const p of [r.proposerPrompt, r.challengerPrompt, r.judgePrompt]) {
      expect(p).toContain("## Question");
      expect(p).toContain("## Context");
    }
  });

  test("evidence arrays are joined with \"; \" in the prompts that reference them", () => {
    const round: DebateRound = {
      ...baseRound,
      proposerPosition: samplePosition,
      challengerPosition: sampleChallengerPosition,
    };
    const r = debateRoundPrompts(round);
    // proposerPrompt references challengerPosition.evidence
    expect(r.proposerPrompt).toContain(sampleChallengerPosition.evidence.join("; "));
    // challengerPrompt references proposerPosition.evidence
    expect(r.challengerPrompt).toContain(samplePosition.evidence.join("; "));
    // judgePrompt references both
    expect(r.judgePrompt).toContain(samplePosition.evidence.join("; "));
    expect(r.judgePrompt).toContain(sampleChallengerPosition.evidence.join("; "));
  });

  test("proposer/challenger/judge prompts each include the role's instruction", () => {
    const r = debateRoundPrompts(baseRound);
    expect(r.proposerPrompt).toContain(DEBATE_PROFILES.proposer.instruction);
    expect(r.challengerPrompt).toContain(DEBATE_PROFILES.challenger.instruction);
    expect(r.judgePrompt).toContain(DEBATE_PROFILES.judge.instruction);
  });
});

// ---------------------------------------------------------------------------
// debateContinue — branches on confidence, currentRound, openQuestions
// ---------------------------------------------------------------------------

describe("orchestrator/debate: debateContinue", () => {
  test("returns false when confidence >= 1.0 (highest-priority branch)", () => {
    expect(debateContinue(0, 1.0, ["still open"])).toBe(false);
    expect(debateContinue(0, 1.5, ["still open"])).toBe(false);
  });

  test("returns false when currentRound >= maxRounds (default 3)", () => {
    expect(debateContinue(3, 0.5, ["still open"])).toBe(false);
    expect(debateContinue(4, 0.5, ["still open"])).toBe(false);
  });

  test("returns false when openQuestions is empty", () => {
    expect(debateContinue(0, 0.5, [])).toBe(false);
  });

  test("returns true when confidence < 1, round < max, and there are open questions", () => {
    expect(debateContinue(0, 0.99, ["a question"])).toBe(true);
    expect(debateContinue(2, 0.5, ["a", "b"])).toBe(true);
  });

  test("respects custom maxRounds", () => {
    // 2 < 5: continue; 5 >= 5: stop
    expect(debateContinue(2, 0.5, ["q"], 5)).toBe(true);
    expect(debateContinue(5, 0.5, ["q"], 5)).toBe(false);
    // 1 < 2: continue; 2 >= 2: stop
    expect(debateContinue(1, 0.5, ["q"], 2)).toBe(true);
    expect(debateContinue(2, 0.5, ["q"], 2)).toBe(false);
  });

  test("confidence check short-circuits the other branches", () => {
    // confidence=1 even with round >= max and empty open questions
    expect(debateContinue(5, 1.0, [])).toBe(false);
    // confidence=1 even with explicit maxRounds
    expect(debateContinue(10, 1.0, ["q"], 2)).toBe(false);
  });

  test("currentRound check short-circuits openQuestions", () => {
    // round >= max even with non-empty open questions
    expect(debateContinue(DEFAULT_MAX_DEBATE_ROUNDS, 0.5, ["q"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// synthesizeResult — flattens proposer+challenger positions from each round
// ---------------------------------------------------------------------------

describe("orchestrator/debate: synthesizeResult", () => {
  test("returns question, resolution, confidence, rejected verbatim", () => {
    const r = synthesizeResult("Q?", [], 0.7, "ship it", ["bad arg"]);
    expect(r.question).toBe("Q?");
    expect(r.resolution).toBe("ship it");
    expect(r.confidence).toBe(0.7);
    expect(r.rejected).toEqual(["bad arg"]);
  });

  test("flattens only present positions from each round (no undefined entries)", () => {
    const r = synthesizeResult("Q?", [
      { ...baseRound, proposerPosition: samplePosition },
      { ...baseRound, challengerPosition: sampleChallengerPosition },
      { ...baseRound, proposerPosition: { ...samplePosition, agent: "p2" }, challengerPosition: { ...sampleChallengerPosition, agent: "c2" } },
    ], 0.9, "go", []);
    expect(r.positions).toHaveLength(4);
    expect(r.positions[0]).toEqual(samplePosition);
    expect(r.positions[1]).toEqual(sampleChallengerPosition);
    expect(r.positions[2]?.agent).toBe("p2");
    expect(r.positions[3]?.agent).toBe("c2");
  });

  test("empty rounds → empty positions array", () => {
    const r = synthesizeResult("Q?", [], 0, "", []);
    expect(r.positions).toEqual([]);
  });

  test("round with neither position contributes nothing", () => {
    const r = synthesizeResult("Q?", [baseRound, baseRound], 0, "", []);
    expect(r.positions).toEqual([]);
  });

  test("result is structurally a DebateResult", () => {
    const r: DebateResult = synthesizeResult("Q?", [], 0, "", []);
    expect(typeof r.question).toBe("string");
    expect(Array.isArray(r.positions)).toBe(true);
    expect(typeof r.resolution).toBe("string");
    expect(typeof r.confidence).toBe("number");
    expect(Array.isArray(r.rejected)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// unitDebatePrompt — branches on spec, scope, evidence
// ---------------------------------------------------------------------------

describe("orchestrator/debate: unitDebatePrompt", () => {
  test("always includes the unit name and status line", () => {
    const prompt = unitDebatePrompt(sampleUnit);
    expect(prompt).toContain(`## Work Unit: ${sampleUnit.name}`);
    expect(prompt).toContain(`status=${sampleUnit.status}`);
    expect(prompt).toContain(`confidence=${sampleUnit.confidence}`);
  });

  test("includes spec section when unit.spec is set", () => {
    expect(unitDebatePrompt(sampleUnit)).toContain("### Spec");
    expect(unitDebatePrompt(sampleUnit)).toContain(sampleUnit.spec!);
  });

  test("omits spec section when unit.spec is missing", () => {
    const noSpec: WorkUnit = { ...sampleUnit, spec: undefined };
    const prompt = unitDebatePrompt(noSpec);
    expect(prompt).not.toContain("### Spec");
  });

  test("includes scope section with comma-joined entries when unit.scope is non-empty", () => {
    const prompt = unitDebatePrompt(sampleUnit);
    expect(prompt).toContain("### Scope");
    expect(prompt).toContain(sampleUnit.scope!.join(", "));
  });

  test("omits scope section when unit.scope is missing", () => {
    const noScope: WorkUnit = { ...sampleUnit, scope: undefined };
    const prompt = unitDebatePrompt(noScope);
    expect(prompt).not.toContain("### Scope");
  });

  test("omits scope section when unit.scope is an empty array", () => {
    const emptyScope: WorkUnit = { ...sampleUnit, scope: [] };
    const prompt = unitDebatePrompt(emptyScope);
    expect(prompt).not.toContain("### Scope");
  });

  test("includes evidence section joined by newlines when unit.evidence is non-empty", () => {
    const withEvidence: WorkUnit = {
      ...sampleUnit,
      evidence: ["src/auth/jwt.ts:10", "spec/req-auth.md:3"],
    };
    const prompt = unitDebatePrompt(withEvidence);
    expect(prompt).toContain("### Current Evidence");
    expect(prompt).toContain("src/auth/jwt.ts:10\nspec/req-auth.md:3");
  });

  test("omits evidence section when unit.evidence is missing or empty", () => {
    const noEvidence: WorkUnit = { ...sampleUnit, evidence: undefined };
    expect(unitDebatePrompt(noEvidence)).not.toContain("### Current Evidence");
    const emptyEvidence: WorkUnit = { ...sampleUnit, evidence: [] };
    expect(unitDebatePrompt(emptyEvidence)).not.toContain("### Current Evidence");
  });
});

// ---------------------------------------------------------------------------
// reviewDebatePrompt — diff truncation at 8000 chars
// ---------------------------------------------------------------------------

describe("orchestrator/debate: reviewDebatePrompt", () => {
  test("includes PR title, description, and diff inside a ```diff fenced block", () => {
    const prompt = reviewDebatePrompt("Add JWT auth", "Implements spec", "+const a = 1");
    expect(prompt).toContain("## PR: Add JWT auth");
    expect(prompt).toContain("### Description");
    expect(prompt).toContain("Implements spec");
    expect(prompt).toContain("```diff");
    expect(prompt).toContain("+const a = 1");
    expect(prompt).toContain("```");
  });

  test("truncates the diff to at most 8000 characters", () => {
    const huge = "x".repeat(20_000);
    const prompt = reviewDebatePrompt("big", "d", huge);
    // The diff is the substring between the ```diff fence and the closing ```
    const start = prompt.indexOf("```diff\n");
    const end = prompt.lastIndexOf("\n```");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const diffBlock = prompt.slice(start, end);
    const inner = diffBlock.slice("```diff\n".length);
    expect(inner.length).toBe(8000);
    expect(inner).not.toBe(huge);
  });

  test("keeps diffs shorter than 8000 chars intact (no truncation)", () => {
    const small = "+let a = 1";
    const prompt = reviewDebatePrompt("t", "d", small);
    expect(prompt).toContain(small);
  });
});
