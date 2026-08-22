import { describe, expect, test } from "bun:test";
import {
  type EvaluatorOutput,
  type RoundDecision,
  decideRound,
} from "../../src/orchestrator/consensus.js";
import {
  ConversationFoldError,
  foldConversation,
} from "../../src/orchestrator/conversation/fold.js";
import type {
  ConversationHealth,
  ConversationLifecycle,
  PublicStoredTraceEvent,
  TerminalLifecycle,
  TraceEvent,
} from "../../src/orchestrator/trace/types.js";

const gates = {
  agreement: { value: true, evidence: "agree" },
  conflict_resolution: { value: true, evidence: "resolved" },
  evidence_quality: { value: true, evidence: "good" },
  convergence: { value: "not_applicable" as const, evidence: "round one" },
};

function event(
  seq: number,
  traceEvent: TraceEvent,
  correlation: Record<string, unknown> = {},
): PublicStoredTraceEvent {
  return {
    workflow_id: "workflow",
    conversation_id: "conversation",
    revision_id: "revision",
    run_id: "run",
    turn_id: "turn",
    operation_id: "operation",
    attempt_id: "attempt",
    event_id: `event-${seq}`,
    seq,
    ts: `2026-08-22T00:00:${String(seq).padStart(2, "0")}.000Z`,
    public_session_ref: null,
    event: traceEvent,
    ...correlation,
  } as unknown as PublicStoredTraceEvent;
}

function configured(seq = 1, policy = "debate", maxRounds = 3): PublicStoredTraceEvent {
  return event(seq, {
    type: "conversation_configured",
    payload: {
      topic: "Choose safely",
      policy,
      max_rounds: maxRounds,
      participants: [
        { participant_id: "p1", role_ref: "believer", engine: "claude", model: "sonnet" },
        { participant_id: "p2", role_ref: "skeptic", engine: "codex", model: "gpt-5.4" },
        {
          participant_id: "eval",
          role_ref: "brainstorm-evaluator",
          engine: "claude",
          model: "sonnet",
        },
      ],
    },
  });
}

function state(
  seq: number,
  lifecycle: ConversationLifecycle,
  health: ConversationHealth = "healthy",
): PublicStoredTraceEvent {
  const terminal = ["COMPLETED", "STOPPED", "FAILED", "ABORTED"].includes(lifecycle);
  return event(seq, {
    type: "state_change",
    payload: { lifecycle, health, terminal, reason: null },
  });
}

function terminal(
  seq: number,
  lifecycle: TerminalLifecycle,
  finalScore: number | null = null,
): PublicStoredTraceEvent {
  return event(seq, {
    type: "conversation_terminal",
    payload: { lifecycle, terminal: true, final_score: finalScore },
  });
}

function activePrefix(): PublicStoredTraceEvent[] {
  return [configured(), state(2, "ACTIVE")];
}

function roundStart(seq: number, roundId = "round-1"): PublicStoredTraceEvent {
  return event(seq, { type: "round_boundary", payload: { round_id: roundId, phase: "start" } });
}

const participantCorrelation = (participantId: string): Record<string, unknown> =>
  participantId === "p1"
    ? { participant_id: "p1", role_ref: "believer", engine: "claude" }
    : participantId === "p2"
      ? { participant_id: "p2", role_ref: "skeptic", engine: "codex" }
      : { participant_id: participantId };

function precommit(
  seq: number,
  participantId: string,
  roundId = "round-1",
  correlation: Record<string, unknown> = {},
): PublicStoredTraceEvent {
  return event(
    seq,
    {
      type: "precommit",
      payload: {
        round_id: roundId,
        participant_id: participantId,
        answer: `precommit-${participantId}`,
        evidence: ["evidence"],
      },
    },
    { ...participantCorrelation(participantId), ...correlation },
  );
}

function delta(
  seq: number,
  participantId: string,
  completes: boolean,
  overrides: Partial<Extract<TraceEvent, { type: "agent_response_delta" }>["payload"]> = {},
  roundId = "round-1",
  correlation: Record<string, unknown> = {},
): PublicStoredTraceEvent {
  return event(
    seq,
    {
      type: "agent_response_delta",
      payload: {
        round_id: roundId,
        participant_id: participantId,
        content_delta: `${participantId}-${seq}`,
        final_claim: completes ? `claim-${participantId}` : null,
        final_evidence: completes ? ["e1", "e1", "e2"] : [],
        completes_response: completes,
        ...overrides,
      },
    },
    { ...participantCorrelation(participantId), ...correlation },
  );
}

function assessment(
  seq: number,
  stage: "blind" | "full",
  value: EvaluatorOutput = structuredClone(gates),
  roundId = "round-1",
): PublicStoredTraceEvent {
  return event(
    seq,
    {
      type: "evaluator_assessment",
      payload: { round_id: roundId, stage, assessment: structuredClone(value) },
    },
    { participant_id: "eval", role_ref: "brainstorm-evaluator", engine: "claude" },
  );
}

function consensus(
  seq: number,
  outcome: "consensus" | "continue" | "exhausted" | "abort" = "consensus",
  roundId = "round-1",
  decision?: RoundDecision,
): PublicStoredTraceEvent {
  return event(seq, {
    type: "consensus_update",
    payload: {
      round_id: roundId,
      decision:
        decision ??
        (outcome === "abort"
          ? { outcome, score: null, reason: "invalid_assessment" }
          : { outcome, score: 1 }),
    },
  });
}

function roundEnd(seq: number, roundId = "round-1"): PublicStoredTraceEvent {
  return event(seq, { type: "round_boundary", payload: { round_id: roundId, phase: "end" } });
}

describe("conversation lifecycle fold", () => {
  test.each([
    ["INIT", "ACTIVE"],
    ["INIT", "STOPPED"],
    ["ACTIVE", "PAUSED"],
    ["ACTIVE", "COMPLETED"],
    ["ACTIVE", "STOPPED"],
    ["ACTIVE", "FAILED"],
    ["ACTIVE", "ABORTED"],
    ["PAUSED", "ACTIVE"],
    ["PAUSED", "STOPPED"],
    ["PAUSED", "FAILED"],
    ["PAUSED", "ABORTED"],
  ] as const)("accepts %s -> %s", (from, to) => {
    if (to === "COMPLETED") {
      const direct = configured(1, "direct", 1);
      const configuredParticipants = (direct.event.payload as never as { participants: unknown[] })
        .participants;
      configuredParticipants.splice(1);
      (configuredParticipants[0] as { role_ref: string }).role_ref = "direct";
      expect(
        foldConversation([
          direct,
          state(2, "ACTIVE"),
          delta(3, "p1", true, {}, "round-1", { role_ref: "direct" }),
          state(4, "COMPLETED"),
          terminal(5, "COMPLETED"),
        ]).lifecycle,
      ).toBe(to);
      return;
    }
    const records = [configured()];
    let seq = 2;
    if (from === "ACTIVE" || from === "PAUSED") records.push(state(seq++, "ACTIVE"));
    if (from === "PAUSED") records.push(state(seq++, "PAUSED"));
    records.push(state(seq++, to));
    if (["COMPLETED", "STOPPED", "FAILED", "ABORTED"].includes(to)) {
      records.push(terminal(seq, to as TerminalLifecycle));
    }
    expect(foldConversation(records).lifecycle).toBe(to);
  });

  test.each([
    ["INIT", "PAUSED"],
    ["INIT", "COMPLETED"],
    ["INIT", "FAILED"],
    ["INIT", "ABORTED"],
    ["ACTIVE", "INIT"],
    ["PAUSED", "INIT"],
    ["PAUSED", "COMPLETED"],
  ] as const)("rejects %s -> %s", (from, to) => {
    const records = [configured()];
    let seq = 2;
    if (from === "ACTIVE" || from === "PAUSED") records.push(state(seq++, "ACTIVE"));
    if (from === "PAUSED") records.push(state(seq++, "PAUSED"));
    records.push(state(seq, to));
    expect(() => foldConversation(records)).toThrow(ConversationFoldError);
  });

  test("health changes independently only while ACTIVE or PAUSED", () => {
    const snapshot = foldConversation([
      configured(),
      state(2, "ACTIVE"),
      state(3, "ACTIVE", "degraded"),
      state(4, "PAUSED", "degraded"),
      state(5, "PAUSED", "healthy"),
    ]);
    expect(snapshot.lifecycle).toBe("PAUSED");
    expect(snapshot.health).toBe("healthy");
    expect(() => foldConversation([configured(), state(2, "ACTIVE", "degraded")])).toThrow(
      /health.*independent/i,
    );
    expect(() => foldConversation([configured(), state(2, "ACTIVE"), state(3, "ACTIVE")])).toThrow(
      /state change/i,
    );
  });

  test("terminal state and terminal record are immutable and must agree", () => {
    expect(() => foldConversation([configured(), state(2, "ACTIVE"), state(3, "STOPPED")])).toThrow(
      /terminal record/i,
    );
    expect(() =>
      foldConversation([
        configured(),
        state(2, "ACTIVE"),
        state(3, "FAILED"),
        terminal(4, "ABORTED"),
      ]),
    ).toThrow(/terminal.*match/i);
    expect(() =>
      foldConversation([
        configured(),
        state(2, "ACTIVE"),
        state(3, "FAILED"),
        terminal(4, "FAILED"),
        event(5, {
          type: "user_message",
          payload: { content: "reopen", target_participants: "all" },
        }),
      ]),
    ).toThrow(/terminal.*immutable/i);
  });
});

describe("conversation envelope and participant reconstruction", () => {
  test("requires contiguous ascending canonical sequence for one configured conversation", () => {
    expect(() => foldConversation([configured(), state(3, "ACTIVE")])).toThrow(/sequence/i);
    expect(() => foldConversation([state(1, "ACTIVE"), configured(2)])).toThrow(
      /configured.*first/i,
    );
    expect(() =>
      foldConversation([
        configured(),
        event(
          2,
          { type: "coordinator_decision", payload: { selected_policy: "debate", reason: "r" } },
          { conversation_id: "other" as never },
        ),
      ]),
    ).toThrow(/conversation/i);
  });

  test("requires stable workflow, revision, and run identity", () => {
    for (const field of ["workflow_id", "revision_id", "run_id"] as const) {
      const next = event(2, {
        type: "coordinator_decision",
        payload: { selected_policy: "debate", reason: "selected" },
      });
      (next as unknown as Record<string, unknown>)[field] = "other";
      expect(() => foldConversation([configured(), next])).toThrow(/identity/i);
    }
  });

  test("reconstructs configured bindings and latest opaque participant session", () => {
    const records = [configured()];
    records.push(
      event(
        2,
        {
          type: "participant_bound",
          payload: {
            participant_id: "p1",
            engine: "claude",
            model: "sonnet",
            prompt_hash: "hash",
            tools: ["read"],
            sandbox: "read-only",
          },
        },
        { participant_id: "p1", role_ref: "believer", engine: "claude" },
      ),
      event(
        3,
        {
          type: "native_history_reconciled",
          payload: {
            public_session_ref: "session-public-1",
            status: "reconciled",
            imported_turn_count: 1,
            imported_tool_count: 0,
            provenance_refs: [],
            evidence_refs: [],
            completeness_reason: "complete",
          },
        },
        { participant_id: "p1", public_session_ref: "session-public-1" as never },
      ),
    );
    const snapshot = foldConversation(records);
    expect(snapshot.participants[0]).toEqual({
      participant_id: "p1",
      role_ref: "believer",
      engine: "claude",
      model: "sonnet",
      public_session_ref: "session-public-1" as never,
    });
    expect(snapshot.participants[1]?.public_session_ref).toBeNull();
  });

  test("rejects a binding whose payload and correlation do not name the configured participant", () => {
    const bad = event(
      2,
      {
        type: "participant_bound",
        payload: {
          participant_id: "p1",
          engine: "claude",
          model: "sonnet",
          prompt_hash: "hash",
          tools: ["read"],
          sandbox: "read-only",
        },
      },
      { participant_id: "p2", role_ref: "believer", engine: "claude" },
    );
    expect(() => foldConversation([configured(), bad])).toThrow(/participant binding/i);
  });

  test("requires exact state-change and participant-binding payloads", () => {
    const badState = state(2, "ACTIVE") as unknown as {
      event: { payload: Record<string, unknown> };
    };
    badState.event.payload.extra = true;
    expect(() => foldConversation([configured(), badState as never])).toThrow(/state change/i);

    const badBinding = event(
      2,
      {
        type: "participant_bound",
        payload: {
          participant_id: "p1",
          engine: "claude",
          model: "sonnet",
          prompt_hash: "hash",
          tools: ["read"],
          sandbox: "read-only",
        },
      },
      { participant_id: "p1", role_ref: "believer", engine: "claude" },
    ) as unknown as { event: { payload: Record<string, unknown> } };
    badBinding.event.payload.raw_prompt = "private";
    expect(() => foldConversation([configured(), badBinding as never])).toThrow(/binding/i);
  });
});

describe("round reconstruction", () => {
  test("allows an ACTIVE or PAUSED round to remain partial", () => {
    const active = foldConversation([
      ...activePrefix(),
      roundStart(3),
      precommit(4, "p1"),
      precommit(5, "p2"),
      assessment(6, "blind"),
      delta(7, "p1", false),
    ]);
    expect(active.rounds[0]).toMatchObject({ complete: false, decision: null });
    expect(active.rounds[0]?.participant_responses[0]).toMatchObject({
      participant_id: "p1",
      content: "p1-7",
      claim: null,
      evidence: [],
      complete: false,
    });
    const paused = foldConversation([
      ...activePrefix(),
      roundStart(3),
      precommit(4, "p1"),
      precommit(5, "p2"),
      assessment(6, "blind"),
      delta(7, "p1", false),
      state(8, "PAUSED"),
    ]);
    expect(paused.lifecycle).toBe("PAUSED");
    expect(paused.rounds[0]?.complete).toBe(false);
  });

  test("ends only after complete responses, ordered blind/full assessment, and non-abort decision", () => {
    const snapshot = foldConversation([
      ...activePrefix(),
      roundStart(3),
      precommit(4, "p1"),
      precommit(5, "p2"),
      assessment(6, "blind"),
      delta(7, "p1", false, { content_delta: "hello " }),
      delta(8, "p2", true),
      delta(9, "p1", true, { content_delta: "world" }),
      assessment(10, "full"),
      consensus(11),
      roundEnd(12),
    ]);
    expect(snapshot.rounds[0]).toMatchObject({
      complete: true,
      decision: { outcome: "consensus" },
    });
    expect(snapshot.rounds[0]?.participant_responses[0]).toEqual({
      participant_id: "p1",
      content: "hello world",
      claim: "claim-p1",
      evidence: ["e1", "e2"],
      complete: true,
    });
    expect(snapshot.consensus_score).toBe(1);
  });

  test.each([
    [
      "incomplete response",
      [precommit(4, "p1"), precommit(5, "p2"), assessment(6, "blind"), delta(7, "p1", false)],
    ],
    [
      "missing blind",
      [precommit(4, "p1"), precommit(5, "p2"), delta(6, "p1", true), delta(7, "p2", true)],
    ],
    [
      "missing full",
      [
        precommit(4, "p1"),
        precommit(5, "p2"),
        assessment(6, "blind"),
        delta(7, "p1", true),
        delta(8, "p2", true),
        consensus(9),
      ],
    ],
    [
      "missing consensus",
      [
        precommit(4, "p1"),
        precommit(5, "p2"),
        assessment(6, "blind"),
        delta(7, "p1", true),
        delta(8, "p2", true),
        assessment(9, "full"),
      ],
    ],
    [
      "aborted decision",
      [
        precommit(4, "p1"),
        precommit(5, "p2"),
        assessment(6, "blind"),
        delta(7, "p1", true),
        delta(8, "p2", true),
        assessment(9, "full"),
        consensus(10, "abort"),
      ],
    ],
  ] as const)("rejects an ended round with %s", (_case, middle) => {
    const resequenced = middle.map((record, index) => ({ ...record, seq: index + 4 }));
    expect(() =>
      foldConversation([
        ...activePrefix(),
        roundStart(3),
        ...resequenced,
        roundEnd(resequenced.length + 4),
      ]),
    ).toThrow(ConversationFoldError);
  });

  test("rejects completion data before completion, duplicate completion, and later deltas", () => {
    expect(() =>
      foldConversation([
        ...activePrefix(),
        roundStart(3),
        precommit(4, "p1"),
        precommit(5, "p2"),
        assessment(6, "blind"),
        delta(7, "p1", false, { final_claim: "early" }),
      ]),
    ).toThrow(/completion data/i);
    expect(() =>
      foldConversation([
        ...activePrefix(),
        roundStart(3),
        precommit(4, "p1"),
        precommit(5, "p2"),
        assessment(6, "blind"),
        delta(7, "p1", true),
        delta(8, "p1", true),
      ]),
    ).toThrow(/after completion/i);
  });

  test("rejects full-before-blind, duplicate stages, consensus-before-full, and later round data", () => {
    expect(() =>
      foldConversation([
        ...activePrefix(),
        roundStart(3),
        precommit(4, "p1"),
        precommit(5, "p2"),
        assessment(6, "full"),
      ]),
    ).toThrow(/blind.*before full/i);
    expect(() =>
      foldConversation([
        ...activePrefix(),
        roundStart(3),
        precommit(4, "p1"),
        precommit(5, "p2"),
        assessment(6, "blind"),
        assessment(7, "blind"),
      ]),
    ).toThrow(/duplicate.*assessment/i);
    expect(() =>
      foldConversation([
        ...activePrefix(),
        roundStart(3),
        precommit(4, "p1"),
        precommit(5, "p2"),
        assessment(6, "blind"),
        delta(7, "p1", true),
        delta(8, "p2", true),
        consensus(9),
      ]),
    ).toThrow(/assessment.*before consensus/i);
    expect(() =>
      foldConversation([
        ...activePrefix(),
        roundStart(3),
        precommit(4, "p1"),
        precommit(5, "p2"),
        assessment(6, "blind"),
        delta(7, "p1", true),
        delta(8, "p2", true),
        assessment(9, "full"),
        consensus(10),
        roundEnd(11),
        delta(12, "p1", false),
      ]),
    ).toThrow(/active round/i);
  });

  test("fails closed on malformed event payloads", () => {
    const malformed = delta(4, "p1", false) as unknown as {
      event: { payload: { completes_response: unknown } };
    };
    malformed.event.payload.completes_response = "false";
    expect(() => foldConversation([...activePrefix(), roundStart(3), malformed as never])).toThrow(
      /malformed/i,
    );
  });

  test("requires a precommit before response and never treats the evaluator as a responder", () => {
    expect(() =>
      foldConversation([...activePrefix(), roundStart(3), delta(4, "p1", false)]),
    ).toThrow(/precommit/i);
    expect(() =>
      foldConversation([...activePrefix(), roundStart(3), delta(4, "eval", true)]),
    ).toThrow(/evaluator|responder/i);
  });

  test("requires the configured evaluator correlation and every participant response", () => {
    const wrongEvaluator = assessment(6, "blind") as unknown as {
      participant_id: string;
      role_ref: string;
      engine: string;
    };
    wrongEvaluator.participant_id = "p1";
    wrongEvaluator.role_ref = "believer";
    expect(() =>
      foldConversation([
        ...activePrefix(),
        roundStart(3),
        precommit(4, "p1"),
        precommit(5, "p2"),
        wrongEvaluator as never,
      ]),
    ).toThrow(/evaluator/i);
    expect(() =>
      foldConversation([
        ...activePrefix(),
        roundStart(3),
        precommit(4, "p1"),
        precommit(5, "p2"),
        assessment(6, "blind"),
        delta(7, "p1", true),
        assessment(8, "full"),
        consensus(9),
        roundEnd(10),
      ]),
    ).toThrow(/participant|response/i);
  });

  test("rejects continue at max rounds and exhausted before max rounds", () => {
    const unresolved: EvaluatorOutput = {
      ...structuredClone(gates),
      evidence_quality: { value: false, evidence: "weak" },
    };
    const completed = (maxRounds: number, outcome: "continue" | "exhausted") => [
      configured(1, "debate", maxRounds),
      state(2, "ACTIVE"),
      roundStart(3),
      precommit(4, "p1"),
      precommit(5, "p2"),
      assessment(6, "blind", unresolved),
      delta(7, "p1", true),
      delta(8, "p2", true),
      assessment(9, "full", unresolved),
      consensus(10, outcome, "round-1", { outcome, score: 2 / 3 }),
      roundEnd(11),
    ];
    expect(() => foldConversation(completed(1, "continue"))).toThrow(/canonical|decision/i);
    expect(() => foldConversation(completed(2, "exhausted"))).toThrow(/canonical|decision/i);
  });

  test("copies nested assessments and decisions instead of aliasing journal input", () => {
    const blind = assessment(6, "blind");
    const decision = consensus(10);
    const snapshot = foldConversation([
      ...activePrefix(),
      roundStart(3),
      precommit(4, "p1"),
      precommit(5, "p2"),
      blind,
      delta(7, "p1", true),
      delta(8, "p2", true),
      assessment(9, "full"),
      decision,
      roundEnd(11),
    ]);
    (blind.event.payload as never as { assessment: typeof gates }).assessment.agreement.evidence =
      "mutated";
    (decision.event.payload as never as { decision: { score: number } }).decision.score = 0;
    expect(snapshot.rounds[0]?.evaluator_assessments[0]?.assessment.agreement.evidence).toBe(
      "agree",
    );
    expect(snapshot.rounds[0]?.decision?.score).toBe(1);
  });
});

describe("normative debate round ordering", () => {
  const nonConsensus: EvaluatorOutput = {
    agreement: { value: true, evidence: "agree" },
    conflict_resolution: { value: true, evidence: "resolved" },
    evidence_quality: { value: false, evidence: "weak" },
    convergence: { value: "not_applicable", evidence: "round one" },
  };

  test("requires every precommit before blind assessment and blind before any response", () => {
    expect(() =>
      foldConversation([
        ...activePrefix(),
        roundStart(3),
        precommit(4, "p1"),
        assessment(5, "blind"),
      ]),
    ).toThrow(/precommit/i);
    expect(() =>
      foldConversation([
        ...activePrefix(),
        roundStart(3),
        precommit(4, "p1"),
        precommit(5, "p2"),
        delta(6, "p1", true),
      ]),
    ).toThrow(/blind/i);
    expect(() =>
      foldConversation([
        ...activePrefix(),
        roundStart(3),
        precommit(4, "p1"),
        assessment(5, "blind"),
        precommit(6, "p2"),
      ]),
    ).toThrow(/precommit|blind/i);
  });

  test("requires every completed response before the full assessment", () => {
    expect(() =>
      foldConversation([
        ...activePrefix(),
        roundStart(3),
        precommit(4, "p1"),
        precommit(5, "p2"),
        assessment(6, "blind"),
        delta(7, "p1", true),
        assessment(8, "full"),
      ]),
    ).toThrow(/response/i);
  });

  test("requires the emitted decision to equal decideRound including the raw score", () => {
    const prefix = [
      configured(1, "debate", 2),
      state(2, "ACTIVE"),
      roundStart(3),
      precommit(4, "p1"),
      precommit(5, "p2"),
      assessment(6, "blind", nonConsensus),
      delta(7, "p1", true),
      delta(8, "p2", true),
      assessment(9, "full", nonConsensus),
    ];
    expect(() =>
      foldConversation([
        ...prefix,
        consensus(10, "continue", "round-1", { outcome: "continue", score: 0.667 }),
        roundEnd(11),
      ]),
    ).toThrow(/canonical|decision/i);
    expect(() =>
      foldConversation([
        ...prefix,
        consensus(10, "consensus", "round-1", { outcome: "consensus", score: 2 / 3 }),
        roundEnd(11),
      ]),
    ).toThrow(/canonical|decision/i);

    const canonical = decideRound(nonConsensus, 1, 2);
    expect(
      foldConversation([...prefix, consensus(10, "continue", "round-1", canonical), roundEnd(11)])
        .rounds[0]?.decision,
    ).toEqual(canonical);
  });

  test("uses the one-based round number when deriving the canonical decision", () => {
    const roundTwoAssessment: EvaluatorOutput = {
      agreement: { value: true, evidence: "agree" },
      conflict_resolution: { value: true, evidence: "resolved" },
      evidence_quality: { value: true, evidence: "good" },
      convergence: { value: false, evidence: "not converged" },
    };
    const roundOneDecision = decideRound(nonConsensus, 1, 2);
    const records = [
      configured(1, "debate", 2),
      state(2, "ACTIVE"),
      roundStart(3),
      precommit(4, "p1"),
      precommit(5, "p2"),
      assessment(6, "blind", nonConsensus),
      delta(7, "p1", true),
      delta(8, "p2", true),
      assessment(9, "full", nonConsensus),
      consensus(10, "continue", "round-1", roundOneDecision),
      roundEnd(11),
      roundStart(12, "round-2"),
      precommit(13, "p1", "round-2"),
      precommit(14, "p2", "round-2"),
      assessment(15, "blind", roundTwoAssessment, "round-2"),
      delta(16, "p1", true, {}, "round-2"),
      delta(17, "p2", true, {}, "round-2"),
      assessment(18, "full", roundTwoAssessment, "round-2"),
      consensus(19, "consensus", "round-2", { outcome: "consensus", score: 1 }),
      roundEnd(20, "round-2"),
    ];
    expect(() => foldConversation(records)).toThrow(/canonical|decision/i);
  });

  test("requires complete participant role and engine correlation without coordinator extras", () => {
    const missingRole = precommit(4, "p1") as unknown as Record<string, unknown>;
    missingRole.role_ref = undefined;
    expect(() =>
      foldConversation([...activePrefix(), roundStart(3), missingRole as never]),
    ).toThrow(/correlation/i);

    expect(() =>
      foldConversation([
        ...activePrefix(),
        roundStart(3),
        precommit(4, "p1"),
        precommit(5, "p2"),
        assessment(6, "blind"),
        delta(7, "p1", true, {}, "round-1", { role_ref: "skeptic" }),
      ]),
    ).toThrow(/correlation/i);

    const correlatedConsensus = consensus(10) as unknown as Record<string, unknown>;
    correlatedConsensus.participant_id = "p1";
    correlatedConsensus.role_ref = "believer";
    correlatedConsensus.engine = "claude";
    expect(() =>
      foldConversation([
        ...activePrefix(),
        roundStart(3),
        precommit(4, "p1"),
        precommit(5, "p2"),
        assessment(6, "blind"),
        delta(7, "p1", true),
        delta(8, "p2", true),
        assessment(9, "full"),
        correlatedConsensus as never,
        roundEnd(11),
      ]),
    ).toThrow(/correlation/i);
  });
});

describe("terminal score authority", () => {
  const completedDebate = (lifecycle: TerminalLifecycle, finalScore: number | null) => [
    configured(1, "debate", 1),
    state(2, "ACTIVE"),
    roundStart(3),
    precommit(4, "p1"),
    precommit(5, "p2"),
    assessment(6, "blind"),
    delta(7, "p1", true),
    delta(8, "p2", true),
    assessment(9, "full"),
    consensus(10),
    roundEnd(11),
    state(12, lifecycle),
    terminal(13, lifecycle, finalScore),
  ];

  test("COMPLETED debate requires the exact raw score of its last completed decision", () => {
    expect(foldConversation(completedDebate("COMPLETED", 1)).consensus_score).toBe(1);
    expect(() => foldConversation(completedDebate("COMPLETED", null))).toThrow(/terminal score/i);
    expect(() => foldConversation(completedDebate("COMPLETED", 0.999))).toThrow(/terminal score/i);
  });

  test("COMPLETED debate rejects a canonical continue decision that requires another round", () => {
    const unresolved: EvaluatorOutput = {
      ...structuredClone(gates),
      evidence_quality: { value: false, evidence: "weak" },
    };
    const decision = decideRound(unresolved, 1, 2);
    expect(decision.outcome).toBe("continue");
    const records = [
      configured(1, "debate", 2),
      state(2, "ACTIVE"),
      roundStart(3),
      precommit(4, "p1"),
      precommit(5, "p2"),
      assessment(6, "blind", unresolved),
      delta(7, "p1", true),
      delta(8, "p2", true),
      assessment(9, "full", unresolved),
      consensus(10, "continue", "round-1", decision),
      roundEnd(11),
      state(12, "COMPLETED"),
      terminal(13, "COMPLETED", decision.score),
    ];
    expect(() => foldConversation(records)).toThrow(/continue|terminal decision/i);
  });

  test.each(["STOPPED", "FAILED", "ABORTED"] as const)(
    "%s requires a null terminal score even after a completed round",
    (lifecycle) => {
      expect(() => foldConversation(completedDebate(lifecycle, 1))).toThrow(/terminal score/i);
      expect(foldConversation(completedDebate(lifecycle, null)).lifecycle).toBe(lifecycle);
    },
  );

  test("direct completion requires a null terminal score", () => {
    const direct = configured(1, "direct", 1);
    const participants = (direct.event.payload as never as { participants: unknown[] })
      .participants;
    participants.splice(1);
    (participants[0] as { role_ref: string }).role_ref = "direct";
    const prefix = [
      direct,
      state(2, "ACTIVE"),
      delta(3, "p1", true, {}, "round-1", { role_ref: "direct" }),
      state(4, "COMPLETED"),
    ];
    expect(foldConversation([...prefix, terminal(5, "COMPLETED", null)]).lifecycle).toBe(
      "COMPLETED",
    );
    expect(() => foldConversation([...prefix, terminal(5, "COMPLETED", 1)])).toThrow(
      /terminal score/i,
    );
  });

  test("non-debate completion requires a null terminal score", () => {
    const prefix = [configured(1, "held-message", 1), state(2, "ACTIVE"), state(3, "COMPLETED")];
    expect(foldConversation([...prefix, terminal(4, "COMPLETED", null)]).lifecycle).toBe(
      "COMPLETED",
    );
    expect(() => foldConversation([...prefix, terminal(4, "COMPLETED", 1)])).toThrow(
      /terminal score/i,
    );
  });
});

test("direct policy folds streamed deltas into a synthetic completed round", () => {
  const direct = configured(1, "direct", 1);
  const participants = (direct.event.payload as never as { participants: unknown[] }).participants;
  participants.splice(1);
  (participants[0] as { role_ref: string }).role_ref = "direct";
  const snapshot = foldConversation([
    direct,
    state(2, "ACTIVE"),
    delta(3, "p1", false, { content_delta: "hello " }, "round-1", { role_ref: "direct" }),
    delta(4, "p1", true, { content_delta: "world" }, "round-1", { role_ref: "direct" }),
    state(5, "COMPLETED"),
    terminal(6, "COMPLETED"),
  ]);
  expect(snapshot.rounds[0]).toMatchObject({
    round_id: "round-1",
    complete: true,
    decision: null,
    participant_responses: [{ participant_id: "p1", content: "hello world", complete: true }],
  });
  expect(() =>
    foldConversation([
      direct,
      state(2, "ACTIVE"),
      delta(3, "p1", false, {}, "round-1", { role_ref: "direct" }),
      state(4, "COMPLETED"),
    ]),
  ).toThrow(/response|active round/i);
});
