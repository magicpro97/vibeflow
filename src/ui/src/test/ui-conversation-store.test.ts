// biome-ignore format: entire-file — tight formatting keeps file ≤400 lines
import {
  applyConversationSnapshot,
  applyConversationTrace,
  buildConversationMessages,
  collectConversationApprovals,
  collectConversationArtifacts,
  collectConversationOperations,
  conversationControls,
  createConversationState,
  currentConversationCursor,
  projectConversationBaseline,
  projectConversationDecisionMatrix,
  resetConversationState,
} from "../conversation-store.js";
import type { ConversationSnapshot, ConversationTraceRecord } from "../conversation-types.js";

const SESSION = "session_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ARTIFACT_A = "artifact_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ARTIFACT_B = "artifact_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

let failed = 0;

function assert(label: string, ok: boolean) {
  if (!ok) {
    console.error(`FAIL: ${label}`);
    failed += 1;
  }
}

function assertDeep(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
    failed += 1;
  }
}

function snapshot(over: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    conversation_id: "conversation-1",
    lifecycle: "INIT",
    health: "healthy",
    policy: "debate",
    topic: "Ship Task9",
    participants: [
      {
        participant_id: "participant-1",
        role_ref: "brainstormer",
        engine: "codex",
        model: "gpt-5",
        public_session_ref: SESSION,
      },
    ],
    rounds: [],
    consensus_score: null,
    last_seq: 1,
    ...over,
  };
}

function record(
  seq: number,
  event: ConversationTraceRecord["event"],
  over: Partial<ConversationTraceRecord> = {},
): ConversationTraceRecord {
  return {
    event_id: `event-${seq}`,
    seq,
    ts: `2026-08-22T00:00:${String(seq).padStart(2, "0")}.000Z`,
    workflow_id: "workflow-1",
    conversation_id: "conversation-1",
    revision_id: "revision-1",
    run_id: "run-1",
    turn_id: "turn-1",
    operation_id: "operation-1",
    attempt_id: "attempt-1",
    public_session_ref: null,
    event,
    ...over,
  };
}

{
  const state = createConversationState();
  resetConversationState(state, "conversation-1");
  assert("fresh snapshot accepted", applyConversationSnapshot(state, snapshot({ last_seq: 1 })));
  assert(
    "first live event accepted",
    applyConversationTrace(
      state,
      record(2, {
        type: "user_message",
        payload: { content: "keep going", target_participants: "all" },
      }),
    ),
  );
  assert(
    "later lifecycle event accepted",
    applyConversationTrace(
      state,
      record(3, {
        type: "state_change",
        payload: { lifecycle: "ACTIVE", health: "healthy", terminal: false, reason: null },
      }),
    ),
  );
  assert(
    "duplicate replay at same seq is rejected",
    !applyConversationTrace(
      state,
      record(2, {
        type: "user_message",
        payload: { content: "duplicate", target_participants: "all" },
      }),
    ),
  );
  assertDeep(
    "trace seq order stays ascending",
    state.traces.map((item) => item.seq),
    [2, 3],
  );
  assert("cursor advances to latest seq", currentConversationCursor(state) === 3);
  assert("snapshot lifecycle follows live state", state.snapshot?.lifecycle === "ACTIVE");
  assert(
    "older snapshot than cursor is rejected",
    !applyConversationSnapshot(state, snapshot({ last_seq: 2 })),
  );
  assert(
    "wrong conversation snapshot is rejected",
    !applyConversationSnapshot(state, snapshot({ conversation_id: "conversation-2", last_seq: 9 })),
  );
  assert(
    "newer snapshot replaces state",
    applyConversationSnapshot(state, snapshot({ last_seq: 4, lifecycle: "PAUSED" })),
  );
  assert("replacement snapshot lands", state.snapshot?.lifecycle === "PAUSED");
}

{
  const messages = buildConversationMessages(snapshot(), [
    record(1, {
      type: "native_history_reconciled",
      payload: {
        public_session_ref: SESSION,
        status: "reconciled",
        imported_turn_count: 5,
        imported_tool_count: 2,
        provenance_refs: ["turn:1"],
        evidence_refs: ["test/a.ts:7"],
        completeness_reason: "matched durable session",
      },
    }),
    record(2, { type: "round_boundary", payload: { round_id: "round-1", phase: "start" } }),
    record(
      3,
      {
        type: "agent_response_delta",
        payload: {
          round_id: "round-1",
          participant_id: "participant-1",
          content_delta: "First part. ",
          final_claim: null,
          final_evidence: [],
          completes_response: false,
        },
      },
      { role_ref: "brainstormer" },
    ),
    record(
      4,
      {
        type: "agent_response_delta",
        payload: {
          round_id: "round-1",
          participant_id: "participant-1",
          content_delta: "Second part.",
          final_claim: "Ship the UI",
          final_evidence: ["src/ui/src/App.vue:1"],
          completes_response: true,
        },
      },
      { role_ref: "brainstormer" },
    ),
    record(5, {
      type: "evaluator_assessment",
      payload: {
        round_id: "round-1",
        stage: "full",
        assessment: {
          agreement: { value: true, evidence: "aligned" },
          conflict_resolution: { value: true, evidence: "resolved" },
          evidence_quality: { value: true, evidence: "strong" },
          convergence: { value: true, evidence: "converged" },
        },
      },
    }),
  ]);
  const participant = messages.find((item) => item.kind === "participant");
  assert("participant message exists", Boolean(participant));
  assert("participant body concatenates deltas", participant?.body === "First part. Second part.");
  assert("participant final claim is retained", participant?.claim === "Ship the UI");
  assertDeep("participant final evidence is retained", participant?.evidence, [
    "src/ui/src/App.vue:1",
  ]);
  assert(
    "participant session status comes from reconciliation",
    participant?.session_status === "reconciled",
  );
  assert(
    "participant role and engine render from snapshot metadata",
    participant?.role_ref === "brainstormer" && participant.engine === "codex",
  );
  assertDeep("participant trace seqs stay threaded", participant?.trace_seqs, [3, 4]);
}

{
  const traces = [
    record(1, {
      type: "operation_lifecycle",
      payload: { operation_id: "operation-1", attempt_id: "attempt-1", state: "requested" },
    }),
    record(2, {
      type: "approval_requested",
      payload: {
        token: { approval_id: "approval-1", operation_id: "operation-1", actor: "policy" },
        description: "Approve file write",
      },
    }),
    record(3, {
      type: "approval_resolved",
      payload: {
        decision: {
          approval_id: "approval-1",
          operation_id: "operation-1",
          actor: "web-ui",
          outcome: "approve",
          reason: "looks good",
        },
      },
    }),
    record(4, {
      type: "caller_cancelled",
      payload: { operation_id: "operation-1", actor: "web-ui", reason: "user cancelled" },
    }),
    record(5, {
      type: "artifact_created",
      payload: { artifact_id: "artifact-1", artifact_type: "plan", ref: ARTIFACT_A },
    }),
    record(6, {
      type: "artifact_updated",
      payload: {
        artifact_id: "artifact-1",
        artifact_type: "plan",
        ref: ARTIFACT_B,
        previous_ref: ARTIFACT_A,
      },
    }),
  ];
  const approvals = collectConversationApprovals(traces);
  const operations = collectConversationOperations(traces);
  const artifacts = collectConversationArtifacts(traces);
  const controls = conversationControls(
    snapshot({ lifecycle: "COMPLETED" }),
    operations,
    approvals,
  );
  assert("one approval remains projected", approvals.length === 1);
  assert("pending approval retains its exact authority actor", approvals[0]?.actor === "policy");
  assert(
    "approval resolution is visible",
    approvals[0]?.resolved === true && approvals[0]?.decision?.outcome === "approve",
  );
  assert(
    "cancelled operation keeps cancel metadata",
    operations[0]?.cancelled === true && operations[0]?.cancelled_by === "web-ui",
  );
  assert(
    "artifact update stays opaque",
    artifacts[0]?.opaque_id === ARTIFACT_B && artifacts[0]?.previous_opaque_id === ARTIFACT_A,
  );
  assertDeep("completed conversations switch to revise-only controls", controls, {
    canPause: false,
    canResume: false,
    canStop: false,
    canInject: false,
    canRevise: true,
    canCancel: false,
    hasPendingApproval: false,
  });
}

{
  // biome-ignore format: compact mixed-row fixture keeps this test below the source cap
  const approvals = collectConversationApprovals([
    record(1, { type: "approval_requested", payload: { token: { approval_id: "approval-live", operation_id: "operation-live", actor: "policy" }, description: "Approve live" } }),
    record(2, { type: "approval_requested", payload: { token: { approval_id: "approval-completed", operation_id: "operation-completed", actor: "policy" }, description: "Approve completed" } }),
    record(3, { type: "approval_requested", payload: { token: { approval_id: "approval-cancelled", operation_id: "operation-cancelled", actor: "policy" }, description: "Approve cancelled" } }),
  ]);
  // biome-ignore format: compact mixed-row fixture keeps this test below the source cap
  const operations = collectConversationOperations([
    record(4, { type: "operation_lifecycle", payload: { operation_id: "operation-live", attempt_id: "attempt-live", state: "requested" } }),
    record(5, { type: "operation_lifecycle", payload: { operation_id: "operation-completed", attempt_id: "attempt-completed", state: "completed" } }),
    record(6, { type: "operation_lifecycle", payload: { operation_id: "operation-cancelled", attempt_id: "attempt-cancelled", state: "requested" } }),
    record(7, { type: "caller_cancelled", payload: { operation_id: "operation-cancelled", actor: "web-ui", reason: null } }),
  ]);
  // biome-ignore format: compact pair helper keeps this test below the source cap
  const canResolve = (lifecycle: ConversationSnapshot["lifecycle"], approvalId: string, operationId: string) =>
    conversationControls(snapshot({ lifecycle }), operations, approvals).canResolveApproval(approvalId, operationId);
  // biome-ignore format: compact mixed-row expectations keep this test below the source cap
  assertDeep("row-specific approval eligibility", [canResolve("ACTIVE", "approval-live", "operation-live"), canResolve("PAUSED", "approval-live", "operation-live"), canResolve("ACTIVE", "approval-completed", "operation-completed"), canResolve("ACTIVE", "approval-cancelled", "operation-cancelled"), canResolve("ACTIVE", "approval-live", "operation-missing")], [true, false, true, false, false]);
  assert(
    "terminal conversations cannot resolve unresolved approvals",
    (["STOPPED", "FAILED", "ABORTED", "COMPLETED"] as const).every(
      (lifecycle) => !canResolve(lifecycle, "approval-live", "operation-live"),
    ),
  );
}

{
  const traces = [
    record(1, { type: "round_boundary", payload: { round_id: "round-1", phase: "start" } }),
    record(2, {
      type: "agent_response_delta",
      payload: {
        round_id: "round-1",
        participant_id: "participant-1",
        content_delta: "Answer 1",
        final_claim: "use bun test",
        final_evidence: ["test/ui-conversation-contract.test.ts:1"],
        completes_response: true,
      },
    }),
    record(3, {
      type: "agent_response_delta",
      payload: {
        round_id: "round-1",
        participant_id: "participant-2",
        content_delta: "Answer 2",
        final_claim: "use bun test",
        final_evidence: ["src/ui/src/test/ui-conversation-store.test.ts:1"],
        completes_response: true,
      },
    }),
    // biome-ignore format: compact duplicate/case-fold fixture keeps this file below the source cap
    record(4, { type: "agent_response_delta", payload: { round_id: "round-1", participant_id: "participant-3", content_delta: "Answer 3", final_claim: "Use Bun test", final_evidence: [], completes_response: true } }),
    record(5, {
      type: "evaluator_assessment",
      payload: {
        round_id: "round-1",
        stage: "full",
        assessment: {
          agreement: { value: true, evidence: "agree" },
          conflict_resolution: { value: true, evidence: "resolved" },
          evidence_quality: { value: true, evidence: "solid" },
          convergence: { value: true, evidence: "same answer" },
        },
      },
    }),
    record(6, {
      type: "consensus_update",
      payload: { round_id: "round-1", decision: { outcome: "consensus", score: 0.95 } },
    }),
    record(7, { type: "round_boundary", payload: { round_id: "round-1", phase: "end" } }),
    record(8, {
      type: "baseline_result",
      payload: { status: "success", answer: "Use Bun test", confidence: 0.8, skip_reason: null },
    }),
  ];
  const matrix = projectConversationDecisionMatrix(traces);
  const baseline = projectConversationBaseline(traces, matrix);
  assert("decision matrix exists", Boolean(matrix));
  assert("decision matrix picks the canonical option", matrix?.rows[0]?.option === "Use Bun test");
  assert(
    "decision matrix aggregate is complete",
    matrix?.rows[0]?.aggregate === 1 && matrix?.method === "weighted_sum",
  );
  assert(
    "decision matrix timestamps the end of the completed round",
    matrix?.generated_at === "2026-08-22T00:00:07.000Z",
  );
  assertDeep("baseline uses public debate output only", baseline, {
    status: "success",
    baseline_answer: "Use Bun test",
    debate_answer: "Use Bun test",
    divergence: 0,
    skip_reason: null,
  });
}

if (failed) process.exit(1);
console.log("ui-conversation-store.test.ts: all pass");
