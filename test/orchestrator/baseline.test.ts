import { expect, test } from "bun:test";
import {
  computeTokenSetDivergence,
  projectBaselineComparison,
} from "../../src/orchestrator/conversation/baseline.js";
import {
  CONVERSATION_BASELINE_FAILURE_REASON,
  CONVERSATION_BASELINE_SKIP_REASON,
  CONVERSATION_BASELINE_STATUS,
  CONVERSATION_TRACE_EVENT_KIND,
  type ConversationBaselineReasonV1,
  type ConversationBaselineStatusV1,
} from "../../src/orchestrator/conversation/conversation-public-wire-contract.js";
import type { DecisionMatrix } from "../../src/orchestrator/conversation/debate-projection.js";
import type { StoredTraceEvent, TraceEvent } from "../../src/orchestrator/trace/types.js";

const matrix = (option = "Debate answer"): DecisionMatrix => ({
  method: "weighted_sum",
  generated_at: "2026-08-22T00:00:00.000Z",
  rows: [
    {
      option,
      scores: {
        responses: 1,
        evidence: 0,
        agreement: 1,
        conflict_resolution: 1,
        evidence_quality: 1,
        convergence: 1,
      },
      aggregate: 0.9,
      rank: 1,
    },
  ],
});

const stored = (seq: number, event: TraceEvent): StoredTraceEvent => ({
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
  idempotency_key: `key-${seq}`,
  event,
});

const baseline = (
  status: ConversationBaselineStatusV1,
  answer: string | null,
  reason: ConversationBaselineReasonV1 | null,
) =>
  stored(1, {
    type: CONVERSATION_TRACE_EVENT_KIND.BASELINE_RESULT,
    payload: { status, answer, confidence: null, skip_reason: reason },
  });

const project = (overrides: Partial<Parameters<typeof projectBaselineComparison>[0]> = {}) =>
  projectBaselineComparison({
    enabled: true,
    nonEvaluatorParticipantCount: 2,
    selectedEngineAvailable: true,
    decisionMatrix: matrix(),
    records: [baseline("success", "Debate answer", null)],
    ...overrides,
  });

test("baseline skip precedence is disabled, single participant, then engine unavailable", () => {
  expect(
    project({
      enabled: false,
      nonEvaluatorParticipantCount: 1,
      selectedEngineAvailable: false,
      decisionMatrix: null,
      records: [],
    }),
  ).toEqual({
    status: "skipped",
    baseline_answer: null,
    debate_answer: null,
    divergence: null,
    skip_reason: CONVERSATION_BASELINE_SKIP_REASON.DISABLED,
  });
  expect(
    project({
      nonEvaluatorParticipantCount: 1,
      selectedEngineAvailable: false,
      records: [],
    }).skip_reason,
  ).toBe(CONVERSATION_BASELINE_SKIP_REASON.SINGLE_PARTICIPANT);
  expect(project({ selectedEngineAvailable: false, records: [] }).skip_reason).toBe(
    CONVERSATION_BASELINE_SKIP_REASON.ENGINE_UNAVAILABLE,
  );
});

test("no completed debate answer wins over baseline missing or persisted results", () => {
  expect(project({ decisionMatrix: null, records: [] })).toEqual({
    status: "failed",
    baseline_answer: null,
    debate_answer: null,
    divergence: null,
    skip_reason: CONVERSATION_BASELINE_FAILURE_REASON.NO_DEBATE_ANSWER,
  });
  expect(
    project({
      decisionMatrix: null,
      records: [baseline("success", "orphan baseline", null)],
    }).skip_reason,
  ).toBe(CONVERSATION_BASELINE_FAILURE_REASON.NO_DEBATE_ANSWER);
});

test("missing and failed persisted baseline results preserve frozen failure reasons", () => {
  expect(project({ records: [] })).toEqual({
    status: "failed",
    baseline_answer: null,
    debate_answer: "Debate answer",
    divergence: null,
    skip_reason: CONVERSATION_BASELINE_FAILURE_REASON.BASELINE_MISSING,
  });
  expect(
    project({
      records: [
        baseline(
          CONVERSATION_BASELINE_STATUS.FAILED,
          null,
          CONVERSATION_BASELINE_FAILURE_REASON.ENGINE_TIMEOUT,
        ),
      ],
    }),
  ).toEqual({
    status: "failed",
    baseline_answer: null,
    debate_answer: "Debate answer",
    divergence: null,
    skip_reason: CONVERSATION_BASELINE_FAILURE_REASON.ENGINE_TIMEOUT,
  });
  expect(project({ records: [baseline("failed", null, null)] }).skip_reason).toBeNull();
});

test("rank-1 option is the debate answer and a successful baseline computes token-set divergence", () => {
  const comparison = project({
    decisionMatrix: matrix("Alpha beta"),
    records: [baseline("success", "beta gamma", null)],
  });
  expect(comparison).toEqual({
    status: "success",
    baseline_answer: "beta gamma",
    debate_answer: "Alpha beta",
    divergence: 0.666667,
    skip_reason: null,
  });
});

test("divergence normalizes NFKC/case and handles empty token sets exactly", () => {
  expect(computeTokenSetDivergence("", "")).toBe(0);
  expect(computeTokenSetDivergence("---", "alpha")).toBe(1);
  expect(computeTokenSetDivergence("  ＡLPHA café ", "alpha CAFÉ")).toBe(0);
  expect(computeTokenSetDivergence("a b", "b c")).toBe(0.666667);
  expect(computeTokenSetDivergence("a a a", "a")).toBe(0);
});

test("only the latest persisted baseline event in journal order is projected deterministically", () => {
  const first = baseline(
    CONVERSATION_BASELINE_STATUS.FAILED,
    null,
    CONVERSATION_BASELINE_FAILURE_REASON.BASELINE_FAILED,
  );
  const second = {
    ...baseline("success", "Debate answer", null),
    event_id: "event-2",
    seq: 2,
    idempotency_key: "key-2",
  } as StoredTraceEvent;
  const input = { records: [first, second] };
  expect(project(input)).toEqual({
    status: "success",
    baseline_answer: "Debate answer",
    debate_answer: "Debate answer",
    divergence: 0,
    skip_reason: null,
  });
  expect(JSON.stringify(project(structuredClone(input)))).toBe(JSON.stringify(project(input)));
});
