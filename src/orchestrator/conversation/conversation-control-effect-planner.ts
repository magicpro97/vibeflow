import { PUBLIC_OPERATION_PARTICIPANT_START_PHASE } from "../../actions/protocol-contract.js";
import {
  CONVERSATION_CONTROL_ACTION_TYPE,
  CONVERSATION_CONTROL_CONDITION_KIND,
  CONVERSATION_CONTROL_EFFECT_KIND,
  CONVERSATION_CONTROL_HOST_CANCEL_ADAPTER_FINGERPRINT,
  CONVERSATION_CONTROL_OPERATION_TERMINAL_STATES,
  CONVERSATION_CONTROL_PARTICIPANT_OUTCOMES,
  CONVERSATION_CONTROL_RECONCILIATION_OUTCOMES,
  CONVERSATION_NATIVE_REFERENCE_KIND,
  type ConversationControlActionTypeV1,
  type ConversationControlConditionV1,
  type ConversationControlEffectPlanV1,
  type ConversationControlEffectV1,
  type ConversationControlPostconditionBindingV1,
  type ConversationNativeReferenceBindingV1,
  controlEffectId,
  materializeConversationControlEffectPlan,
  materializeConversationControlPostconditionBinding,
  materializeConversationNativeReferenceBinding,
} from "./conversation-control-effect-types.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import { REVISION_OPERATION_EVENT_PAYLOAD_KIND } from "./revision-operation-event-contract.js";
import {
  PARTICIPANT_CANCEL_MODE,
  type ParticipantStartReceiptV1,
} from "./revision-participant-receipt.js";
import type { RevisionOperationEventV1 } from "./revision-planner.js";

export interface ConversationControlEffectClosureV1 {
  plan: ConversationControlEffectPlanV1;
  native_references: ConversationNativeReferenceBindingV1[];
  postconditions: ConversationControlPostconditionBindingV1[];
}

function latestReceipts(events: readonly RevisionOperationEventV1[]) {
  const latest = new Map<string, ParticipantStartReceiptV1>();
  for (const event of events)
    if (event.payload.kind === REVISION_OPERATION_EVENT_PAYLOAD_KIND.PARTICIPANT_START)
      latest.set(event.payload.receipt.participant_id, event.payload.receipt);
  return latest;
}

function conditionFor(actionType: ConversationControlActionTypeV1): ConversationControlConditionV1 {
  if (actionType === CONVERSATION_CONTROL_ACTION_TYPE.STOP_OPERATION)
    return {
      kind: CONVERSATION_CONTROL_CONDITION_KIND.OPERATION_TERMINAL,
      allowed_states: [...CONVERSATION_CONTROL_OPERATION_TERMINAL_STATES],
    };
  if (actionType === CONVERSATION_CONTROL_ACTION_TYPE.RECONCILE_REVISION_OPERATION)
    return {
      kind: CONVERSATION_CONTROL_CONDITION_KIND.RECONCILIATION_RESOLUTION,
      allowed_outcomes: [...CONVERSATION_CONTROL_RECONCILIATION_OUTCOMES],
    };
  return {
    kind: CONVERSATION_CONTROL_CONDITION_KIND.PARTICIPANT_QUIESCENT,
    allowed_outcomes: [...CONVERSATION_CONTROL_PARTICIPANT_OUTCOMES],
  };
}

function closeEffect(input: {
  target_operation_id: string;
  participant_id: string | null;
  adapter_fingerprint: string;
  effect_kind: ConversationControlEffectV1["effect_kind"];
  mode: ConversationControlEffectV1["mode"];
  reference_kind: ConversationNativeReferenceBindingV1["reference_kind"];
  authority_record_digest: string;
  private_reference_content_digest: string | null;
  expected_pre_effect_fold_digest: string;
  condition: ConversationControlConditionV1;
}): {
  effect: ConversationControlEffectV1;
  native: ConversationNativeReferenceBindingV1;
  postcondition: ConversationControlPostconditionBindingV1;
} {
  const effectId = controlEffectId(input);
  const native = materializeConversationNativeReferenceBinding({
    target_operation_id: input.target_operation_id,
    effect_id: effectId,
    participant_id: input.participant_id,
    adapter_fingerprint: input.adapter_fingerprint,
    reference_kind: input.reference_kind,
    authority_record_digest: input.authority_record_digest,
    private_reference_content_digest: input.private_reference_content_digest,
  });
  const postcondition = materializeConversationControlPostconditionBinding({
    target_operation_id: input.target_operation_id,
    effect_id: effectId,
    expected_pre_effect_fold_digest: input.expected_pre_effect_fold_digest,
    condition: input.condition,
  });
  const common = {
    effect_id: effectId,
    participant_id: input.participant_id,
    adapter_fingerprint: input.adapter_fingerprint,
    native_reference_digest: native.binding_digest,
    expected_control_postcondition_digest: postcondition.binding_digest,
  };
  const effect: ConversationControlEffectV1 =
    input.effect_kind === CONVERSATION_CONTROL_EFFECT_KIND.RECONCILE
      ? {
          ...common,
          effect_kind: CONVERSATION_CONTROL_EFFECT_KIND.RECONCILE,
          mode: input.mode as Extract<
            ConversationControlEffectV1,
            { effect_kind: typeof CONVERSATION_CONTROL_EFFECT_KIND.RECONCILE }
          >["mode"],
        }
      : {
          ...common,
          effect_kind: CONVERSATION_CONTROL_EFFECT_KIND.CANCEL_OR_PROVE_QUIESCENT,
          mode: input.mode as Extract<
            ConversationControlEffectV1,
            {
              effect_kind: typeof CONVERSATION_CONTROL_EFFECT_KIND.CANCEL_OR_PROVE_QUIESCENT;
            }
          >["mode"],
        };
  return { effect, native, postcondition };
}

export function materializeRevisionControlEffectClosure(input: {
  action_type: Exclude<
    ConversationControlActionTypeV1,
    typeof CONVERSATION_CONTROL_ACTION_TYPE.STOP_OPERATION
  >;
  operation: RevisionOperationV1;
  preparation: RevisionPreparationPlanV1;
  events: readonly RevisionOperationEventV1[];
  expected_pre_effect_fold_digest: string;
}): ConversationControlEffectClosureV1 {
  const receipts = latestReceipts(input.events);
  if (
    input.action_type === CONVERSATION_CONTROL_ACTION_TYPE.ABANDON_REVISION_OPERATION &&
    receipts.size !== 0
  )
    throw new Error("revision abandon effect closure contains participant effects");
  const participants =
    input.action_type === CONVERSATION_CONTROL_ACTION_TYPE.ABANDON_REVISION_OPERATION
      ? []
      : input.preparation.participant_starts.filter(({ participant_id }) =>
          receipts.has(participant_id),
        );
  if (
    input.action_type === CONVERSATION_CONTROL_ACTION_TYPE.RETRY_REVISION_OPERATION &&
    participants.length !== input.preparation.participant_starts.length
  )
    throw new Error("revision retry control effect closure is incomplete");
  const rows = participants.map((participant) => {
    const receipt = receipts.get(participant.participant_id);
    if (!receipt) throw new Error("revision control lane receipt disappeared");
    if (
      input.action_type === CONVERSATION_CONTROL_ACTION_TYPE.RETRY_REVISION_OPERATION &&
      receipt.state !== PUBLIC_OPERATION_PARTICIPANT_START_PHASE.FAILED &&
      receipt.state !== PUBLIC_OPERATION_PARTICIPANT_START_PHASE.CANCELED
    )
      throw new Error("revision retry control effect is not quiescent");
    const privateRef = receipt.private_native_session_ref ?? receipt.private_process_lease_ref;
    if (privateRef === null && receipt.state !== PUBLIC_OPERATION_PARTICIPANT_START_PHASE.FAILED)
      throw new Error("revision control lane lacks an exact native reference");
    const reconcile =
      input.action_type === CONVERSATION_CONTROL_ACTION_TYPE.RECONCILE_REVISION_OPERATION;
    return closeEffect({
      target_operation_id: input.operation.operation_id,
      participant_id: participant.participant_id,
      adapter_fingerprint: participant.adapter_fingerprint,
      effect_kind: reconcile
        ? CONVERSATION_CONTROL_EFFECT_KIND.RECONCILE
        : CONVERSATION_CONTROL_EFFECT_KIND.CANCEL_OR_PROVE_QUIESCENT,
      mode: reconcile ? participant.reconciliation_mode : participant.cancellation_mode,
      reference_kind: CONVERSATION_NATIVE_REFERENCE_KIND.PARTICIPANT_START_RECEIPT,
      authority_record_digest: receipt.receipt_digest,
      private_reference_content_digest: privateRef,
      expected_pre_effect_fold_digest: input.expected_pre_effect_fold_digest,
      condition: conditionFor(input.action_type),
    });
  });
  return {
    plan: materializeConversationControlEffectPlan({
      target_operation_id: input.operation.operation_id,
      effects: rows.map(({ effect }) => effect),
    }),
    native_references: rows.map(({ native }) => native),
    postconditions: rows.map(({ postcondition }) => postcondition),
  };
}

export function materializeStopControlEffectClosure(input: {
  target_operation_id: string;
  expected_operation_header_digest: string;
  expected_pre_effect_fold_digest: string;
}): ConversationControlEffectClosureV1 {
  const row = closeEffect({
    target_operation_id: input.target_operation_id,
    participant_id: null,
    adapter_fingerprint: CONVERSATION_CONTROL_HOST_CANCEL_ADAPTER_FINGERPRINT,
    effect_kind: CONVERSATION_CONTROL_EFFECT_KIND.CANCEL_OR_PROVE_QUIESCENT,
    mode: PARTICIPANT_CANCEL_MODE.IDEMPOTENT_CANCEL,
    reference_kind: CONVERSATION_NATIVE_REFERENCE_KIND.OPERATION_CANCEL_AUTHORITY,
    authority_record_digest: input.expected_operation_header_digest,
    private_reference_content_digest: null,
    expected_pre_effect_fold_digest: input.expected_pre_effect_fold_digest,
    condition: conditionFor(CONVERSATION_CONTROL_ACTION_TYPE.STOP_OPERATION),
  });
  return {
    plan: materializeConversationControlEffectPlan({
      target_operation_id: input.target_operation_id,
      effects: [row.effect],
    }),
    native_references: [row.native],
    postconditions: [row.postcondition],
  };
}
