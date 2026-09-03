import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type JsonValue,
  acquireProcessLock,
  appendVffrFrame,
  canonicalJsonBytes,
  digestV1,
} from "../../src/durability/index.js";
import { conversationRevisionActionPlanDigest } from "../../src/orchestrator/conversation/conversation-revision-action-plan.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "../../src/orchestrator/conversation/lineage-revision-operation.js";
import { foldRevisionOperation } from "../../src/orchestrator/conversation/revision-fold.js";
import {
  REVISION_OPERATION_EVENT_STORAGE,
  type RevisionOperationEventV1,
  assertRevisionOperationEventV1,
} from "../../src/orchestrator/conversation/revision-operation-event-contract.js";
import {
  type ParticipantStartReceiptV1,
  assertParticipantStartReceiptV1,
  materializeParticipantStartReceipt,
  participantStartAttemptKey,
} from "../../src/orchestrator/conversation/revision-participant-receipt.js";
import {
  materializeRevisionEvent,
  materializeRevisionOperation,
  materializeRevisionPreparationPlan,
} from "../../src/orchestrator/conversation/revision-planner.js";
import { ConversationRevisionStore } from "../../src/orchestrator/conversation/revision-store.js";

const NOW = "2026-08-27T00:00:00.000Z";
const LATER = "2026-08-27T01:00:00.000Z";
const sha = (label: string) => digestV1("VF-REVISION-RECEIPT-BINDING-TEST\0v1\0", { label });

function authorityFixture(): {
  operation: RevisionOperationV1;
  plan: RevisionPreparationPlanV1;
  prefix: RevisionOperationEventV1[];
} {
  const parent = {
    conversation_id: "conversation-root",
    revision_id: "revision-root",
    revision_ordinal: 0,
  };
  const plan = materializeRevisionPreparationPlan({
    root_session_id: "conversation-root",
    parent,
    expected_head_digest: sha("head"),
    expected_head_epoch: 0,
    expected_reservation_digest: null,
    expected_reservation_epoch: 0,
    expected_parent_last_seq: 4,
    expected_parent_lock_digest: sha("parent-lock"),
    permission_digest: sha("permission"),
    revision_claim_epoch: 1,
    binding_delta_digest: sha("binding-delta"),
    resulting_binding_set_digest: sha("binding-set"),
    handoff_selection_plan_digest: sha("handoff-selection"),
    participant_starts: [
      {
        participant_id: "participant-1",
        engine: "codex",
        model: "gpt-5.4",
        adapter_fingerprint: "codex-adapter/1",
        reconciliation_mode: "provider-idempotency",
        cancellation_mode: "idempotent-cancel",
        wrapper_descriptor_digest: sha("wrapper"),
        max_shared_prompt_bytes: 1024,
      },
    ],
    created_at: NOW,
    expires_at: LATER,
  });
  const operation = materializeRevisionOperation({
    operation_id: `vf-operation-${"a".repeat(64)}`,
    proposal_id: `vf-proposal-${"b".repeat(64)}`,
    proposal_digest: sha("proposal"),
    approval_id: `vf-approval-${"c".repeat(64)}`,
    approval_digest: sha("approval"),
    plan_digest: conversationRevisionActionPlanDigest(plan.root_session_id, plan),
    authority_epoch: 0,
    authority_head_digest: sha("authority-head"),
    root_session_id: plan.root_session_id,
    parent,
    child: {
      conversation_id: "conversation-child",
      revision_id: "revision-child",
      revision_ordinal: 1,
    },
    expected_head_digest: plan.expected_head_digest,
    expected_reservation_digest: plan.expected_reservation_digest,
    expected_reservation_epoch: plan.expected_reservation_epoch,
    revision_claim_epoch: plan.revision_claim_epoch,
    expected_parent_last_seq: plan.expected_parent_last_seq,
    expected_parent_lock_digest: plan.expected_parent_lock_digest,
    permission_digest: plan.permission_digest,
    binding_set_digest: plan.resulting_binding_set_digest,
    handoff_digest: sha("handoff"),
    handoff_selection_digest: plan.handoff_selection_plan_digest,
    prompt_projection_digest: sha("shared-prompt"),
    created_at: NOW,
  });
  const prefix: RevisionOperationEventV1[] = [];
  for (const payload of [
    {
      kind: "state-transition" as const,
      from: "created" as const,
      to: "preparing" as const,
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [],
      reason_code: null,
    },
    {
      kind: "state-transition" as const,
      from: "preparing" as const,
      to: "prepared" as const,
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [],
      reason_code: null,
    },
  ])
    prefix.push(materializeRevisionEvent(operation, prefix, payload, NOW));
  prefix.push(
    materializeRevisionEvent(
      operation,
      prefix,
      {
        kind: "head-commit",
        authorized_by_action_operation_id: operation.operation_id,
        effect_action_operation_id: operation.operation_id,
        prior_head_digest: operation.expected_head_digest,
        prior_head_checkpoint_digest: operation.expected_head_digest,
        committed_head_digest: sha("child-head"),
        directory_fsync_completed: true,
      },
      NOW,
    ),
  );
  prefix.push(
    materializeRevisionEvent(
      operation,
      prefix,
      {
        kind: "state-transition",
        from: "published",
        to: "starting",
        authorized_by_action_operation_id: operation.operation_id,
        effect_action_operation_id: operation.operation_id,
        action_terminals: [],
        reason_code: null,
      },
      NOW,
    ),
  );
  return { operation, plan, prefix };
}

type ReceiptBindingOverride = Partial<
  Pick<
    ParticipantStartReceiptV1,
    | "adapter_fingerprint"
    | "engine"
    | "model"
    | "participant_id"
    | "reconciliation_mode"
    | "shared_prompt_digest"
    | "wrapper_digest"
  >
>;

function receipt(
  operation: RevisionOperationV1,
  overrides: ReceiptBindingOverride = {},
): ParticipantStartReceiptV1 {
  const participantId = overrides.participant_id ?? "participant-1";
  const identity = {
    operation_id: operation.operation_id,
    participant_id: participantId,
    start_generation: 0,
  };
  return materializeParticipantStartReceipt({
    operation_id: operation.operation_id,
    start_generation: 0,
    state: "prepared",
    engine: "codex",
    model: "gpt-5.4",
    adapter_fingerprint: "codex-adapter/1",
    reconciliation_mode: "provider-idempotency",
    cancel_attempt_key: null,
    cancellation_mode: null,
    shared_prompt_digest: operation.prompt_projection_digest,
    wrapper_digest: sha("wrapper"),
    private_native_session_ref: null,
    private_native_session_producer_receipt_digest: null,
    private_process_lease_ref: null,
    private_process_lease_producer_receipt_digest: null,
    prepared_at: NOW,
    observed_at: null,
    ...overrides,
    participant_id: participantId,
    attempt_key: participantStartAttemptKey(identity),
  });
}

function receiptEvent(
  fixture: ReturnType<typeof authorityFixture>,
  row: ParticipantStartReceiptV1,
): RevisionOperationEventV1 {
  return materializeRevisionEvent(
    fixture.operation,
    fixture.prefix,
    {
      kind: "participant-start",
      authorized_by_action_operation_id: fixture.operation.operation_id,
      effect_action_operation_id: fixture.operation.operation_id,
      receipt: row,
    },
    NOW,
  );
}

function appendPrefix(
  store: ConversationRevisionStore,
  fixture: ReturnType<typeof authorityFixture>,
): void {
  store.writeHeader(fixture.operation, fixture.plan);
  for (const event of fixture.prefix) store.appendEvent(fixture.operation, event);
}

describe("revision participant receipt plan binding", () => {
  test("anchors a re-digested preparation plan to the approved action plan", () => {
    const fixture = authorityFixture();
    const { plan_digest: _planDigest, ...planPreimage } = fixture.plan;
    const forgedPlan = materializeRevisionPreparationPlan({
      ...structuredClone(planPreimage),
      participant_starts: fixture.plan.participant_starts.map((participant) => ({
        ...structuredClone(participant),
        model: "forged-model",
        adapter_fingerprint: "forged-adapter/1",
        reconciliation_mode: "inspect-start" as const,
        cancellation_mode: "inspect-cancel" as const,
        wrapper_descriptor_digest: sha("forged-wrapper"),
        max_shared_prompt_bytes: 2_048,
      })),
    });
    const forgedReceipt = receiptEvent(
      fixture,
      receipt(fixture.operation, {
        model: "forged-model",
        adapter_fingerprint: "forged-adapter/1",
        reconciliation_mode: "inspect-start",
        wrapper_digest: sha("forged-wrapper"),
      }),
    );
    expect(forgedPlan.plan_digest).not.toBe(fixture.plan.plan_digest);
    expect(
      conversationRevisionActionPlanDigest(fixture.operation.root_session_id, forgedPlan),
    ).not.toBe(fixture.operation.plan_digest);
    expect(() =>
      foldRevisionOperation(fixture.operation, [...fixture.prefix, forgedReceipt], {
        preparationPlan: forgedPlan,
      }),
    ).toThrow("revision operation preparation plan binding mismatch");

    const root = mkdtempSync(join(tmpdir(), "vf-revision-forged-plan-"));
    try {
      const store = new ConversationRevisionStore({ artifactRoot: root });
      expect(store.readEvents(fixture.operation.operation_id)).toEqual([]);
      expect(() => store.writeHeader(fixture.operation, forgedPlan)).toThrow(
        "revision operation preparation plan binding mismatch",
      );
      store.writeHeader(fixture.operation, fixture.plan);
      writeFileSync(
        join(store.paths.plans, `${fixture.operation.operation_id}.json`),
        canonicalJsonBytes(forgedPlan),
      );
      expect(() => store.readOperation(fixture.operation.operation_id)).toThrow(
        "revision operation preparation plan binding mismatch",
      );
      expect(() => store.readPlan(fixture.operation.operation_id)).toThrow(
        "revision operation preparation plan binding mismatch",
      );
      expect(() => store.readEvents(fixture.operation.operation_id)).toThrow(
        "revision operation preparation plan binding mismatch",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects every re-digested participant/header mismatch and accepts exact replay", () => {
    const fixture = authorityFixture();
    const valid = receiptEvent(fixture, receipt(fixture.operation));
    expect(
      foldRevisionOperation(fixture.operation, [...fixture.prefix, valid], {
        preparationPlan: fixture.plan,
      }).state,
    ).toBe("starting");
    expect(() => foldRevisionOperation(fixture.operation, [...fixture.prefix, valid])).toThrow(
      "participant receipt preparation plan authority is absent",
    );

    const mismatches: Array<[string, ReceiptBindingOverride]> = [
      ["unknown participant", { participant_id: "participant-unknown" }],
      ["engine", { engine: "claude" }],
      ["model", { model: "claude-sonnet-4-6" }],
      ["adapter", { adapter_fingerprint: "forged-adapter/1" }],
      ["reconciliation", { reconciliation_mode: "inspect-start" }],
      ["shared prompt", { shared_prompt_digest: sha("forged-shared-prompt") }],
      ["wrapper", { wrapper_digest: sha("forged-wrapper") }],
    ];
    for (const [_label, patch] of mismatches) {
      const forged = receiptEvent(fixture, receipt(fixture.operation, patch));
      if (forged.payload.kind !== "participant-start") throw new Error("invalid test receipt");
      const forgedReceipt = forged.payload.receipt;
      expect(() => assertParticipantStartReceiptV1(forgedReceipt)).not.toThrow();
      expect(() => assertRevisionOperationEventV1(forged)).not.toThrow();
      expect(() =>
        foldRevisionOperation(fixture.operation, [...fixture.prefix, forged], {
          preparationPlan: fixture.plan,
        }),
      ).toThrow(/participant receipt .*preparation|participant receipt prompt|absent from/);
    }
  });

  test("append and recovery both consult the persisted header/plan pair", () => {
    const fixture = authorityFixture();
    const appendRoot = mkdtempSync(join(tmpdir(), "vf-revision-receipt-append-"));
    const recoveryRoot = mkdtempSync(join(tmpdir(), "vf-revision-receipt-recovery-"));
    try {
      const appendStore = new ConversationRevisionStore({ artifactRoot: appendRoot });
      appendPrefix(appendStore, fixture);
      expect(() =>
        appendStore.appendEvent(
          fixture.operation,
          receiptEvent(fixture, receipt(fixture.operation, { participant_id: "unknown" })),
        ),
      ).toThrow("participant receipt is absent from preparation plan");
      const valid = receiptEvent(fixture, receipt(fixture.operation));
      appendStore.appendEvent(fixture.operation, valid);
      expect(appendStore.readEvents(fixture.operation.operation_id)).toEqual([
        ...fixture.prefix,
        valid,
      ]);

      const recoveryStore = new ConversationRevisionStore({ artifactRoot: recoveryRoot });
      appendPrefix(recoveryStore, fixture);
      const forged = receiptEvent(
        fixture,
        receipt(fixture.operation, { wrapper_digest: sha("re-digested-wrapper") }),
      );
      const lock = acquireProcessLock(recoveryStore.paths.lock, {
        operation: "inject-re-digested-revision-receipt",
      });
      try {
        appendVffrFrame(
          join(recoveryStore.paths.events, `${fixture.operation.operation_id}.vffr`),
          REVISION_OPERATION_EVENT_STORAGE.DOMAIN,
          forged as unknown as JsonValue,
          {
            domain: REVISION_OPERATION_EVENT_STORAGE.DOMAIN,
            maxFrames: 100_000,
            maxPayloadBytes: 2 * 1024 * 1024,
            maxAggregateBytes: 256 * 1024 * 1024,
            validatePayload(value) {
              assertRevisionOperationEventV1(value);
            },
            computePayloadDigest(value) {
              assertRevisionOperationEventV1(value);
              return value.event_digest;
            },
            validateJournalIdentity: (value) =>
              value.operation_id === fixture.operation.operation_id,
            lock,
          },
        );
      } finally {
        lock.release();
      }
      expect(() => recoveryStore.readEvents(fixture.operation.operation_id)).toThrow(
        "participant receipt prompt, wrapper, or cancellation binding mismatch",
      );
    } finally {
      rmSync(appendRoot, { recursive: true, force: true });
      rmSync(recoveryRoot, { recursive: true, force: true });
    }
  });
});
