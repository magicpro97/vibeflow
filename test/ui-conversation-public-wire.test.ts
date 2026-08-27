import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONVERSATION_ARTIFACT_TYPE,
  CONVERSATION_ARTIFACT_TYPES,
  CONVERSATION_TRACE_EVENT_KINDS,
} from "../src/orchestrator/conversation/conversation-public-wire-contract.js";
import type {
  ConversationArtifactTypeV1,
  SameUnion,
} from "../src/orchestrator/conversation/conversation-public-wire-contract.js";
import type {
  PublicTraceEvent,
  TraceCorrelation,
  TraceEvent,
} from "../src/orchestrator/trace/types.js";
import {
  TRACE_EVENT_PAYLOAD_SCHEMAS as BACKEND_TRACE_EVENT_PAYLOAD_SCHEMAS,
  validInput,
} from "../src/orchestrator/trace/validation.js";
import {
  parseConversationSseRecord,
  parseConversationSseSnapshot,
} from "../src/ui/src/conversation-api.js";
import {
  CONVERSATION_TRACE_EVENT_PAYLOAD_SCHEMAS,
  CONVERSATION_TRACE_EVENT_TYPES,
  isConversationPublicTraceRecordWireV1,
  isConversationSnapshotWireV1,
} from "../src/ui/src/conversation-public-wire.js";
import {
  applyConversationSnapshot,
  applyConversationTrace,
  createConversationState,
  resetConversationState,
} from "../src/ui/src/conversation-store.js";
import {
  acceptConversationSnapshotFrame,
  acceptConversationTraceFrame,
} from "../src/ui/src/conversation-stream-boundary.js";
import type {
  ConversationSnapshot,
  ConversationTraceEvent,
  ConversationTraceRecord,
} from "../src/ui/src/conversation-types.js";

type UiArtifactUpdate = Extract<ConversationTraceEvent, { type: "artifact_updated" }>;
type PublicArtifactUpdate = Extract<PublicTraceEvent, { type: "artifact_updated" }>;
type BackendArtifactUpdate = Extract<TraceEvent, { type: "artifact_updated" }>;
const ARTIFACT_TYPE_PARITY = [
  true satisfies SameUnion<
    UiArtifactUpdate["payload"]["artifact_type"],
    ConversationArtifactTypeV1
  >,
  true satisfies SameUnion<
    PublicArtifactUpdate["payload"]["artifact_type"],
    ConversationArtifactTypeV1
  >,
  true satisfies SameUnion<
    BackendArtifactUpdate["payload"]["artifact_type"],
    ConversationArtifactTypeV1
  >,
];

const snapshot = (): ConversationSnapshot => ({
  conversation_id: "conversation-a",
  lifecycle: "ACTIVE",
  health: "healthy",
  policy: "direct",
  topic: "Validate public boundaries",
  participants: [
    {
      participant_id: "participant-a",
      role_ref: "direct",
      engine: "codex",
      model: "gpt-5.4",
      public_session_ref: null,
    },
  ],
  rounds: [],
  consensus_score: null,
  last_seq: 1,
});

const trace = (): ConversationTraceRecord => ({
  workflow_id: "workflow-a",
  conversation_id: "conversation-a",
  revision_id: "revision-a",
  run_id: "run-a",
  turn_id: "turn-a",
  operation_id: "operation-a",
  attempt_id: "attempt-a",
  event_id: "event-a",
  seq: 2,
  ts: "2026-08-26T00:00:00.000Z",
  public_session_ref: null,
  event: {
    type: "user_message",
    payload: { content: "Continue", target_participants: "all" },
  },
});

const unknownTrace = () => ({
  ...trace(),
  event: { type: "future_event", payload: {} },
});

const quoteReference = () => ({
  root_session_id: "root-session-a",
  conversation_id: "conversation-a",
  revision_id: "revision-a",
  target_event_id: "event-target-a",
  target_kind: "user-message" as const,
  content_digest: `sha256:${"a".repeat(64)}`,
  author_public_id: "human",
});

const traceWithEvent = (event: unknown) => ({ ...trace(), event });

const producerAccepts = (event: unknown) => {
  const correlation: TraceCorrelation = {
    workflow_id: "workflow-a",
    conversation_id: "conversation-a",
    revision_id: "revision-a",
    run_id: "run-a",
    turn_id: "turn-a",
    operation_id: "operation-a",
    attempt_id: "attempt-a",
  };
  return validInput(
    correlation,
    { idempotency_key: "trace-public-wire-parity", event: event as TraceEvent },
    null,
  );
};

describe("browser-safe conversation public wire", () => {
  test("keeps one frozen, compile-time-total trace event schema authority", () => {
    expect(Object.isFrozen(CONVERSATION_TRACE_EVENT_PAYLOAD_SCHEMAS)).toBeTrue();
    expect(Object.isFrozen(CONVERSATION_TRACE_EVENT_TYPES)).toBeTrue();
    expect(CONVERSATION_TRACE_EVENT_TYPES.map(String)).toEqual(
      Object.keys(CONVERSATION_TRACE_EVENT_PAYLOAD_SCHEMAS),
    );
    expect(CONVERSATION_TRACE_EVENT_TYPES).toBe(CONVERSATION_TRACE_EVENT_KINDS);
    expect(CONVERSATION_TRACE_EVENT_PAYLOAD_SCHEMAS).toBe(BACKEND_TRACE_EVENT_PAYLOAD_SCHEMAS);
    expect(ARTIFACT_TYPE_PARITY).toEqual([true, true, true]);
    for (const type of ["synthesis_completed", "artifact_created", "artifact_updated"] as const)
      expect(CONVERSATION_TRACE_EVENT_PAYLOAD_SCHEMAS[type]).toBe(
        BACKEND_TRACE_EVENT_PAYLOAD_SCHEMAS[type],
      );
    for (const path of [
      "../src/orchestrator/conversation/conversation-public-wire-contract.ts",
      "../src/ui/src/conversation-public-wire.ts",
    ]) {
      const source = readFileSync(resolve(import.meta.dir, path), "utf8");
      expect(source).not.toMatch(/(?:node:|\bBuffer\b|\bprocess\b)/);
      expect(source).not.toContain("durability");
    }
  });

  test("keeps producer and browser numeric domains identical for all bounded events", () => {
    const configured = (max_rounds: number) => ({
      type: "conversation_configured",
      payload: { topic: "Parity", participants: [], policy: "direct", max_rounds },
    });
    const baseline = (confidence: number | null) => ({
      type: "baseline_result",
      payload: { status: "success", answer: "Ship", confidence, skip_reason: null },
    });
    const terminal = (final_score: number | null) => ({
      type: "conversation_terminal",
      payload: { lifecycle: "COMPLETED", terminal: true, final_score },
    });
    const decision = (score: number) => ({
      type: "consensus_update",
      payload: { round_id: "round-a", decision: { outcome: "continue", score } },
    });
    const reconciled = (imported_turn_count: number, imported_tool_count: number) => ({
      type: "native_history_reconciled",
      payload: {
        public_session_ref: "public-session-a",
        status: "reconciled",
        imported_turn_count,
        imported_tool_count,
        provenance_refs: [],
        evidence_refs: [],
        completeness_reason: "complete",
      },
    });
    const cases: ReadonlyArray<readonly [string, unknown, boolean]> = [
      ["configured minimum", configured(1), true],
      ["configured maximum", configured(Number.MAX_SAFE_INTEGER), true],
      ["configured zero", configured(0), false],
      ["configured fractional", configured(1.5), false],
      ["configured unsafe", configured(Number.MAX_SAFE_INTEGER + 1), false],
      ["baseline null", baseline(null), true],
      ["baseline lower bound", baseline(0), true],
      ["baseline upper bound", baseline(1), true],
      ["baseline negative zero", baseline(-0), false],
      ["baseline below range", baseline(-0.01), false],
      ["baseline above range", baseline(1.01), false],
      ["terminal null", terminal(null), true],
      ["terminal lower bound", terminal(0), true],
      ["terminal upper bound", terminal(1), true],
      ["terminal negative zero", terminal(-0), false],
      ["terminal below range", terminal(-0.01), false],
      ["terminal above range", terminal(1.01), false],
      ["decision score lower bound", decision(0), true],
      ["decision score upper bound", decision(1), true],
      ["decision score negative zero", decision(-0), false],
      ["decision score above range", decision(2), false],
      ["reconciled zero counts", reconciled(0, 0), true],
      ["reconciled maximum counts", reconciled(Number.MAX_SAFE_INTEGER, 1), true],
      ["reconciled negative turn count", reconciled(-1, 0), false],
      ["reconciled negative-zero tool count", reconciled(0, -0), false],
      ["reconciled fractional turn count", reconciled(0.5, 0), false],
      ["reconciled unsafe tool count", reconciled(0, Number.MAX_SAFE_INTEGER + 1), false],
    ];

    for (const [label, event, accepted] of cases) {
      expect(producerAccepts(event), `${label}: producer`).toBe(accepted);
      expect(
        isConversationPublicTraceRecordWireV1(traceWithEvent(event)),
        `${label}: browser`,
      ).toBe(accepted);
      if (accepted) {
        const emitted = { ...trace(), event: event as ConversationTraceEvent };
        expect(
          parseConversationSseRecord(JSON.stringify(emitted)),
          `${label}: serialized producer event`,
        ).toEqual(emitted);
      }
    }
  });

  test("rejects unknown trace variants and malformed exact payloads", () => {
    expect(isConversationPublicTraceRecordWireV1(trace())).toBeTrue();
    expect(isConversationPublicTraceRecordWireV1(unknownTrace())).toBeFalse();
    const invalidBaselineReason = {
      type: "baseline_result",
      payload: {
        status: "failed",
        answer: null,
        confidence: null,
        skip_reason: "future_baseline_reason",
      },
    };
    expect(producerAccepts(invalidBaselineReason)).toBeFalse();
    expect(
      isConversationPublicTraceRecordWireV1(traceWithEvent(invalidBaselineReason)),
    ).toBeFalse();
    expect(
      isConversationPublicTraceRecordWireV1({
        ...trace(),
        unexpected_field: true,
      }),
    ).toBeFalse();
    expect(
      isConversationPublicTraceRecordWireV1({
        ...trace(),
        event: {
          type: "user_message",
          payload: { content: "Continue", target_participants: "all", unexpected_field: true },
        },
      }),
    ).toBeFalse();
    expect(() => parseConversationSseRecord(JSON.stringify(unknownTrace()))).toThrow(
      "conversation trace event was invalid",
    );
    const compactionEvent = {
      type: "artifact_created",
      payload: {
        artifact_id: "artifact-a",
        artifact_type: CONVERSATION_ARTIFACT_TYPE.COMPACTION,
        ref: "artifact_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    } satisfies ConversationTraceRecord["event"];
    expect(CONVERSATION_ARTIFACT_TYPES).toContain(compactionEvent.payload.artifact_type);
    expect(
      isConversationPublicTraceRecordWireV1({ ...trace(), event: compactionEvent }),
    ).toBeTrue();
  });

  test("rejects malformed lifecycle, participant, sequence, and extra snapshot fields", () => {
    expect(isConversationSnapshotWireV1(snapshot())).toBeTrue();
    for (const malformed of [
      { ...snapshot(), lifecycle: "FUTURE" },
      { ...snapshot(), participants: [{ participant_id: 7 }] },
      { ...snapshot(), last_seq: "1" },
      { ...snapshot(), last_seq: -1 },
      { ...snapshot(), unexpected_field: true },
    ]) {
      expect(isConversationSnapshotWireV1(malformed)).toBeFalse();
      expect(() =>
        parseConversationSseSnapshot(JSON.stringify(malformed), "conversation-a"),
      ).toThrow("conversation response was invalid");
    }
    expect(() =>
      parseConversationSseSnapshot(JSON.stringify(snapshot()), "conversation-b"),
    ).toThrow("conversation response was invalid");
  });

  test("requires closed artifact types and non-null public artifact references", () => {
    const synthesis = {
      type: "synthesis_completed",
      payload: { decision_matrix_ref: "artifact-matrix", baseline_comparison_ref: "artifact-base" },
    };
    const created = {
      type: "artifact_created",
      payload: { artifact_id: "artifact-a", artifact_type: "plan", ref: "artifact-plan" },
    };
    const updated = {
      type: "artifact_updated",
      payload: {
        artifact_id: "artifact-a",
        artifact_type: "plan",
        ref: "artifact-plan-v2",
        previous_ref: "artifact-plan",
      },
    };
    for (const event of [synthesis, created, updated])
      expect(isConversationPublicTraceRecordWireV1(traceWithEvent(event))).toBeTrue();
    for (const event of [
      { ...synthesis, payload: { ...synthesis.payload, decision_matrix_ref: null } },
      { ...created, payload: { ...created.payload, ref: null } },
      { ...updated, payload: { ...updated.payload, artifact_type: "anything" } },
      { ...updated, payload: { ...updated.payload, ref: null } },
      { ...updated, payload: { ...updated.payload, previous_ref: null } },
      { ...updated, payload: { ...updated.payload, unexpected_field: true } },
    ])
      expect(isConversationPublicTraceRecordWireV1(traceWithEvent(event))).toBeFalse();
  });

  test("requires exact dense canonical quote-reference arrays", () => {
    const valid = [quoteReference()];
    const sparse = new Array(1);
    const foreignPrototype = [quoteReference()];
    Object.setPrototypeOf(foreignPrototype, null);
    const arrayWithExtra = [quoteReference()] as Array<ReturnType<typeof quoteReference>> & {
      unexpected_field?: true;
    };
    arrayWithExtra.unexpected_field = true;
    const malformed = [
      sparse,
      foreignPrototype,
      arrayWithExtra,
      [{ ...quoteReference(), unexpected_field: true }],
    ];
    const event = (quote_refs: unknown) => ({
      type: "user_message",
      payload: { content: "Continue", target_participants: "all", quote_refs },
    });
    expect(isConversationPublicTraceRecordWireV1(traceWithEvent(event(valid)))).toBeTrue();
    for (const quoteRefs of malformed)
      expect(isConversationPublicTraceRecordWireV1(traceWithEvent(event(quoteRefs)))).toBeFalse();
  });

  test("stream boundary separates valid replay frames from store adoption", () => {
    const state = createConversationState();
    resetConversationState(state, "conversation-a");
    expect(applyConversationSnapshot(state, snapshot())).toBeTrue();
    expect(
      applyConversationSnapshot(state, {
        ...snapshot(),
        lifecycle: "FUTURE",
        last_seq: 9,
      } as unknown as ConversationSnapshot),
    ).toBeFalse();
    expect(
      applyConversationTrace(state, unknownTrace() as unknown as ConversationTraceRecord),
    ).toBeFalse();
    expect(state.snapshot?.lifecycle).toBe("ACTIVE");
    expect(state.cursor).toBe(0);
    expect(state.traces).toEqual([]);

    let adopted = 0;
    expect(
      acceptConversationSnapshotFrame(
        JSON.stringify({ ...snapshot(), participants: null }),
        "conversation-a",
        () => {
          adopted += 1;
          return true;
        },
      ),
    ).toBeFalse();
    expect(
      acceptConversationTraceFrame(JSON.stringify(unknownTrace()), "conversation-a", () => {
        adopted += 1;
        return true;
      }),
    ).toBeFalse();
    expect(adopted).toBe(0);
    expect(
      acceptConversationSnapshotFrame(JSON.stringify(snapshot()), "conversation-a", () => false),
    ).toBeTrue();
    expect(
      acceptConversationTraceFrame(JSON.stringify(trace()), "conversation-a", () => false),
    ).toBeTrue();
  });
});
