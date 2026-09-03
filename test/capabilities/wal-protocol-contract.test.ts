import { describe, expect, test } from "bun:test";
import {
  ACTION_OPERATION_DISPATCH_REPLAY_STATES,
  ACTION_OPERATION_STATE,
  PUBLIC_OPERATION_FIXED_PHASE,
} from "../../src/actions/protocol-contract.js";
import {
  PUBLIC_ERROR_PRE_EFFECT_FRONTIER,
  PUBLIC_ERROR_PRE_EFFECT_REASON,
} from "../../src/actions/public-error-details-contract.js";
import {
  PUBLIC_TARGET_RESULT_HEALTH,
  PUBLIC_TARGET_RESULT_HEALTHS,
} from "../../src/actions/public-operation-contract.js";
import {
  POLICY_AUTHORITY_NEXT_STATE,
  POLICY_AUTHORITY_STATE,
  POLICY_AUTHORITY_STATES,
  type PolicyAuthorityStateV1,
  isPolicyAuthorityState,
} from "../../src/capabilities/authority/types.js";
import { adapterReceiptDigest } from "../../src/capabilities/operations/receipts.js";
import { validateCapabilityWalPayload } from "../../src/capabilities/storage/wal-payload-validation.js";
import {
  validateAdapterReceipt,
  validatePreEffectRefusal,
} from "../../src/capabilities/storage/wal-record-validation.js";
import {
  capabilityWalEventDigest,
  validateCapabilityWalEvent,
} from "../../src/capabilities/storage/wal-validation.js";
import {
  type AdapterReceiptV1,
  CAPABILITY_ADAPTER_RECEIPT_ACTIVE_STATES,
  CAPABILITY_ADAPTER_RECEIPT_NEXT_STATES,
  CAPABILITY_ADAPTER_RECEIPT_STATE,
  CAPABILITY_ADAPTER_RECEIPT_STATES,
  CAPABILITY_HEALTH_OUTCOME,
  CAPABILITY_HEALTH_OUTCOMES,
  CAPABILITY_OUTBOX_DELIVERIES,
  CAPABILITY_OUTBOX_DELIVERY,
  CAPABILITY_OUTBOX_DELIVERY_BY_TRANSITION,
  CAPABILITY_OUTBOX_PHASE,
  CAPABILITY_OUTBOX_PHASES,
  CAPABILITY_OUTBOX_TRANSITION,
  CAPABILITY_OUTBOX_TRANSITIONS,
  CAPABILITY_PRE_EFFECT_FRONTIER,
  CAPABILITY_PRE_EFFECT_FRONTIERS,
  CAPABILITY_PRE_EFFECT_OBSERVED_STATE,
  CAPABILITY_PRE_EFFECT_OBSERVED_STATES,
  CAPABILITY_PRE_EFFECT_OBSERVED_STATES_BY_REASON,
  CAPABILITY_PRE_EFFECT_REFUSAL_REASON,
  CAPABILITY_PRE_EFFECT_REFUSAL_REASONS,
  CAPABILITY_WAL_OPERATION_TRANSITION_FROM_STATES,
  CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN,
  CAPABILITY_WAL_PAYLOAD_KIND,
  CAPABILITY_WAL_PAYLOAD_KINDS,
  type CapabilityAdapterReceiptStateV1,
  type CapabilityHealthOutcomeV1,
  type CapabilityOutboxDeliveryV1,
  type CapabilityOutboxTransitionV1,
  type CapabilityPreEffectFrontierV1,
  type CapabilityPreEffectObservedStateV1,
  type CapabilityPreEffectRefusalReasonV1,
  type CapabilityWalEventV1,
  type CapabilityWalPayloadKindV1,
  type CapabilityWalPayloadV1,
  isCapabilityAdapterReceiptState,
  isCapabilityHealthOutcome,
  isCapabilityOutboxDelivery,
  isCapabilityOutboxPhase,
  isCapabilityOutboxTransition,
  isCapabilityPreEffectFrontier,
  isCapabilityPreEffectObservedState,
  isCapabilityPreEffectRefusalReason,
  isCapabilityWalOperationTransitionFrom,
  isCapabilityWalPayloadKind,
  isLegalCapabilityAdapterReceiptTransition,
} from "../../src/capabilities/wire/operation.js";

type Same<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
type ValueOf<RecordType> = RecordType[keyof RecordType];
const TEST_OPERATION_ID = "operation";
const FOREIGN_OPERATION_ID = "foreign-operation";

const exactDeliveryMapParity = Object.freeze({
  KEYS: true satisfies Same<
    keyof typeof CAPABILITY_OUTBOX_DELIVERY_BY_TRANSITION,
    CapabilityOutboxTransitionV1
  >,
  VALUES: true satisfies Same<
    ValueOf<typeof CAPABILITY_OUTBOX_DELIVERY_BY_TRANSITION>,
    CapabilityOutboxDeliveryV1
  >,
});

const exactDurableStateParity = Object.freeze({
  ADAPTER: true satisfies Same<
    AdapterReceiptV1["state"],
    ValueOf<typeof CAPABILITY_ADAPTER_RECEIPT_STATE>
  >,
  PRE_EFFECT_REASON: true satisfies Same<
    CapabilityPreEffectRefusalReasonV1,
    ValueOf<typeof CAPABILITY_PRE_EFFECT_REFUSAL_REASON>
  >,
  PRE_EFFECT_FRONTIER: true satisfies Same<
    CapabilityPreEffectFrontierV1,
    ValueOf<typeof CAPABILITY_PRE_EFFECT_FRONTIER>
  >,
  PRE_EFFECT_OBSERVED: true satisfies Same<
    CapabilityPreEffectObservedStateV1,
    ValueOf<typeof CAPABILITY_PRE_EFFECT_OBSERVED_STATE>
  >,
  HEALTH: true satisfies Same<CapabilityHealthOutcomeV1, ValueOf<typeof CAPABILITY_HEALTH_OUTCOME>>,
  WAL_KIND: true satisfies Same<CapabilityWalPayloadV1["kind"], CapabilityWalPayloadKindV1>,
  POLICY: true satisfies Same<PolicyAuthorityStateV1, ValueOf<typeof POLICY_AUTHORITY_STATE>>,
});

const outboxPayload = (): Extract<CapabilityWalPayloadV1, { kind: "outbox" }> => ({
  kind: "outbox",
  outbox_event_id: `vf-outbox-${"4".repeat(64)}`,
  payload_ref: `vf-outbox-payload-${"5".repeat(64)}`,
  phase: CAPABILITY_OUTBOX_PHASE.OPERATION_STARTED,
  phase_sequence: 0,
  public_payload_digest: `sha256:${"6".repeat(64)}`,
  transition: CAPABILITY_OUTBOX_TRANSITION.CREATED,
  delivery: CAPABILITY_OUTBOX_DELIVERY.PENDING,
});

const receiptForStateValidation = (): AdapterReceiptV1 => ({
  schema_version: "1.0",
  operation_id: "operation",
  plan_id: "plan",
  step_id: "step",
  target_ids: ["target"],
  source_authority_binding_digest: `sha256:${"1".repeat(64)}`,
  private_input_binding_digest: `sha256:${"2".repeat(64)}`,
  attempt: 0,
  state: CAPABILITY_ADAPTER_RECEIPT_STATE.PREPARED,
  authority_epoch: 1,
  authority_head_digest: `sha256:${"3".repeat(64)}`,
  policy_digest: `sha256:${"4".repeat(64)}`,
  grant_digest: `sha256:${"5".repeat(64)}`,
  permission_digest: `sha256:${"6".repeat(64)}`,
  observed_preimage_sha256: "7".repeat(64),
  observed_postimage_sha256: null,
  private_evidence_ref: null,
  bounded_evidence_digest: null,
  native_identifier_producer_receipt_digests: [],
  error_code: null,
  prepared_at: "2026-08-27T00:00:00.000Z",
  observed_at: null,
  receipt_digest: `sha256:${"8".repeat(64)}`,
});

const refusalForStateValidation = (): Extract<
  CapabilityWalPayloadV1,
  { kind: typeof CAPABILITY_WAL_PAYLOAD_KIND.PRE_EFFECT_REFUSAL }
>["refusal"] => ({
  schema_version: "1.0",
  operation_id: "operation",
  frontier_kind: CAPABILITY_PRE_EFFECT_FRONTIER.ADAPTER_STEP,
  plan_id: "plan",
  step_id: "step",
  target_ids: ["target"],
  reason_code: CAPABILITY_PRE_EFFECT_REFUSAL_REASON.OWNED_PREIMAGE_STALE,
  binding_key: "ownership:key",
  expected_digest: `sha256:${"9".repeat(64)}`,
  observed_digest: null,
  observed_state: CAPABILITY_PRE_EFFECT_OBSERVED_STATE.ABSENT,
  checked_at: "2026-08-27T00:00:00.000Z",
  observation_digest: `sha256:${"a".repeat(64)}`,
});

function redigestedReceipt(operationId: string): AdapterReceiptV1 {
  const draft = {
    ...receiptForStateValidation(),
    operation_id: operationId,
    receipt_digest: "",
  };
  return { ...draft, receipt_digest: adapterReceiptDigest(draft) };
}

function redigestedWalEvent(payload: CapabilityWalPayloadV1): CapabilityWalEventV1 {
  const draft = {
    schema_version: "1.0" as const,
    operation_id: TEST_OPERATION_ID,
    sequence: 1,
    previous_event_digest: `sha256:${"b".repeat(64)}`,
    payload,
    recorded_at: "2026-08-27T00:00:00.000Z",
    event_digest: "",
  };
  return { ...draft, event_digest: capabilityWalEventDigest(draft) };
}

describe("capability WAL protocol aliases", () => {
  test("aliases public pre-effect and health authorities by runtime identity", () => {
    expect(CAPABILITY_PRE_EFFECT_REFUSAL_REASON).toBe(PUBLIC_ERROR_PRE_EFFECT_REASON);
    expect(CAPABILITY_PRE_EFFECT_FRONTIER).toBe(PUBLIC_ERROR_PRE_EFFECT_FRONTIER);
    expect(CAPABILITY_HEALTH_OUTCOME).toBe(PUBLIC_TARGET_RESULT_HEALTH);
    expect(CAPABILITY_HEALTH_OUTCOMES).toBe(PUBLIC_TARGET_RESULT_HEALTHS);
    expect(Object.values(exactDurableStateParity).every(Boolean)).toBe(true);
  });

  test("freezes total adapter and policy transition authorities", () => {
    expect(Object.keys(CAPABILITY_ADAPTER_RECEIPT_NEXT_STATES).sort()).toEqual(
      [...CAPABILITY_ADAPTER_RECEIPT_STATES].sort(),
    );
    expect(Object.keys(POLICY_AUTHORITY_NEXT_STATE).sort()).toEqual(
      [...POLICY_AUTHORITY_STATES].sort(),
    );
    for (const value of [
      CAPABILITY_ADAPTER_RECEIPT_STATE,
      CAPABILITY_ADAPTER_RECEIPT_STATES,
      CAPABILITY_ADAPTER_RECEIPT_ACTIVE_STATES,
      CAPABILITY_ADAPTER_RECEIPT_NEXT_STATES,
      CAPABILITY_PRE_EFFECT_REFUSAL_REASON,
      CAPABILITY_PRE_EFFECT_REFUSAL_REASONS,
      CAPABILITY_PRE_EFFECT_FRONTIER,
      CAPABILITY_PRE_EFFECT_FRONTIERS,
      CAPABILITY_PRE_EFFECT_OBSERVED_STATE,
      CAPABILITY_PRE_EFFECT_OBSERVED_STATES,
      CAPABILITY_PRE_EFFECT_OBSERVED_STATES_BY_REASON,
      CAPABILITY_WAL_PAYLOAD_KIND,
      CAPABILITY_WAL_PAYLOAD_KINDS,
      CAPABILITY_HEALTH_OUTCOME,
      CAPABILITY_HEALTH_OUTCOMES,
      POLICY_AUTHORITY_STATE,
      POLICY_AUTHORITY_STATES,
      POLICY_AUTHORITY_NEXT_STATE,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    for (const states of Object.values(CAPABILITY_ADAPTER_RECEIPT_NEXT_STATES))
      expect(Object.isFrozen(states)).toBe(true);
    for (const states of Object.values(CAPABILITY_PRE_EFFECT_OBSERVED_STATES_BY_REASON))
      expect(Object.isFrozen(states)).toBe(true);

    expect(
      isLegalCapabilityAdapterReceiptTransition(
        undefined,
        CAPABILITY_ADAPTER_RECEIPT_STATE.PREPARED,
      ),
    ).toBe(true);
    for (const [prior, nextStates] of Object.entries(CAPABILITY_ADAPTER_RECEIPT_NEXT_STATES))
      for (const next of nextStates)
        expect(
          isLegalCapabilityAdapterReceiptTransition(prior as CapabilityAdapterReceiptStateV1, next),
        ).toBe(true);
  });

  test("rejects unknown and prototype-like durable state vocabulary", () => {
    const invalidValues: unknown[] = [
      "not-in-contract",
      "toString",
      "__proto__",
      "constructor",
      "toString:x",
      "",
      null,
      1,
    ];
    for (const invalid of invalidValues) {
      expect(isCapabilityAdapterReceiptState(invalid)).toBe(false);
      expect(isCapabilityPreEffectRefusalReason(invalid)).toBe(false);
      expect(isCapabilityPreEffectFrontier(invalid)).toBe(false);
      expect(isCapabilityPreEffectObservedState(invalid)).toBe(false);
      expect(isCapabilityWalPayloadKind(invalid)).toBe(false);
      expect(isCapabilityHealthOutcome(invalid)).toBe(false);
      expect(isPolicyAuthorityState(invalid)).toBe(false);
    }
    expect(() =>
      validateCapabilityWalPayload(
        { kind: "__proto__" } as unknown as CapabilityWalPayloadV1,
        TEST_OPERATION_ID,
      ),
    ).toThrow("unknown capability WAL payload kind");
    expect(() =>
      validateCapabilityWalPayload(
        {
          kind: CAPABILITY_WAL_PAYLOAD_KIND.HEALTH,
          plan_id: "plan",
          observation_digest: `sha256:${"b".repeat(64)}`,
          target_id: "target",
          probe_id: "probe",
          outcome: "constructor",
          checked_at: "2026-08-27T00:00:00.000Z",
          expires_at: "2026-08-27T00:01:00.000Z",
          evidence_digest: `sha256:${"c".repeat(64)}`,
        } as unknown as CapabilityWalPayloadV1,
        TEST_OPERATION_ID,
      ),
    ).toThrow("invalid enum value");
    expect(() =>
      validateAdapterReceipt(
        { ...receiptForStateValidation(), state: "toString" } as unknown as AdapterReceiptV1,
        "receipt",
        TEST_OPERATION_ID,
      ),
    ).toThrow("invalid enum value");
    expect(() =>
      validatePreEffectRefusal(
        {
          ...refusalForStateValidation(),
          observed_state: "__proto__",
        } as unknown as ReturnType<typeof refusalForStateValidation>,
        "refusal",
        TEST_OPERATION_ID,
      ),
    ).toThrow("invalid enum value");
  });

  test("rejects re-digested receipts and refusals owned by another operation", () => {
    const foreignReceiptEvent = redigestedWalEvent({
      kind: CAPABILITY_WAL_PAYLOAD_KIND.ADAPTER_STEP,
      receipt: redigestedReceipt(FOREIGN_OPERATION_ID),
    });
    const foreignRefusalEvent = redigestedWalEvent({
      kind: CAPABILITY_WAL_PAYLOAD_KIND.PRE_EFFECT_REFUSAL,
      refusal: {
        ...refusalForStateValidation(),
        operation_id: FOREIGN_OPERATION_ID,
      },
    });

    for (const event of [foreignReceiptEvent, foreignRefusalEvent]) {
      expect(event.event_digest).toBe(capabilityWalEventDigest(event));
      expect(() => validateCapabilityWalEvent(event, TEST_OPERATION_ID)).toThrow(
        /embedded operation identity mismatch/i,
      );
    }
  });

  test("freezes canonical public phases and action-state subsets without redeclaration", () => {
    expect(CAPABILITY_OUTBOX_PHASES).toEqual(Object.values(CAPABILITY_OUTBOX_PHASE));
    expect(CAPABILITY_OUTBOX_PHASES).toEqual([
      PUBLIC_OPERATION_FIXED_PHASE.OPERATION_STARTED,
      PUBLIC_OPERATION_FIXED_PHASE.TARGET_APPLIED,
      PUBLIC_OPERATION_FIXED_PHASE.TARGET_OMITTED,
      PUBLIC_OPERATION_FIXED_PHASE.TARGET_REVERSED,
      PUBLIC_OPERATION_FIXED_PHASE.TARGET_DEGRADED,
      PUBLIC_OPERATION_FIXED_PHASE.TARGET_FAILED,
      PUBLIC_OPERATION_FIXED_PHASE.TARGET_BLOCKED,
      PUBLIC_OPERATION_FIXED_PHASE.TARGET_NEEDS_RECOVERY,
      PUBLIC_OPERATION_FIXED_PHASE.OPERATION_SUCCEEDED,
      PUBLIC_OPERATION_FIXED_PHASE.OPERATION_FAILED,
      PUBLIC_OPERATION_FIXED_PHASE.OPERATION_NEEDS_RECOVERY,
    ]);
    expect(CAPABILITY_WAL_OPERATION_TRANSITION_FROM_STATES).toEqual([
      CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN.CREATED,
      ...ACTION_OPERATION_DISPATCH_REPLAY_STATES,
    ]);
    for (const value of [
      CAPABILITY_OUTBOX_PHASE,
      CAPABILITY_OUTBOX_PHASES,
      CAPABILITY_OUTBOX_TRANSITION,
      CAPABILITY_OUTBOX_TRANSITIONS,
      CAPABILITY_OUTBOX_DELIVERY,
      CAPABILITY_OUTBOX_DELIVERIES,
      CAPABILITY_OUTBOX_DELIVERY_BY_TRANSITION,
      CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN,
      CAPABILITY_WAL_OPERATION_TRANSITION_FROM_STATES,
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });

  test("keeps transition-to-delivery mapping total and guards every persisted vocabulary", () => {
    expect(Object.values(exactDeliveryMapParity).every(Boolean)).toBe(true);
    expect(CAPABILITY_OUTBOX_DELIVERY_BY_TRANSITION).toEqual({
      [CAPABILITY_OUTBOX_TRANSITION.CREATED]: CAPABILITY_OUTBOX_DELIVERY.PENDING,
      [CAPABILITY_OUTBOX_TRANSITION.DELIVERED]: CAPABILITY_OUTBOX_DELIVERY.DELIVERED,
      [CAPABILITY_OUTBOX_TRANSITION.DELIVERY_FAILED]: CAPABILITY_OUTBOX_DELIVERY.FAILED,
    });
    expect(CAPABILITY_OUTBOX_PHASES.every(isCapabilityOutboxPhase)).toBe(true);
    expect(CAPABILITY_OUTBOX_TRANSITIONS.every(isCapabilityOutboxTransition)).toBe(true);
    expect(CAPABILITY_OUTBOX_DELIVERIES.every(isCapabilityOutboxDelivery)).toBe(true);
    expect(
      CAPABILITY_WAL_OPERATION_TRANSITION_FROM_STATES.every(isCapabilityWalOperationTransitionFrom),
    ).toBe(true);
    for (const invalid of ["not-in-contract", "", null, 1]) {
      expect(isCapabilityOutboxPhase(invalid)).toBe(false);
      expect(isCapabilityOutboxTransition(invalid)).toBe(false);
      expect(isCapabilityOutboxDelivery(invalid)).toBe(false);
      expect(isCapabilityWalOperationTransitionFrom(invalid)).toBe(false);
    }
  });

  test("validates persisted transition, phase, and delivery values through shared lists", () => {
    expect(() =>
      validateCapabilityWalPayload(
        {
          kind: "operation-transition",
          from: CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN.CREATED,
          to: ACTION_OPERATION_STATE.COMMITTING,
          reason_code: null,
        },
        TEST_OPERATION_ID,
      ),
    ).not.toThrow();
    expect(() => validateCapabilityWalPayload(outboxPayload(), TEST_OPERATION_ID)).not.toThrow();

    const invalidTransition = {
      kind: "operation-transition",
      from: "not-in-contract",
      to: "approved",
      reason_code: null,
    } as unknown as CapabilityWalPayloadV1;
    expect(() => validateCapabilityWalPayload(invalidTransition, TEST_OPERATION_ID)).toThrow(
      "invalid enum value",
    );
    expect(() =>
      validateCapabilityWalPayload(
        {
          ...outboxPayload(),
          phase: "dispatch",
        } as unknown as CapabilityWalPayloadV1,
        TEST_OPERATION_ID,
      ),
    ).toThrow("invalid enum value");
    expect(() =>
      validateCapabilityWalPayload(
        {
          ...outboxPayload(),
          transition: CAPABILITY_OUTBOX_TRANSITION.DELIVERED,
        },
        TEST_OPERATION_ID,
      ),
    ).toThrow("invalid outbox transition/delivery pair");
  });
});
