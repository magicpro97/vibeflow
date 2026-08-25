import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestHex, digestV1 } from "../../src/durability/index.js";
import {
  materializeRevisionControlEffectClosure,
  materializeStopControlEffectClosure,
} from "../../src/orchestrator/conversation/conversation-control-effect-planner.js";
import { ConversationControlEffectStore } from "../../src/orchestrator/conversation/conversation-control-effect-store.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "../../src/orchestrator/conversation/lineage-revision-operation.js";
import {
  materializeParticipantStartReceipt,
  participantStartAttemptKey,
} from "../../src/orchestrator/conversation/revision-participant-receipt.js";
import type { RevisionOperationEventV1 } from "../../src/orchestrator/conversation/revision-planner.js";

const at = "2026-08-25T00:00:00.000Z";
const sha = (label: string) => digestV1("CONTROL-EFFECT-TEST\0v1\0", { label });
const operationId = `vf-operation-${"1".repeat(64)}`;

function revisionAuthority() {
  const operation = {
    operation_id: operationId,
    root_session_id: "root-session",
  } as RevisionOperationV1;
  const participant = {
    participant_id: "reviewer",
    engine: "codex" as const,
    model: "gpt-5.4",
    adapter_fingerprint: "codex-process-adapter/1",
    reconciliation_mode: "vf-process-lease" as const,
    cancellation_mode: "vf-process-lease" as const,
    wrapper_descriptor_digest: sha("wrapper"),
    max_shared_prompt_bytes: 1024,
  };
  const preparation = { participant_starts: [participant] } as RevisionPreparationPlanV1;
  const identity = {
    operation_id: operationId,
    participant_id: participant.participant_id,
    start_generation: 0,
  };
  const receipt = materializeParticipantStartReceipt({
    ...identity,
    attempt_key: participantStartAttemptKey(identity),
    state: "failed",
    engine: participant.engine,
    model: participant.model,
    adapter_fingerprint: participant.adapter_fingerprint,
    reconciliation_mode: participant.reconciliation_mode,
    cancel_attempt_key: null,
    cancellation_mode: null,
    shared_prompt_digest: sha("prompt"),
    wrapper_digest: participant.wrapper_descriptor_digest,
    private_native_session_ref: null,
    private_native_session_producer_receipt_digest: null,
    private_process_lease_ref: null,
    private_process_lease_producer_receipt_digest: null,
    prepared_at: at,
    observed_at: null,
  });
  const events = [
    { payload: { kind: "participant-start", receipt } },
  ] as RevisionOperationEventV1[];
  return { operation, preparation, events, receipt };
}

test("control effect objects survive restart and reject corrupt closure members", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-control-effect-"));
  try {
    const expectedFold = sha("ordinary-fold");
    const expectedHeader = sha("ordinary-header");
    const closure = materializeStopControlEffectClosure({
      target_operation_id: "ordinary-operation",
      expected_operation_header_digest: expectedHeader,
      expected_pre_effect_fold_digest: expectedFold,
    });
    new ConversationControlEffectStore(root).writeClosure(closure);
    const restarted = new ConversationControlEffectStore(root);
    expect(
      restarted.assertForAction({
        plan_digest: closure.plan.plan_digest,
        action_type: "conversation.stop_operation",
        target_operation_id: "ordinary-operation",
        expected_pre_effect_fold_digest: expectedFold,
        expected_operation_header_digest: expectedHeader,
      }),
    ).toEqual(closure.plan);
    expect(() =>
      restarted.assertForAction({
        plan_digest: closure.plan.plan_digest,
        action_type: "conversation.stop_operation",
        target_operation_id: "ordinary-operation",
        expected_pre_effect_fold_digest: sha("stale-fold"),
        expected_operation_header_digest: expectedHeader,
      }),
    ).toThrow(/postcondition changed/i);
    const condition = closure.postconditions[0];
    if (!condition) throw new Error("control effect condition fixture is absent");
    writeFileSync(join(root, "objects", "v1", `${digestHex(condition.binding_digest)}.json`), "{}");
    expect(() => restarted.readPlan(closure.plan.plan_digest)).toThrow(/postcondition|invalid/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retry control effect binds every proved-absent lane receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-retry-effect-"));
  try {
    const fixture = revisionAuthority();
    const expectedFold = sha("revision-fold");
    const closure = materializeRevisionControlEffectClosure({
      action_type: "conversation.retry_revision_operation",
      operation: fixture.operation,
      preparation: fixture.preparation,
      events: fixture.events,
      expected_pre_effect_fold_digest: expectedFold,
    });
    expect(closure.plan.effects).toHaveLength(1);
    expect(closure.plan.effects[0]).toMatchObject({
      participant_id: "reviewer",
      effect_kind: "cancel-or-prove-quiescent",
      mode: "vf-process-lease",
    });
    expect(closure.native_references[0]).toMatchObject({
      reference_kind: "participant-start-receipt",
      authority_record_digest: fixture.receipt.receipt_digest,
      private_reference_content_digest: null,
    });
    const store = new ConversationControlEffectStore(root);
    store.writeClosure(closure);
    expect(
      store.assertForAction({
        plan_digest: closure.plan.plan_digest,
        action_type: "conversation.retry_revision_operation",
        target_operation_id: operationId,
        expected_pre_effect_fold_digest: expectedFold,
      }).plan_digest,
    ).toBe(closure.plan.plan_digest);
    const firstParticipant = fixture.preparation.participant_starts[0];
    if (!firstParticipant) throw new Error("retry participant fixture is absent");
    expect(() =>
      materializeRevisionControlEffectClosure({
        action_type: "conversation.retry_revision_operation",
        operation: fixture.operation,
        preparation: {
          ...fixture.preparation,
          participant_starts: [
            ...fixture.preparation.participant_starts,
            {
              ...firstParticipant,
              participant_id: "missing-lane",
            },
          ],
        },
        events: fixture.events,
        expected_pre_effect_fold_digest: expectedFold,
      }),
    ).toThrow(/incomplete/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
