import type {
  CapabilityEffectBrokerV1,
  CapabilityEffectDescriptorV1,
  CapabilityPrivateEffectPayloadV1,
} from "../adapters/types.js";
import {
  CAPABILITY_ADAPTER_RECEIPT_STATE,
  CAPABILITY_OPERATION_RECOVERY_PHASE,
  type CapabilityAdapterReceiptEvidenceStateV1,
  type CapabilityAdapterReceiptReconciliationStateV1,
  type CapabilityOperationRecoveryPhaseV1,
} from "../wire/operation.js";

export function reconcileCrashPartialEffect(input: {
  state: CapabilityAdapterReceiptReconciliationStateV1;
  phase: CapabilityOperationRecoveryPhaseV1;
  observed: string | null;
  descriptor: CapabilityEffectDescriptorV1;
  privatePayload: CapabilityPrivateEffectPayloadV1;
  broker: CapabilityEffectBrokerV1;
}): CapabilityAdapterReceiptEvidenceStateV1 {
  const { phase, observed, descriptor, privatePayload, broker } = input;
  const postimage = descriptor.resource.expected_postimage_sha256;
  if (phase === CAPABILITY_OPERATION_RECOVERY_PHASE.FORWARD && observed === postimage) {
    try {
      broker.reconcile(descriptor, privatePayload, CAPABILITY_OPERATION_RECOVERY_PHASE.FORWARD);
      return CAPABILITY_ADAPTER_RECEIPT_STATE.APPLIED;
    } catch {
      return CAPABILITY_ADAPTER_RECEIPT_STATE.UNCERTAIN;
    }
  }
  try {
    broker.reconcile(descriptor, privatePayload, CAPABILITY_OPERATION_RECOVERY_PHASE.ROLLBACK);
    return phase === CAPABILITY_OPERATION_RECOVERY_PHASE.ROLLBACK
      ? CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSED
      : CAPABILITY_ADAPTER_RECEIPT_STATE.FAILED;
  } catch {
    return CAPABILITY_ADAPTER_RECEIPT_STATE.UNCERTAIN;
  }
}
