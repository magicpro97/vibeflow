import { digestV1 } from "../../durability/index.js";
import type { CapabilityFabricPlanV1, CapabilityRuntimeAuthorityV1 } from "../planning/types.js";
import type { CapabilityScopeLockV1 } from "../storage/scope-lock.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import type {
  CapabilityPreEffectRefusalReasonV1,
  CapabilityWalEventV1,
  CapabilityWalPayloadV1,
} from "../wire/operation.js";
import { bytewise } from "../wire/primitives.js";
import type { CapabilityAuthorityRefusalCheckV1 } from "./authority-frontier.js";
import { CapabilityRuntimeError } from "./errors.js";
import {
  type CapabilityPreEffectObservedStateV1,
  persistCapabilityPreEffectObservation,
} from "./refusal-evidence.js";
import type { CapabilityRuntimeFaultPointV1 } from "./types.js";

export interface CapabilityRefusalAppendInputV1 {
  operationId: string;
  plan: CapabilityFabricPlanV1;
  reason: CapabilityPreEffectRefusalReasonV1;
  planId: string | null;
  stepId: string | null;
  targetIds: string[];
  held: CapabilityScopeLockV1;
  frontier?: "operation" | "adapter-step" | "health-batch" | "lock-publication";
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

function defaultBindingKey(reason: CapabilityPreEffectRefusalReasonV1): string {
  return (
    {
      "scope-base-stale": "scope",
      "authority-head-stale": "general-authority",
      "policy-stale": "policy",
      "grant-stale": "grant:aggregate",
      "permission-stale": "permission:aggregate",
      "user-prerequisite-stale": "prerequisite:aggregate",
      "source-authority-stale": "source:aggregate",
      "private-input-stale": "private-input:aggregate",
      "enforcement-stale": "enforcement:aggregate",
      "owned-preimage-stale": "ownership:aggregate",
    } satisfies Record<CapabilityPreEffectRefusalReasonV1, string>
  )[reason];
}

export function appendCapabilityRefusal(
  options: CapabilityRefusalJournalOptionsV1,
  append: AppendWalEventV1,
  input: CapabilityRefusalAppendInputV1,
): void {
  const { operationId, plan, reason, planId, stepId, targetIds, held } = input;
  const expectedAuthority = plan.runtime_closure.authority;
  const authorityReasons: readonly CapabilityPreEffectRefusalReasonV1[] = [
    "authority-head-stale",
    "policy-stale",
    "grant-stale",
    "permission-stale",
    "source-authority-stale",
  ];
  const authorityReason = authorityReasons.includes(reason);
  if (
    authorityReason !== Boolean(input.authorityCheck) ||
    (input.authorityCheck && input.authorityCheck.reason !== reason)
  )
    throw new CapabilityRuntimeError(
      "pre-effect refusal lacks its exact authority decision snapshot",
      "integrity-failure",
    );
  const observed = input.authorityCheck?.observed;
  const currentLock = options.storage.readStatus().lock;
  const defaultDigests: [string | null, string | null] =
    reason === "scope-base-stale"
      ? [plan.base_lock_digest, currentLock?.content_digest ?? null]
      : reason === "authority-head-stale"
        ? [authorityPair(expectedAuthority), authorityPair(observed as typeof expectedAuthority)]
        : reason === "policy-stale"
          ? [expectedAuthority.policy_digest, observed?.policy_digest ?? null]
          : reason === "grant-stale"
            ? [expectedAuthority.grant_digest, observed?.grant_digest ?? null]
            : reason === "permission-stale"
              ? [expectedAuthority.permission_digest, observed?.permission_digest ?? null]
              : reason === "source-authority-stale"
                ? [plan.source_authority_set_digest, observed?.source_authority_set_digest ?? null]
                : [null, null];
  const expectedDigest =
    input.expectedDigest === undefined ? defaultDigests[0] : input.expectedDigest;
  const observedDigest =
    input.observedDigest === undefined ? defaultDigests[1] : input.observedDigest;
  const checkedAt = input.authorityCheck?.checked_at ?? options.now();
  const frontier = input.frontier ?? "adapter-step";
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
        observed_state: input.observedState ?? (observedDigest === null ? "absent" : "changed"),
      },
      expected_source_support:
        reason === "source-authority-stale"
          ? (input.expectedSupport ?? {
              schema_version: "1.0",
              source_authority_set_digest: plan.source_authority_set_digest,
            })
          : null,
      observed_source_support:
        reason === "source-authority-stale"
          ? (input.observedSupport ?? {
              schema_version: "1.0",
              source_authority_set_digest: observed?.source_authority_set_digest ?? null,
            })
          : null,
      expected_user_prerequisite_support:
        reason === "user-prerequisite-stale" ? (input.expectedSupport ?? null) : null,
      observed_user_prerequisite_support:
        reason === "user-prerequisite-stale" ? (input.observedSupport ?? null) : null,
      expected_private_broker_state:
        reason === "private-input-stale" ? (input.expectedSupport ?? null) : null,
      observed_private_broker_state:
        reason === "private-input-stale" ? (input.observedSupport ?? null) : null,
    },
  });
  options.fault?.("after-refusal-observation");
  append(
    operationId,
    {
      kind: "pre-effect-refusal",
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
