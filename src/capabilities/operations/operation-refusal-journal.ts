import { digestV1 } from "../../durability/index.js";
import type { CapabilityFabricPlanV1, CapabilityRuntimeAuthorityV1 } from "../planning/types.js";
import type { CapabilityScopeLockV1 } from "../storage/scope-lock.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import {
  CAPABILITY_PRE_EFFECT_AUTHORITY_REFUSAL_REASONS,
  CAPABILITY_PRE_EFFECT_FRONTIER,
  CAPABILITY_PRE_EFFECT_OBSERVED_STATE,
  CAPABILITY_PRE_EFFECT_REFUSAL_REASON,
  CAPABILITY_WAL_PAYLOAD_KIND,
  type CapabilityPreEffectFrontierV1,
  type CapabilityPreEffectObservedStateV1,
  type CapabilityPreEffectRefusalReasonV1,
  type CapabilityWalEventV1,
  type CapabilityWalPayloadV1,
} from "../wire/operation.js";
import { bytewise } from "../wire/primitives.js";
import type { CapabilityAuthorityRefusalCheckV1 } from "./authority-frontier.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "./errors.js";
import { persistCapabilityPreEffectObservation } from "./refusal-evidence.js";
import type { CapabilityRuntimeFaultPointV1 } from "./types.js";

export interface CapabilityRefusalAppendInputV1 {
  operationId: string;
  plan: CapabilityFabricPlanV1;
  reason: CapabilityPreEffectRefusalReasonV1;
  planId: string | null;
  stepId: string | null;
  targetIds: string[];
  held: CapabilityScopeLockV1;
  frontier?: CapabilityPreEffectFrontierV1;
  bindingKey?: string;
  expectedDigest?: string | null;
  observedDigest?: string | null;
  observedState?: CapabilityPreEffectObservedStateV1;
  expectedSupport?: unknown;
  observedSupport?: unknown | null;
  authorityCheck?: CapabilityAuthorityRefusalCheckV1;
}

interface CapabilityRefusalJournalOptionsV1 {
  storage: CapabilityStorageV1;
  now: () => string;
  fault?: (point: CapabilityRuntimeFaultPointV1) => void;
}

type AppendWalEventV1 = (
  operationId: string,
  payload: CapabilityWalPayloadV1,
  held: CapabilityScopeLockV1,
  recordedAt?: string,
) => CapabilityWalEventV1;

const authorityPair = (value: CapabilityRuntimeAuthorityV1): string =>
  digestV1("VF-CAPABILITY-PRE-EFFECT-AUTHORITY\0v1\0", {
    schema_version: "1.0",
    authority_epoch: value.authority_epoch,
    authority_head_digest: value.authority_head_digest,
  });

const DEFAULT_BINDING_KEY_BY_REASON = Object.freeze({
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.SCOPE_BASE_STALE]: "scope",
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.AUTHORITY_HEAD_STALE]: "general-authority",
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.POLICY_STALE]: "policy",
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.GRANT_STALE]: "grant:aggregate",
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.PERMISSION_STALE]: "permission:aggregate",
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.USER_PREREQUISITE_STALE]: "prerequisite:aggregate",
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.SOURCE_AUTHORITY_STALE]: "source:aggregate",
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.PRIVATE_INPUT_STALE]: "private-input:aggregate",
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.ENFORCEMENT_STALE]: "enforcement:aggregate",
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.OWNED_PREIMAGE_STALE]: "ownership:aggregate",
} satisfies Record<CapabilityPreEffectRefusalReasonV1, string>);

function defaultBindingKey(reason: CapabilityPreEffectRefusalReasonV1): string {
  return DEFAULT_BINDING_KEY_BY_REASON[reason];
}

export function appendCapabilityRefusal(
  options: CapabilityRefusalJournalOptionsV1,
  append: AppendWalEventV1,
  input: CapabilityRefusalAppendInputV1,
): void {
  const { operationId, plan, reason, planId, stepId, targetIds, held } = input;
  const expectedAuthority = plan.runtime_closure.authority;
  const authorityReason = CAPABILITY_PRE_EFFECT_AUTHORITY_REFUSAL_REASONS.some(
    (candidate) => candidate === reason,
  );
  if (
    authorityReason !== Boolean(input.authorityCheck) ||
    (input.authorityCheck && input.authorityCheck.reason !== reason)
  )
    throw new CapabilityRuntimeError(
      "pre-effect refusal lacks its exact authority decision snapshot",
      CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
    );
  const observed = input.authorityCheck?.observed;
  const currentLock = options.storage.readStatus().lock;
  const defaultDigests: [string | null, string | null] =
    reason === CAPABILITY_PRE_EFFECT_REFUSAL_REASON.SCOPE_BASE_STALE
      ? [plan.base_lock_digest, currentLock?.content_digest ?? null]
      : reason === CAPABILITY_PRE_EFFECT_REFUSAL_REASON.AUTHORITY_HEAD_STALE
        ? [authorityPair(expectedAuthority), authorityPair(observed as typeof expectedAuthority)]
        : reason === CAPABILITY_PRE_EFFECT_REFUSAL_REASON.POLICY_STALE
          ? [expectedAuthority.policy_digest, observed?.policy_digest ?? null]
          : reason === CAPABILITY_PRE_EFFECT_REFUSAL_REASON.GRANT_STALE
            ? [expectedAuthority.grant_digest, observed?.grant_digest ?? null]
            : reason === CAPABILITY_PRE_EFFECT_REFUSAL_REASON.PERMISSION_STALE
              ? [expectedAuthority.permission_digest, observed?.permission_digest ?? null]
              : reason === CAPABILITY_PRE_EFFECT_REFUSAL_REASON.SOURCE_AUTHORITY_STALE
                ? [plan.source_authority_set_digest, observed?.source_authority_set_digest ?? null]
                : [null, null];
  const expectedDigest =
    input.expectedDigest === undefined ? defaultDigests[0] : input.expectedDigest;
  const observedDigest =
    input.observedDigest === undefined ? defaultDigests[1] : input.observedDigest;
  const checkedAt = input.authorityCheck?.checked_at ?? options.now();
  const frontier = input.frontier ?? CAPABILITY_PRE_EFFECT_FRONTIER.ADAPTER_STEP;
  const adapterPlan = planId
    ? plan.adapter_plans.find((candidate) => candidate.plan_id === planId)
    : null;
  const observation = persistCapabilityPreEffectObservation({
    storage: options.storage,
    held,
    value: {
      operation_id: operationId,
      frontier_kind: frontier,
      plan_id: planId,
      step_id: stepId,
      checked_at: checkedAt,
      row: {
        reason_code: reason,
        plan_order: adapterPlan ? plan.adapter_plans.indexOf(adapterPlan) : null,
        unit_order:
          stepId === null
            ? null
            : (adapterPlan?.steps.find((step) => step.step_id === stepId)?.order ?? null),
        binding_key: input.bindingKey ?? defaultBindingKey(reason),
        target_ids: [...targetIds].sort(bytewise),
        expected_digest: expectedDigest,
        observed_digest: observedDigest,
        observed_state:
          input.observedState ??
          (observedDigest === null
            ? CAPABILITY_PRE_EFFECT_OBSERVED_STATE.ABSENT
            : CAPABILITY_PRE_EFFECT_OBSERVED_STATE.CHANGED),
      },
      expected_source_support:
        reason === CAPABILITY_PRE_EFFECT_REFUSAL_REASON.SOURCE_AUTHORITY_STALE
          ? (input.expectedSupport ?? {
              schema_version: "1.0",
              source_authority_set_digest: plan.source_authority_set_digest,
            })
          : null,
      observed_source_support:
        reason === CAPABILITY_PRE_EFFECT_REFUSAL_REASON.SOURCE_AUTHORITY_STALE
          ? (input.observedSupport ?? {
              schema_version: "1.0",
              source_authority_set_digest: observed?.source_authority_set_digest ?? null,
            })
          : null,
      expected_user_prerequisite_support:
        reason === CAPABILITY_PRE_EFFECT_REFUSAL_REASON.USER_PREREQUISITE_STALE
          ? (input.expectedSupport ?? null)
          : null,
      observed_user_prerequisite_support:
        reason === CAPABILITY_PRE_EFFECT_REFUSAL_REASON.USER_PREREQUISITE_STALE
          ? (input.observedSupport ?? null)
          : null,
      expected_private_broker_state:
        reason === CAPABILITY_PRE_EFFECT_REFUSAL_REASON.PRIVATE_INPUT_STALE
          ? (input.expectedSupport ?? null)
          : null,
      observed_private_broker_state:
        reason === CAPABILITY_PRE_EFFECT_REFUSAL_REASON.PRIVATE_INPUT_STALE
          ? (input.observedSupport ?? null)
          : null,
    },
  });
  options.fault?.("after-refusal-observation");
  append(
    operationId,
    {
      kind: CAPABILITY_WAL_PAYLOAD_KIND.PRE_EFFECT_REFUSAL,
      refusal: {
        schema_version: "1.0",
        operation_id: observation.operation_id,
        frontier_kind: observation.frontier_kind,
        plan_id: observation.plan_id,
        step_id: observation.step_id,
        target_ids: observation.row.target_ids,
        reason_code: observation.row.reason_code,
        binding_key: observation.row.binding_key,
        expected_digest: observation.row.expected_digest,
        observed_digest: observation.row.observed_digest,
        observed_state: observation.row.observed_state,
        checked_at: observation.checked_at,
        observation_digest: observation.observation_digest,
      },
    },
    held,
    checkedAt,
  );
  options.fault?.("after-refusal");
}
