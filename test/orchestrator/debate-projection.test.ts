import { expect, test } from "bun:test";
import {
  type DecisionMatrix,
  normalizeDebateOption,
  projectDecisionMatrix,
} from "../../src/orchestrator/conversation/debate-projection.js";
import type {
  EvaluatorAssessmentPayload,
  StoredTraceEvent,
  TraceEvent,
} from "../../src/orchestrator/trace/types.js";

const correlation = {
  workflow_id: "workflow",
  conversation_id: "conversation",
  revision_id: "revision",
  run_id: "run",
  turn_id: "turn",
  operation_id: "operation",
  attempt_id: "attempt",
};

const stored = (
  seq: number,
  event: TraceEvent,
  ts = `2026-08-22T00:00:${String(seq).padStart(2, "0")}.000Z`,
): StoredTraceEvent => ({
  ...correlation,
  event_id: `event-${seq}`,
  seq,
  ts,
  idempotency_key: `key-${seq}`,
  event,
});

const assessment = (
  values: [boolean, boolean, boolean, boolean | "not_applicable"] = [true, true, true, true],
): EvaluatorAssessmentPayload["assessment"] => ({
  agreement: { value: values[0], evidence: "agreement" },
  conflict_resolution: { value: values[1], evidence: "conflict" },
  evidence_quality: { value: values[2], evidence: "evidence" },
  convergence: { value: values[3], evidence: "convergence" },
});

interface ResponseFixture {
  participant: string;
  claim: string | null;
  evidence?: string[];
}

function completedRound(
  startSeq: number,
  roundId: string,
  responses: readonly ResponseFixture[],
  full = assessment(),
): StoredTraceEvent[] {
  let seq = startSeq;
  const events = [
    stored(seq++, { type: "round_boundary", payload: { round_id: roundId, phase: "start" } }),
  ];
  for (const response of responses) {
    events.push(
      stored(seq++, {
        type: "agent_response_delta",
        payload: {
          round_id: roundId,
          participant_id: response.participant,
          content_delta: response.claim ?? "",
          final_claim: response.claim,
          final_evidence: response.evidence ?? [],
          completes_response: true,
        },
      }),
    );
  }
  events.push(
    stored(seq++, {
      type: "evaluator_assessment",
      payload: { round_id: roundId, stage: "full", assessment: full },
    }),
    stored(seq++, {
      type: "consensus_update",
      payload: { round_id: roundId, decision: { outcome: "consensus", score: 1 } },
    }),
    stored(seq++, { type: "round_boundary", payload: { round_id: roundId, phase: "end" } }),
  );
  return events;
}

const rows = (matrix: DecisionMatrix | null) => matrix?.rows ?? [];

test("decision matrix is null for empty, incomplete, aborted, or empty-claim rounds", () => {
  expect(projectDecisionMatrix([])).toBeNull();
  expect(
    projectDecisionMatrix([
      stored(1, { type: "round_boundary", payload: { round_id: "r1", phase: "start" } }),
      stored(2, {
        type: "agent_response_delta",
        payload: {
          round_id: "r1",
          participant_id: "p1",
          content_delta: "draft",
          final_claim: "draft",
          final_evidence: [],
          completes_response: true,
        },
      }),
    ]),
  ).toBeNull();
  const aborted = completedRound(1, "r1", [{ participant: "p1", claim: "draft" }]);
  aborted[aborted.length - 2] = stored(aborted.length - 1, {
    type: "consensus_update",
    payload: {
      round_id: "r1",
      decision: { outcome: "abort", score: null, reason: "invalid_assessment" },
    },
  });
  expect(projectDecisionMatrix(aborted)).toBeNull();
  expect(
    projectDecisionMatrix(
      completedRound(1, "r1", [
        { participant: "p1", claim: " \t\n " },
        { participant: "p2", claim: null },
      ]),
    ),
  ).toBeNull();
});

test("NFKC, Unicode whitespace, and non-locale case normalization group equivalent claims", () => {
  expect(normalizeDebateOption("\u0085Alpha\u0085")).toEqual(normalizeDebateOption("Alpha"));
  const matrix = projectDecisionMatrix(
    completedRound(
      1,
      "r1",
      [
        { participant: "p1", claim: "  Ｃafé\tIDEA  ", evidence: ["one", "two"] },
        { participant: "p2", claim: "café\u00a0idea", evidence: ["three"] },
        { participant: "p3", claim: "Zeta", evidence: [] },
      ],
      assessment([true, false, true, "not_applicable"]),
    ),
  );
  expect(matrix?.method).toBe("weighted_sum");
  expect(rows(matrix)).toEqual([
    {
      option: "Café IDEA",
      scores: {
        responses: 0.666667,
        evidence: 1,
        agreement: 1,
        conflict_resolution: 0,
        evidence_quality: 1,
        convergence: 0,
      },
      aggregate: 0.633333,
      rank: 1,
    },
    {
      option: "Zeta",
      scores: {
        responses: 0.333333,
        evidence: 0,
        agreement: 1,
        conflict_resolution: 0,
        evidence_quality: 1,
        convergence: 0,
      },
      aggregate: 0.466667,
      rank: 2,
    },
  ]);
});

test("Turkish I variants use host-locale-independent debate keys", () => {
  expect(normalizeDebateOption("I")).toEqual({ option: "I", key: "i" });
  expect(normalizeDebateOption("İ")).toEqual({ option: "İ", key: "i\u0307" });
  expect(normalizeDebateOption("ı")).toEqual({ option: "ı", key: "ı" });
  expect(normalizeDebateOption("i")).toEqual({ option: "i", key: "i" });
});

test("zero evidence population and not_applicable convergence produce bounded zero scores", () => {
  const matrix = projectDecisionMatrix(
    completedRound(
      1,
      "r1",
      [{ participant: "p1", claim: "option" }],
      assessment([false, false, false, "not_applicable"]),
    ),
  );
  expect(matrix?.rows[0]).toMatchObject({
    scores: {
      responses: 1,
      evidence: 0,
      agreement: 0,
      conflict_resolution: 0,
      evidence_quality: 0,
      convergence: 0,
    },
    aggregate: 0.2,
  });
  for (const row of rows(matrix)) {
    expect(row.aggregate).toBeGreaterThanOrEqual(0);
    expect(row.aggregate).toBeLessThanOrEqual(1);
    for (const score of Object.values(row.scores)) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  }
});

test("all full assessments in completed rounds contribute exact applicable gate ratios", () => {
  const records = [
    ...completedRound(
      1,
      "r1",
      [{ participant: "p1", claim: "option" }],
      assessment([true, false, true, "not_applicable"]),
    ),
    ...completedRound(
      6,
      "r2",
      [{ participant: "p1", claim: "option" }],
      assessment([false, true, true, true]),
    ),
  ];
  expect(projectDecisionMatrix(records)?.rows[0]?.scores).toEqual({
    responses: 1,
    evidence: 0,
    agreement: 0.5,
    conflict_resolution: 0.5,
    evidence_quality: 1,
    convergence: 1,
  });
});

test("aggregate uses exact rational arithmetic and decimal half-up rounding at six places", () => {
  const responses = Array.from({ length: 128 }, (_, index) => ({
    participant: `p${index}`,
    claim: index === 0 ? "first" : `option-${index}`,
  }));
  const matrix = projectDecisionMatrix(
    completedRound(1, "r1", responses, assessment([false, false, false, false])),
  );
  const first = matrix?.rows.find((row) => row.option === "first");
  expect(first?.scores.responses).toBe(0.007813);
  expect(first?.aggregate).toBe(0.001563);
});

test("ties use raw response count, then Unicode code-point order rather than UTF-16 order", () => {
  const rawCountTie = projectDecisionMatrix(
    completedRound(
      1,
      "r1",
      [
        { participant: "p1", claim: "A", evidence: ["a"] },
        { participant: "p2", claim: "A", evidence: [] },
        { participant: "p3", claim: "B", evidence: ["1", "2", "3", "4", "5"] },
      ],
      assessment([false, false, false, false]),
    ),
  );
  expect(rawCountTie?.rows.map(({ option, aggregate }) => [option, aggregate])).toEqual([
    ["A", 0.15],
    ["B", 0.15],
  ]);

  const codePointTie = projectDecisionMatrix(
    completedRound(
      1,
      "r1",
      [
        { participant: "p1", claim: "😀" },
        { participant: "p2", claim: "\ue000" },
      ],
      assessment([false, false, false, false]),
    ),
  );
  expect(codePointTie?.rows.map((row) => row.option)).toEqual(["", "😀"]);
});

test("generated_at is the highest timestamp consumed from completed-round semantics", () => {
  const records = completedRound(1, "r1", [{ participant: "p1", claim: "answer" }]);
  records[1] = stored(2, records[1]?.event as TraceEvent, "2026-08-22T02:00:00.000Z");
  records.push(
    stored(
      7,
      {
        type: "baseline_result",
        payload: {
          status: "success",
          answer: "unrelated",
          confidence: null,
          skip_reason: null,
        },
      },
      "2026-08-22T09:00:00.000Z",
    ),
    stored(
      8,
      {
        type: "round_boundary",
        payload: { round_id: "incomplete", phase: "start" },
      },
      "2026-08-22T10:00:00.000Z",
    ),
  );
  expect(projectDecisionMatrix(records)?.generated_at).toBe("2026-08-22T02:00:00.000Z");
});

test("byte-equivalent replay produces byte-equivalent projection", () => {
  const records = completedRound(1, "r1", [
    { participant: "p1", claim: "Alpha", evidence: ["one"] },
    { participant: "p2", claim: "Beta", evidence: ["two"] },
  ]);
  const first = JSON.stringify(projectDecisionMatrix(records));
  const replay = JSON.stringify(projectDecisionMatrix(structuredClone(records)));
  expect(replay).toBe(first);
});
