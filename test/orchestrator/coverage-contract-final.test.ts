import { describe, expect, test } from "bun:test";
import {
  ACTION_OPERATION_STATE,
  PUBLIC_OPERATION_PARTICIPANT_START_PHASE,
  PUBLIC_OPERATION_REVISION_PHASE,
} from "../../src/actions/protocol-contract.js";
import { digestV1 } from "../../src/durability/index.js";
import type { ConversationArtifactStore } from "../../src/orchestrator/conversation/artifact-store.js";
import type { ConversationHomeAuthorities } from "../../src/orchestrator/conversation/conversation-home-authorities.js";
import { conversationRevisionActionPlanDigest } from "../../src/orchestrator/conversation/conversation-revision-action-plan.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "../../src/orchestrator/conversation/lineage-revision-operation.js";
import { executeRevisionRetry } from "../../src/orchestrator/conversation/revision-control-retry.js";
import { foldRevisionOperation } from "../../src/orchestrator/conversation/revision-fold.js";
import {
  REVISION_OPERATION_EVENT_PAYLOAD_KIND,
  REVISION_OPERATION_EVENT_SCHEMA_VERSION,
  REVISION_OPERATION_EVENT_STORAGE,
  REVISION_OPERATION_INITIAL_PHASE,
  type RevisionOperationEventV1,
  type RevisionOperationPayloadV1,
  assertRevisionOperationEventV1,
} from "../../src/orchestrator/conversation/revision-operation-event-contract.js";
import type {
  ConversationRevisionExecutorOptions,
  PreparedConversationRevisionV1,
} from "../../src/orchestrator/conversation/revision-operation-executor.js";
import { runOwnedRevisionStart } from "../../src/orchestrator/conversation/revision-owned-start-runtime.js";
import {
  PARTICIPANT_CANCEL_MODE,
  PARTICIPANT_START_RECONCILIATION_MODE,
  type ParticipantStartReceiptV1,
  materializeParticipantStartReceipt,
  participantStartAttemptKey,
} from "../../src/orchestrator/conversation/revision-participant-receipt.js";
import {
  materializeRevisionEvent,
  materializeRevisionOperation,
  materializeRevisionPreparationPlan,
} from "../../src/orchestrator/conversation/revision-planner.js";
import type { RevisionStartOwnerTokenV1 } from "../../src/orchestrator/conversation/revision-start-owner.js";
import type { ConversationRuntime } from "../../src/orchestrator/conversation/runtime.js";

const CREATED_AT = "2026-08-27T00:00:00.000Z";
const OPERATION_ID = `vf-operation-${"1".repeat(64)}`;
const RETRY_OPERATION_ID = `vf-operation-${"2".repeat(64)}`;
const PROPOSAL_ID = `vf-proposal-${"3".repeat(64)}`;
const digest = (label: string): string =>
  digestV1("VF-FINAL-CONVERSATION-COVERAGE\0v1\0", { label });

function revisionPlan(participantCount: 0 | 1): RevisionPreparationPlanV1 {
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
    participant_starts:
      participantCount === 0
        ? []
        : [
            {
              participant_id: "participant-final-coverage",
              engine: "codex",
              model: "gpt-5.4",
              adapter_fingerprint: "adapter-final-coverage",
              reconciliation_mode: PARTICIPANT_START_RECONCILIATION_MODE.PROVIDER_IDEMPOTENCY,
              cancellation_mode: PARTICIPANT_CANCEL_MODE.IDEMPOTENT_CANCEL,
              wrapper_descriptor_digest: digest("wrapper"),
              max_shared_prompt_bytes: 1024,
            },
          ],
    created_at: CREATED_AT,
    expires_at: "2026-08-27T01:00:00.000Z",
  });
}

function revisionOperation(
  plan: RevisionPreparationPlanV1,
  operationId = OPERATION_ID,
): RevisionOperationV1 {
  return materializeRevisionOperation({
    operation_id: operationId,
    proposal_id: PROPOSAL_ID,
    proposal_digest: digest("proposal"),
    approval_id: `vf-approval-${"4".repeat(64)}`,
    approval_digest: digest("approval"),
    plan_digest: conversationRevisionActionPlanDigest("conversation-root", plan),
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
    created_at: CREATED_AT,
  });
}

function append(
  operation: RevisionOperationV1,
  events: RevisionOperationEventV1[],
  payload: RevisionOperationPayloadV1,
): void {
  events.push(materializeRevisionEvent(operation, events, payload, CREATED_AT));
}

function startingPrefix(operation: RevisionOperationV1): RevisionOperationEventV1[] {
  const events: RevisionOperationEventV1[] = [];
  append(operation, events, {
    kind: REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION,
    from: REVISION_OPERATION_INITIAL_PHASE.CREATED,
    to: PUBLIC_OPERATION_REVISION_PHASE.PREPARING,
    authorized_by_action_operation_id: operation.operation_id,
    effect_action_operation_id: operation.operation_id,
    action_terminals: [],
    reason_code: null,
  });
  append(operation, events, {
    kind: REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION,
    from: PUBLIC_OPERATION_REVISION_PHASE.PREPARING,
    to: PUBLIC_OPERATION_REVISION_PHASE.PREPARED,
    authorized_by_action_operation_id: operation.operation_id,
    effect_action_operation_id: operation.operation_id,
    action_terminals: [],
    reason_code: null,
  });
  append(operation, events, {
    kind: REVISION_OPERATION_EVENT_PAYLOAD_KIND.HEAD_COMMIT,
    authorized_by_action_operation_id: operation.operation_id,
    effect_action_operation_id: operation.operation_id,
    prior_head_digest: operation.expected_head_digest,
    prior_head_checkpoint_digest: operation.expected_head_digest,
    committed_head_digest: digest("committed-child-head"),
    directory_fsync_completed: true,
  });
  append(operation, events, {
    kind: REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION,
    from: PUBLIC_OPERATION_REVISION_PHASE.PUBLISHED,
    to: PUBLIC_OPERATION_REVISION_PHASE.STARTING,
    authorized_by_action_operation_id: operation.operation_id,
    effect_action_operation_id: operation.operation_id,
    action_terminals: [],
    reason_code: null,
  });
  return events;
}

function failedReceipt(
  operation: RevisionOperationV1,
  plan: RevisionPreparationPlanV1,
  state: ParticipantStartReceiptV1["state"],
): ParticipantStartReceiptV1 {
  const participant = plan.participant_starts[0];
  if (!participant) throw new Error("retry fixture participant is absent");
  const identity = {
    operation_id: operation.operation_id,
    participant_id: participant.participant_id,
    start_generation: 0,
  };
  return materializeParticipantStartReceipt({
    ...identity,
    attempt_key: participantStartAttemptKey(identity),
    state,
    engine: participant.engine,
    model: participant.model,
    adapter_fingerprint: participant.adapter_fingerprint,
    reconciliation_mode: participant.reconciliation_mode,
    cancel_attempt_key: null,
    cancellation_mode: null,
    shared_prompt_digest: operation.prompt_projection_digest,
    wrapper_digest: participant.wrapper_descriptor_digest,
    private_native_session_ref: null,
    private_native_session_producer_receipt_digest: null,
    private_process_lease_ref: null,
    private_process_lease_producer_receipt_digest: null,
    prepared_at: CREATED_AT,
    observed_at: null,
  });
}

function retryPrefix(
  operation: RevisionOperationV1,
  plan: RevisionPreparationPlanV1,
): RevisionOperationEventV1[] {
  const events = startingPrefix(operation);
  for (const state of [
    PUBLIC_OPERATION_PARTICIPANT_START_PHASE.PREPARED,
    PUBLIC_OPERATION_PARTICIPANT_START_PHASE.EFFECT_IN_PROGRESS,
    PUBLIC_OPERATION_PARTICIPANT_START_PHASE.FAILED,
  ])
    append(operation, events, {
      kind: REVISION_OPERATION_EVENT_PAYLOAD_KIND.PARTICIPANT_START,
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      receipt: failedReceipt(operation, plan, state),
    });
  append(operation, events, {
    kind: REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION,
    from: PUBLIC_OPERATION_REVISION_PHASE.STARTING,
    to: PUBLIC_OPERATION_REVISION_PHASE.START_FAILED,
    authorized_by_action_operation_id: operation.operation_id,
    effect_action_operation_id: operation.operation_id,
    action_terminals: [
      {
        action_operation_id: operation.operation_id,
        outcome: ACTION_OPERATION_STATE.FAILED,
        reason_code: "child_start_failed",
      },
    ],
    reason_code: "child_start_failed",
  });
  append(operation, events, {
    kind: REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION,
    from: PUBLIC_OPERATION_REVISION_PHASE.START_FAILED,
    to: PUBLIC_OPERATION_REVISION_PHASE.STARTING,
    authorized_by_action_operation_id: RETRY_OPERATION_ID,
    effect_action_operation_id: RETRY_OPERATION_ID,
    action_terminals: [],
    reason_code: null,
  });
  return events;
}

function persistedEvent(payload: RevisionOperationPayloadV1): RevisionOperationEventV1 {
  const preimage = {
    schema_version: REVISION_OPERATION_EVENT_SCHEMA_VERSION,
    operation_id: OPERATION_ID,
    sequence: 0,
    previous_event_digest: null,
    payload,
    recorded_at: CREATED_AT,
  } as const;
  return {
    ...preimage,
    event_digest: digestV1(REVISION_OPERATION_EVENT_STORAGE.DIGEST_DOMAIN, preimage),
  };
}

describe("final conversation contract branch coverage", () => {
  test("revision WAL validates reconciliation results and rejects an un-fsynced head", () => {
    const reconciliation = persistedEvent({
      kind: REVISION_OPERATION_EVENT_PAYLOAD_KIND.RECONCILIATION_RESULT,
      authorized_by_action_operation_id: OPERATION_ID,
      effect_action_operation_id: OPERATION_ID,
      observed_state_digest: digest("observed-state"),
      outcome: ACTION_OPERATION_STATE.FAILED,
      action_terminals: [
        {
          action_operation_id: OPERATION_ID,
          outcome: ACTION_OPERATION_STATE.FAILED,
          reason_code: "reconciliation_inconclusive",
        },
      ],
      reason_code: "reconciliation_inconclusive",
    });
    expect(() => assertRevisionOperationEventV1(reconciliation)).not.toThrow();

    const invalidReconciliation = persistedEvent({
      ...reconciliation.payload,
      observed_state_digest: "not-a-digest",
    } as RevisionOperationPayloadV1);
    expect(() => assertRevisionOperationEventV1(invalidReconciliation)).toThrow(
      "invalid revision reconciliation result payload",
    );

    const unflushedHead = persistedEvent({
      kind: REVISION_OPERATION_EVENT_PAYLOAD_KIND.HEAD_COMMIT,
      authorized_by_action_operation_id: OPERATION_ID,
      effect_action_operation_id: OPERATION_ID,
      prior_head_digest: digest("prior-head"),
      prior_head_checkpoint_digest: digest("prior-checkpoint"),
      committed_head_digest: digest("committed-head"),
      directory_fsync_completed: false,
    } as unknown as RevisionOperationPayloadV1);
    expect(() => assertRevisionOperationEventV1(unflushedHead)).toThrow(
      "invalid revision head commit payload",
    );
  });

  test("a failed retry lane closes the retried revision as start_failed", async () => {
    const plan = revisionPlan(1);
    const operation = revisionOperation(plan);
    const events = retryPrefix(operation, plan);
    const appended: RevisionOperationEventV1[] = [];
    const result = await executeRevisionRetry({
      home: {
        revisions: {
          appendEvent: (_target: RevisionOperationV1, event: RevisionOperationEventV1) => {
            appended.push(event);
          },
        },
      } as unknown as ConversationHomeAuthorities,
      operation,
      plan,
      events,
      actionOperationId: RETRY_OPERATION_ID,
      now: () => CREATED_AT,
      retry: async ({ generations, attempt_keys: attemptKeys }) => [
        {
          participant_id: plan.participant_starts[0]?.participant_id ?? "",
          start_generation: generations.get(plan.participant_starts[0]?.participant_id ?? "") ?? -1,
          attempt_key: attemptKeys.get(plan.participant_starts[0]?.participant_id ?? "") ?? "",
          outcome: PUBLIC_OPERATION_PARTICIPANT_START_PHASE.FAILED,
          private_evidence_ref: null,
          private_evidence_digest: null,
          observed_at: CREATED_AT,
        },
      ],
    });
    expect(appended).toEqual(result.slice(events.length));
    expect(foldRevisionOperation(operation, result, { preparationPlan: plan }).state).toBe(
      PUBLIC_OPERATION_REVISION_PHASE.START_FAILED,
    );
    expect(result.at(-1)?.payload).toMatchObject({
      kind: REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION,
      to: PUBLIC_OPERATION_REVISION_PHASE.START_FAILED,
      action_terminals: [
        {
          action_operation_id: RETRY_OPERATION_ID,
          outcome: ACTION_OPERATION_STATE.FAILED,
          reason_code: "retry_start_failed",
        },
      ],
    });
  });

  test("a configured start that throws releases its already-started runtime", async () => {
    const plan = revisionPlan(0);
    const operation = revisionOperation(plan);
    const events = startingPrefix(operation);
    let configured = 0;
    let finished = 0;
    let mirrored = 0;
    const owner: RevisionStartOwnerTokenV1 = {
      assertHeld() {},
      release() {},
    };
    const home = {
      revisions: {
        readEvents: () => structuredClone(events),
        appendEvent: (_target: RevisionOperationV1, event: RevisionOperationEventV1) => {
          events.push(structuredClone(event));
        },
      },
      revisionLanes: {
        finalize: () => PUBLIC_OPERATION_REVISION_PHASE.STARTED,
      },
      actions: {
        terminal: () => {
          mirrored += 1;
        },
      },
    } as unknown as ConversationHomeAuthorities;
    const runtime = {
      startRevisionBarrier: async () => true,
      finish: (conversationId: string) => {
        expect(conversationId).toBe(operation.child.conversation_id);
        finished += 1;
      },
    } as unknown as ConversationRuntime;
    const prepared = {
      operation,
      revisionPlan: plan,
      proposal: { proposal_id: PROPOSAL_ID },
      manifest: { conversation_id: operation.child.conversation_id },
      runtimeOperationId: "runtime-operation-final-coverage",
    } as unknown as PreparedConversationRevisionV1;
    const options = {
      runtime,
      home,
      artifactStore: {} as ConversationArtifactStore,
      executeConfigured: async () => {
        configured += 1;
        throw new Error("injected configured-start failure");
      },
    } as unknown as ConversationRevisionExecutorOptions;

    await runOwnedRevisionStart({ prepared, options, owner });

    expect(configured).toBe(1);
    expect(finished).toBe(1);
    expect(mirrored).toBe(2);
    expect(foldRevisionOperation(operation, events, { preparationPlan: plan }).state).toBe(
      PUBLIC_OPERATION_REVISION_PHASE.STARTED,
    );
  });
});
