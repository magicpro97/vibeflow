import { describe, expect, test } from "bun:test";
import { digestV1 } from "../../src/durability/index.js";
import { foldRevisionOperation } from "../../src/orchestrator/conversation/revision-fold.js";
import type { ParticipantStartReceiptV1 } from "../../src/orchestrator/conversation/revision-participant-receipt.js";
import {
  deriveRevisionChildIdentity,
  materializeRevisionEvent,
  materializeRevisionOperation,
  materializeRevisionReservation,
} from "../../src/orchestrator/conversation/revision-planner.js";

const operationId = `vf-operation-${"a".repeat(64)}`;
const proposalId = `vf-proposal-${"b".repeat(64)}`;
const approvalId = `vf-approval-${"c".repeat(64)}`;
const digest = (label: string) => digestV1("REVISION-FIXTURE\0v1\0", { label });
const retryOperationId = `vf-operation-${"d".repeat(64)}`;
const reconcileOperationId = `vf-operation-${"e".repeat(64)}`;

function revisionOperation() {
  return materializeRevisionOperation({
    operation_id: operationId,
    proposal_id: proposalId,
    proposal_digest: digest("proposal"),
    approval_id: approvalId,
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
    expected_parent_last_seq: 7,
    expected_parent_lock_digest: digest("lock"),
    permission_digest: digest("permission"),
    binding_set_digest: digest("bindings"),
    handoff_digest: digest("handoff"),
    handoff_selection_digest: digest("selection"),
    prompt_projection_digest: digest("prompt"),
    created_at: "2026-08-25T00:00:00.000Z",
  });
}

function transition(
  operation: ReturnType<typeof revisionOperation>,
  events: Parameters<typeof materializeRevisionEvent>[1],
  payload: Parameters<typeof materializeRevisionEvent>[2],
) {
  return materializeRevisionEvent(operation, events, payload, "2026-08-25T00:00:00.000Z");
}

function participantReceipt(
  operation: ReturnType<typeof revisionOperation>,
  state: ParticipantStartReceiptV1["state"],
): ParticipantStartReceiptV1 {
  const preimage = {
    schema_version: "1.0" as const,
    operation_id: operation.operation_id,
    participant_id: "participant-1",
    start_generation: 0,
    attempt_key: `vf-start-${digestV1("VF-PARTICIPANT-START-ATTEMPT\0v1\0", {
      schema_version: "1.0",
      operation_id: operation.operation_id,
      participant_id: "participant-1",
      start_generation: 0,
    }).slice(7)}`,
    state,
    engine: "codex" as const,
    model: "gpt-5.4",
    adapter_fingerprint: "adapter-1",
    reconciliation_mode: "provider-idempotency" as const,
    cancel_attempt_key: null,
    cancellation_mode: null,
    shared_prompt_digest: operation.prompt_projection_digest,
    wrapper_digest: digest("wrapper"),
    private_native_session_ref: null,
    private_native_session_producer_receipt_digest: null,
    private_process_lease_ref: null,
    private_process_lease_producer_receipt_digest: null,
    prepared_at: operation.created_at,
    observed_at: null,
  };
  return {
    ...preimage,
    receipt_digest: digestV1("VF-PARTICIPANT-START-RECEIPT\0v1\0", preimage),
  };
}

describe("revision WAL", () => {
  test("derives one child pair and folds the legal publication prefix", () => {
    const child = deriveRevisionChildIdentity({
      root_session_id: "conversation-root",
      parent_conversation_id: "conversation-root",
      parent_revision_id: "revision-root",
      proposal_id: proposalId,
      revision_claim_epoch: 1,
      revision_ordinal: 1,
    });
    expect(child.conversation_id).toMatch(/^conversation-[0-9a-f]{32}$/);
    expect(child.revision_id).toBe(
      `revision-${child.conversation_id.slice("conversation-".length)}`,
    );
    const operation = materializeRevisionOperation({
      operation_id: operationId,
      proposal_id: proposalId,
      proposal_digest: digest("proposal"),
      approval_id: approvalId,
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
      child,
      expected_head_digest: digest("head"),
      expected_reservation_digest: null,
      expected_reservation_epoch: 0,
      revision_claim_epoch: 1,
      expected_parent_last_seq: 7,
      expected_parent_lock_digest: digest("lock"),
      permission_digest: digest("permission"),
      binding_set_digest: digest("bindings"),
      handoff_digest: digest("handoff"),
      handoff_selection_digest: digest("selection"),
      prompt_projection_digest: digest("prompt"),
      created_at: "2026-08-25T00:00:00.000Z",
    });
    const reservation = materializeRevisionReservation(operation);
    expect(reservation.child).toEqual(child);
    const preparing = materializeRevisionEvent(operation, [], {
      kind: "state-transition",
      from: "created",
      to: "preparing",
      authorized_by_action_operation_id: operationId,
      effect_action_operation_id: operationId,
      action_terminals: [],
      reason_code: null,
    });
    const prepared = materializeRevisionEvent(operation, [preparing], {
      kind: "state-transition",
      from: "preparing",
      to: "prepared",
      authorized_by_action_operation_id: operationId,
      effect_action_operation_id: operationId,
      action_terminals: [],
      reason_code: null,
    });
    expect(foldRevisionOperation(operation, [preparing, prepared]).state).toBe("prepared");
    expect(() => foldRevisionOperation(operation, [prepared, preparing])).toThrow(/sequence/i);
  });

  test("rejects forged authorizers, effect switches, and terminal cardinality", () => {
    const operation = revisionOperation();
    const forged = transition(operation, [], {
      kind: "state-transition",
      from: "created",
      to: "preparing",
      authorized_by_action_operation_id: retryOperationId,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [],
      reason_code: null,
    });
    expect(() => foldRevisionOperation(operation, [forged])).toThrow(/authorizer/i);
    const preparing = transition(operation, [], {
      kind: "state-transition",
      from: "created",
      to: "preparing",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [],
      reason_code: null,
    });
    const badRecovery = transition(operation, [preparing], {
      kind: "state-transition",
      from: "preparing",
      to: "needs_recovery",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [],
      reason_code: "uncertain_start",
    });
    expect(() => foldRevisionOperation(operation, [preparing, badRecovery])).toThrow(
      /terminal cardinality/i,
    );
  });

  test("keeps inconclusive reconciliation in recovery and binds the exact prefix digest", () => {
    const operation = revisionOperation();
    const preparing = transition(operation, [], {
      kind: "state-transition",
      from: "created",
      to: "preparing",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [],
      reason_code: null,
    });
    const recovery = transition(operation, [preparing], {
      kind: "state-transition",
      from: "preparing",
      to: "needs_recovery",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [
        {
          action_operation_id: operation.operation_id,
          outcome: "needs_recovery",
          reason_code: "uncertain_start",
        },
      ],
      reason_code: "uncertain_start",
    });
    const prefix = foldRevisionOperation(operation, [preparing, recovery]).state_digest;
    const inconclusive = transition(operation, [preparing, recovery], {
      kind: "reconciliation-result",
      authorized_by_action_operation_id: reconcileOperationId,
      effect_action_operation_id: operation.operation_id,
      observed_state_digest: prefix,
      outcome: "failed",
      action_terminals: [
        {
          action_operation_id: reconcileOperationId,
          outcome: "failed",
          reason_code: "participant-evidence-is-incomplete",
        },
      ],
      reason_code: "participant-evidence-is-incomplete",
    });
    expect(foldRevisionOperation(operation, [preparing, recovery, inconclusive]).state).toBe(
      "needs_recovery",
    );
    const tampered = structuredClone(inconclusive);
    if (tampered.payload.kind !== "reconciliation-result") throw new Error("invalid fixture");
    tampered.payload.observed_state_digest = digest("wrong-prefix");
    const { event_digest: _digest, ...preimage } = tampered;
    tampered.event_digest = digestV1("VF-REVISION-OPERATION-EVENT\0v1\0", preimage);
    expect(() => foldRevisionOperation(operation, [preparing, recovery, tampered])).toThrow(
      /reconciliation result/i,
    );
  });

  test("rejects participant receipts that skip prepared or forge an attempt", () => {
    const operation = revisionOperation();
    const preparing = transition(operation, [], {
      kind: "state-transition",
      from: "created",
      to: "preparing",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [],
      reason_code: null,
    });
    const prepared = transition(operation, [preparing], {
      kind: "state-transition",
      from: "preparing",
      to: "prepared",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [],
      reason_code: null,
    });
    const head = transition(operation, [preparing, prepared], {
      kind: "head-commit",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      prior_head_digest: operation.expected_head_digest,
      prior_head_checkpoint_digest: operation.expected_head_digest,
      committed_head_digest: digest("child-head"),
      directory_fsync_completed: true,
    });
    const starting = transition(operation, [preparing, prepared, head], {
      kind: "state-transition",
      from: "published",
      to: "starting",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [],
      reason_code: null,
    });
    const receipt = participantReceipt(operation, "effect_in_progress");
    const participant = transition(operation, [preparing, prepared, head, starting], {
      kind: "participant-start",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      receipt,
    });
    expect(() =>
      foldRevisionOperation(operation, [preparing, prepared, head, starting, participant]),
    ).toThrow(/begin at prepared/i);
  });
});
