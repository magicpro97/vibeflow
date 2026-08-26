import { describe, expect, test } from "bun:test";
import type {
  EngineSessionResult,
  InternalResumeBinding,
} from "../../src/dispatch/session-types.js";
import { digestV1 } from "../../src/durability/index.js";
import type { ConversationHomeAuthorities } from "../../src/orchestrator/conversation/conversation-home-authorities.js";
import { MAX_CANONICAL_HANDOFF_BYTES } from "../../src/orchestrator/conversation/handoff-limits.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "../../src/orchestrator/conversation/lineage-revision-operation.js";
import { executeRevisionRetry } from "../../src/orchestrator/conversation/revision-control-retry.js";
import { foldRevisionOperation } from "../../src/orchestrator/conversation/revision-fold.js";
import { classifyRevisionLaneRetryResult } from "../../src/orchestrator/conversation/revision-lane-retry-validation.js";
import {
  type ParticipantStartReceiptV1,
  materializeParticipantStartReceipt,
  participantStartAttemptKey,
} from "../../src/orchestrator/conversation/revision-participant-receipt.js";
import {
  type RevisionOperationEventV1,
  materializeRevisionEvent,
  materializeRevisionOperation,
  materializeRevisionPreparationPlan,
} from "../../src/orchestrator/conversation/revision-planner.js";
import { revisionQuiescenceReader } from "../../src/orchestrator/conversation/service-revision-quiescence.js";

const at = "2026-08-25T00:00:00.000Z";
const digest = (label: string) => digestV1("REVISION-RETRY-TEST\0v1\0", { label });
const operationId = `vf-operation-${"1".repeat(64)}`;
const retryId = `vf-operation-${"2".repeat(64)}`;

function operation(): RevisionOperationV1 {
  return materializeRevisionOperation({
    operation_id: operationId,
    proposal_id: `vf-proposal-${"3".repeat(64)}`,
    proposal_digest: digest("proposal"),
    approval_id: `vf-approval-${"4".repeat(64)}`,
    approval_digest: digest("approval"),
    plan_digest: digest("plan"),
    authority_epoch: 0,
    authority_head_digest: digest("authority"),
    root_session_id: "conversation-root",
    parent: {
      conversation_id: "conversation-root",
      revision_id: "revision-root",
      revision_ordinal: 0,
    },
    child: {
      conversation_id: "conversation-child",
      revision_id: "revision-child",
      revision_ordinal: 1,
    },
    expected_head_digest: digest("head"),
    expected_reservation_digest: null,
    expected_reservation_epoch: 0,
    revision_claim_epoch: 1,
    expected_parent_last_seq: 1,
    expected_parent_lock_digest: digest("lock"),
    permission_digest: digest("permission"),
    binding_set_digest: digest("bindings"),
    handoff_digest: digest("handoff"),
    handoff_selection_digest: digest("selection"),
    prompt_projection_digest: digest("prompt"),
    created_at: at,
  });
}

function plan(): RevisionPreparationPlanV1 {
  return materializeRevisionPreparationPlan({
    root_session_id: "conversation-root",
    parent: {
      conversation_id: "conversation-root",
      revision_id: "revision-root",
      revision_ordinal: 0,
    },
    expected_head_digest: digest("head"),
    expected_head_epoch: 0,
    expected_reservation_digest: null,
    expected_reservation_epoch: 0,
    expected_parent_last_seq: 1,
    expected_parent_lock_digest: digest("lock"),
    permission_digest: digest("permission"),
    revision_claim_epoch: 1,
    binding_delta_digest: digest("delta"),
    resulting_binding_set_digest: digest("bindings"),
    handoff_selection_plan_digest: digest("selection"),
    participant_starts: [
      {
        participant_id: "participant-1",
        engine: "codex",
        model: "gpt-5.4",
        adapter_fingerprint: "adapter-1",
        reconciliation_mode: "provider-idempotency",
        cancellation_mode: "idempotent-cancel",
        wrapper_descriptor_digest: digest("wrapper"),
        max_shared_prompt_bytes: 1024,
      },
    ],
    created_at: at,
    expires_at: "2026-08-25T01:00:00.000Z",
  });
}

function receipt(
  operation: RevisionOperationV1,
  state: ParticipantStartReceiptV1["state"],
  generation = 0,
): ParticipantStartReceiptV1 {
  const identity = {
    operation_id: operation.operation_id,
    participant_id: "participant-1",
    start_generation: generation,
  };
  return materializeParticipantStartReceipt({
    ...identity,
    attempt_key: participantStartAttemptKey(identity),
    state,
    engine: "codex",
    model: "gpt-5.4",
    adapter_fingerprint: "adapter-1",
    reconciliation_mode: "provider-idempotency",
    cancel_attempt_key: null,
    cancellation_mode: null,
    shared_prompt_digest: operation.prompt_projection_digest,
    wrapper_digest: digest("wrapper"),
    private_native_session_ref: null,
    private_native_session_producer_receipt_digest: null,
    private_process_lease_ref: null,
    private_process_lease_producer_receipt_digest: null,
    prepared_at: at,
    observed_at: null,
  });
}

function append(
  operation: RevisionOperationV1,
  events: RevisionOperationEventV1[],
  payload: RevisionOperationEventV1["payload"],
): void {
  events.push(materializeRevisionEvent(operation, events, payload, at));
}

function failedPrefix(operation: RevisionOperationV1): RevisionOperationEventV1[] {
  const events: RevisionOperationEventV1[] = [];
  for (const [from, to] of [
    ["created", "preparing"],
    ["preparing", "prepared"],
  ] as const)
    append(operation, events, {
      kind: "state-transition",
      from,
      to,
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [],
      reason_code: null,
    });
  append(operation, events, {
    kind: "head-commit",
    authorized_by_action_operation_id: operation.operation_id,
    effect_action_operation_id: operation.operation_id,
    prior_head_digest: operation.expected_head_digest,
    prior_head_checkpoint_digest: operation.expected_head_digest,
    committed_head_digest: digest("child-head"),
    directory_fsync_completed: true,
  });
  append(operation, events, {
    kind: "state-transition",
    from: "published",
    to: "starting",
    authorized_by_action_operation_id: operation.operation_id,
    effect_action_operation_id: operation.operation_id,
    action_terminals: [],
    reason_code: null,
  });
  for (const state of ["prepared", "effect_in_progress", "failed"] as const)
    append(operation, events, {
      kind: "participant-start",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      receipt: receipt(operation, state),
    });
  append(operation, events, {
    kind: "state-transition",
    from: "starting",
    to: "start_failed",
    authorized_by_action_operation_id: operation.operation_id,
    effect_action_operation_id: operation.operation_id,
    action_terminals: [
      {
        action_operation_id: operation.operation_id,
        outcome: "failed",
        reason_code: "child_start_failed",
      },
    ],
    reason_code: "child_start_failed",
  });
  append(operation, events, {
    kind: "state-transition",
    from: "start_failed",
    to: "starting",
    authorized_by_action_operation_id: retryId,
    effect_action_operation_id: retryId,
    action_terminals: [],
    reason_code: null,
  });
  return events;
}

function completed(attemptId: string): EngineSessionResult {
  return {
    attemptId,
    engine: "codex",
    ok: true,
    state: "completed",
    lifecycle: ["requested", "dispatched", "acknowledged", "completed"],
    output: "ok",
    evidenceStatus: "persisted",
    nativeSessionStatus: "captured",
  };
}

describe("revision retry authority", () => {
  test("caps every participant handoff admission at exactly one MiB", () => {
    const base = plan();
    const { schema_version: _schema, plan_digest: _digest, ...input } = base;
    expect(() =>
      materializeRevisionPreparationPlan({
        ...input,
        participant_starts: input.participant_starts.map((participant) => ({
          ...participant,
          max_shared_prompt_bytes: MAX_CANONICAL_HANDOFF_BYTES,
        })),
      }),
    ).not.toThrow();
    expect(() =>
      materializeRevisionPreparationPlan({
        ...input,
        participant_starts: input.participant_starts.map((participant) => ({
          ...participant,
          max_shared_prompt_bytes: MAX_CANONICAL_HANDOFF_BYTES + 1,
        })),
      }),
    ).toThrow("invalid revision preparation participant");
  });

  test("publishes the complete accepted retry lane set before closing the WAL", async () => {
    const target = operation();
    const events = failedPrefix(target);
    const appended: RevisionOperationEventV1[] = [];
    const publications: Array<ReadonlyMap<string, ParticipantStartReceiptV1>> = [];
    const result = await executeRevisionRetry({
      home: {
        revisions: {
          appendEvent: (_operation: RevisionOperationV1, event: RevisionOperationEventV1) =>
            appended.push(event),
        },
      } as unknown as ConversationHomeAuthorities,
      operation: target,
      plan: plan(),
      events,
      actionOperationId: retryId,
      now: () => at,
      retry: async (input) => {
        expect(input.generations.get("participant-1")).toBe(1);
        expect(input.prior_receipts.get("participant-1")?.at(-1)?.state).toBe("failed");
        return [
          {
            participant_id: "participant-1",
            start_generation: 1,
            attempt_key: input.attempt_keys.get("participant-1") ?? "",
            outcome: "accepted",
            private_evidence_ref: `sha256:${"5".repeat(64)}`,
            private_evidence_digest: `sha256:${"5".repeat(64)}`,
            observed_at: at,
          },
        ];
      },
      publishAccepted: ({ operation: publishedOperation, plan: publishedPlan, lanes }) => {
        expect(publishedOperation.operation_id).toBe(target.operation_id);
        expect(publishedPlan.plan_digest).toBe(plan().plan_digest);
        expect(lanes.get("participant-1")?.state).toBe("accepted");
        expect(appended.at(-1)?.payload).toMatchObject({
          kind: "participant-start",
          receipt: { state: "accepted" },
        });
        publications.push(new Map(lanes));
        return true;
      },
    });
    expect(appended).toEqual(result.slice(events.length));
    expect(foldRevisionOperation(target, result).state).toBe("started");
    const lanes = result.filter((event) => event.payload.kind === "participant-start");
    const lastLane = lanes.at(-1);
    if (lastLane?.payload.kind !== "participant-start") throw new Error("missing retry lane");
    expect(lastLane.payload.receipt.start_generation).toBe(1);
    expect(publications.at(0)?.get("participant-1")?.attempt_key).toBe(
      lastLane.payload.receipt.attempt_key,
    );
  });

  test("requires a captured, matching, genuinely fresh native session", () => {
    const participant = plan().participant_starts[0];
    if (!participant) throw new Error("missing fixture participant");
    const attemptKey = participantStartAttemptKey({
      operation_id: operationId,
      participant_id: participant.participant_id,
      start_generation: 1,
    });
    const evidenceRef = "/private/attempt-evidence.json";
    const classify = (
      resume: InternalResumeBinding | undefined,
      result = completed(attemptKey),
      authority: "accepted" | "missing" = "accepted",
    ) =>
      classifyRevisionLaneRetryResult({
        participant,
        attemptKey,
        result,
        resume,
        adapterEvidence: { attemptId: attemptKey, internalRef: evidenceRef },
        startAuthority:
          authority === "accepted"
            ? {
                schema_version: "1.0",
                attempt_id: attemptKey,
                engine: "codex",
                outcome: "accepted",
                native_session_id: resume?.nativeSessionId ?? null,
                evidence_ref: evidenceRef,
                evidence_sha256: `sha256:${"1".repeat(64)}`,
                process_quiescent: true,
                recorded_at: "2026-08-25T00:00:00.000Z",
                record_digest: `sha256:${"2".repeat(64)}`,
              }
            : null,
        priorNativeSessionIds: new Set(["prior-native-id"]),
      });
    expect(
      classify({ attemptId: attemptKey, engine: "codex", nativeSessionId: "fresh-native-id" }),
    ).toBe("accepted");
    expect(
      classify({ attemptId: attemptKey, engine: "codex", nativeSessionId: "prior-native-id" }),
    ).toBe("uncertain");
    expect(classify(undefined)).toBe("uncertain");
    expect(
      classify(
        { attemptId: attemptKey, engine: "codex", nativeSessionId: "fresh-native-id" },
        completed(attemptKey),
        "missing",
      ),
    ).toBe("uncertain");
    expect(
      classify({
        attemptId: `${attemptKey}-wrong`,
        engine: "codex",
        nativeSessionId: "fresh-native-id",
      }),
    ).toBe("uncertain");
  });

  test("blocks retry when a hidden participant lane is active although the child has no live operation", () => {
    const quiescent = revisionQuiescenceReader(
      { operationId: () => null },
      { isQuiescent: () => true },
      { isQuiescent: (target) => target !== operationId },
    );
    expect(quiescent("conversation-child", operationId)).toBe(false);
    expect(quiescent("conversation-child", retryId)).toBe(true);
  });
});
