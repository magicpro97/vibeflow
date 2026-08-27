import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import { ACTION_OPERATION_STATE } from "../../actions/protocol-contract.js";
import { PUBLIC_ACTION_SCHEMA_VERSION } from "../../actions/public-action-contract.js";
import { ENGINE_ATTEMPT_START_OUTCOME } from "../../dispatch/session-contract.js";
import { digestV1 } from "../../durability/index.js";
import {
  type ParticipantCancelModeV1,
  type ParticipantStartReconciliationModeV1,
  isParticipantCancelModeV1,
  isParticipantStartReconciliationModeV1,
} from "./revision-participant-receipt.js";

type ValueOf<Contract> = Contract[keyof Contract];

export const CONVERSATION_CONTROL_ACTION_TYPE = Object.freeze({
  STOP_OPERATION: HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION,
  ABANDON_REVISION_OPERATION: HOST_ACTION_KIND.CONVERSATION_ABANDON_REVISION_OPERATION,
  RETRY_REVISION_OPERATION: HOST_ACTION_KIND.CONVERSATION_RETRY_REVISION_OPERATION,
  RECONCILE_REVISION_OPERATION: HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION,
} as const);
export type ConversationControlActionTypeV1 = ValueOf<typeof CONVERSATION_CONTROL_ACTION_TYPE>;

export const CONVERSATION_CONTROL_EFFECT_KIND = Object.freeze({
  CANCEL_OR_PROVE_QUIESCENT: "cancel-or-prove-quiescent",
  RECONCILE: "reconcile",
} as const);
export const CONVERSATION_CONTROL_HOST_CANCEL_ADAPTER_FINGERPRINT =
  "vf-host-operation-cancel/1" as const;
export const CONVERSATION_NATIVE_REFERENCE_KIND = Object.freeze({
  OPERATION_CANCEL_AUTHORITY: "operation-cancel-authority",
  PARTICIPANT_START_RECEIPT: "participant-start-receipt",
} as const);
export const CONVERSATION_NATIVE_REFERENCE_KINDS = Object.freeze(
  Object.values(CONVERSATION_NATIVE_REFERENCE_KIND),
);
export const CONVERSATION_CONTROL_CONDITION_KIND = Object.freeze({
  OPERATION_TERMINAL: "operation-terminal",
  PARTICIPANT_QUIESCENT: "participant-quiescent",
  RECONCILIATION_RESOLUTION: "reconciliation-resolution",
} as const);
export const CONVERSATION_CONTROL_OPERATION_TERMINAL_STATES = Object.freeze([
  ACTION_OPERATION_STATE.SUCCEEDED,
  ACTION_OPERATION_STATE.FAILED,
  ACTION_OPERATION_STATE.CANCELED,
  ACTION_OPERATION_STATE.NEEDS_RECOVERY,
] as const);
export const CONVERSATION_CONTROL_PARTICIPANT_OUTCOMES = Object.freeze([
  "canceled",
  "failed",
  ENGINE_ATTEMPT_START_OUTCOME.PROVED_ABSENT,
] as const);
export const CONVERSATION_CONTROL_RECONCILIATION_OUTCOMES = Object.freeze([
  "present",
  "absent",
  "unknown",
] as const);

export type ConversationControlEffectV1 = {
  effect_id: string;
  participant_id: string | null;
  adapter_fingerprint: string;
  native_reference_digest: string;
  expected_control_postcondition_digest: string;
} & (
  | {
      effect_kind: typeof CONVERSATION_CONTROL_EFFECT_KIND.CANCEL_OR_PROVE_QUIESCENT;
      mode: ParticipantCancelModeV1;
    }
  | {
      effect_kind: typeof CONVERSATION_CONTROL_EFFECT_KIND.RECONCILE;
      mode: ParticipantStartReconciliationModeV1;
    }
);

export interface ConversationControlEffectPlanV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  target_operation_id: string;
  effects: ConversationControlEffectV1[];
  cleanup_artifact_digests: string[];
  plan_digest: string;
}

export interface ConversationNativeReferenceBindingV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  target_operation_id: string;
  effect_id: string;
  participant_id: string | null;
  adapter_fingerprint: string;
  reference_kind: ValueOf<typeof CONVERSATION_NATIVE_REFERENCE_KIND>;
  authority_record_digest: string;
  private_reference_content_digest: string | null;
  binding_digest: string;
}

export type ConversationControlConditionV1 =
  | {
      kind: typeof CONVERSATION_CONTROL_CONDITION_KIND.OPERATION_TERMINAL;
      allowed_states: Array<(typeof CONVERSATION_CONTROL_OPERATION_TERMINAL_STATES)[number]>;
    }
  | {
      kind: typeof CONVERSATION_CONTROL_CONDITION_KIND.PARTICIPANT_QUIESCENT;
      allowed_outcomes: Array<(typeof CONVERSATION_CONTROL_PARTICIPANT_OUTCOMES)[number]>;
    }
  | {
      kind: typeof CONVERSATION_CONTROL_CONDITION_KIND.RECONCILIATION_RESOLUTION;
      allowed_outcomes: Array<(typeof CONVERSATION_CONTROL_RECONCILIATION_OUTCOMES)[number]>;
    };

export interface ConversationControlPostconditionBindingV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  target_operation_id: string;
  effect_id: string;
  expected_pre_effect_fold_digest: string;
  condition: ConversationControlConditionV1;
  binding_digest: string;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const EFFECT = /^vf-control-effect-[0-9a-f]{64}$/;

function exact(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function bounded(value: unknown, max = 200): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= max;
}

export function controlEffectId(input: {
  target_operation_id: string;
  participant_id: string | null;
  adapter_fingerprint: string;
  effect_kind: ConversationControlEffectV1["effect_kind"];
  mode: ConversationControlEffectV1["mode"];
}): string {
  const preimage = {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    target_operation_id: input.target_operation_id,
    participant_id: input.participant_id,
    adapter_fingerprint: input.adapter_fingerprint,
    effect_kind: input.effect_kind,
    mode: input.mode,
  };
  return `vf-control-effect-${digestV1("VF-CONVERSATION-CONTROL-EFFECT-ID\0v1\0", {
    ...preimage,
  }).slice(7)}`;
}

export function materializeConversationNativeReferenceBinding(
  input: Omit<ConversationNativeReferenceBindingV1, "schema_version" | "binding_digest">,
): ConversationNativeReferenceBindingV1 {
  const preimage = { schema_version: PUBLIC_ACTION_SCHEMA_VERSION, ...structuredClone(input) };
  const result = {
    ...preimage,
    binding_digest: digestV1("VF-CONVERSATION-NATIVE-REFERENCE\0v1\0", preimage),
  };
  assertConversationNativeReferenceBinding(result);
  return result;
}

export function materializeConversationControlPostconditionBinding(
  input: Omit<ConversationControlPostconditionBindingV1, "schema_version" | "binding_digest">,
): ConversationControlPostconditionBindingV1 {
  const preimage = { schema_version: PUBLIC_ACTION_SCHEMA_VERSION, ...structuredClone(input) };
  const result = {
    ...preimage,
    binding_digest: digestV1("VF-CONVERSATION-CONTROL-POSTCONDITION\0v1\0", preimage),
  };
  assertConversationControlPostconditionBinding(result);
  return result;
}

export function materializeConversationControlEffectPlan(input: {
  target_operation_id: string;
  effects: ConversationControlEffectV1[];
  cleanup_artifact_digests?: string[];
}): ConversationControlEffectPlanV1 {
  const preimage = {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    target_operation_id: input.target_operation_id,
    effects: structuredClone(input.effects).sort((left, right) =>
      Buffer.compare(Buffer.from(left.effect_id), Buffer.from(right.effect_id)),
    ),
    cleanup_artifact_digests: [...(input.cleanup_artifact_digests ?? [])].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    ),
  };
  const result = {
    ...preimage,
    plan_digest: digestV1("VF-CONVERSATION-CONTROL-EFFECT-PLAN\0v1\0", preimage),
  };
  assertConversationControlEffectPlan(result);
  return result;
}

export function assertConversationNativeReferenceBinding(
  value: unknown,
): asserts value is ConversationNativeReferenceBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid conversation native reference binding");
  const row = value as ConversationNativeReferenceBindingV1;
  if (
    !exact(row, [
      "adapter_fingerprint",
      "authority_record_digest",
      "binding_digest",
      "effect_id",
      "participant_id",
      "private_reference_content_digest",
      "reference_kind",
      "schema_version",
      "target_operation_id",
    ]) ||
    row.schema_version !== PUBLIC_ACTION_SCHEMA_VERSION ||
    !bounded(row.target_operation_id) ||
    !EFFECT.test(row.effect_id) ||
    (row.participant_id !== null && !bounded(row.participant_id)) ||
    !bounded(row.adapter_fingerprint) ||
    !CONVERSATION_NATIVE_REFERENCE_KINDS.includes(row.reference_kind) ||
    !DIGEST.test(row.authority_record_digest) ||
    (row.private_reference_content_digest !== null &&
      !DIGEST.test(row.private_reference_content_digest)) ||
    !DIGEST.test(row.binding_digest)
  )
    throw new Error("invalid conversation native reference binding");
  const { binding_digest: _digest, ...preimage } = row;
  if (digestV1("VF-CONVERSATION-NATIVE-REFERENCE\0v1\0", preimage) !== row.binding_digest)
    throw new Error("invalid conversation native reference binding digest");
}

export function assertConversationControlPostconditionBinding(
  value: unknown,
): asserts value is ConversationControlPostconditionBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid conversation control postcondition binding");
  const row = value as ConversationControlPostconditionBindingV1;
  const condition = row.condition;
  const validCondition =
    condition?.kind === CONVERSATION_CONTROL_CONDITION_KIND.OPERATION_TERMINAL
      ? exact(condition, ["allowed_states", "kind"]) &&
        JSON.stringify(condition.allowed_states) ===
          JSON.stringify(CONVERSATION_CONTROL_OPERATION_TERMINAL_STATES)
      : condition?.kind === CONVERSATION_CONTROL_CONDITION_KIND.PARTICIPANT_QUIESCENT
        ? exact(condition, ["allowed_outcomes", "kind"]) &&
          JSON.stringify(condition.allowed_outcomes) ===
            JSON.stringify(CONVERSATION_CONTROL_PARTICIPANT_OUTCOMES)
        : condition?.kind === CONVERSATION_CONTROL_CONDITION_KIND.RECONCILIATION_RESOLUTION &&
          exact(condition, ["allowed_outcomes", "kind"]) &&
          JSON.stringify(condition.allowed_outcomes) ===
            JSON.stringify(CONVERSATION_CONTROL_RECONCILIATION_OUTCOMES);
  if (
    !exact(row, [
      "binding_digest",
      "condition",
      "effect_id",
      "expected_pre_effect_fold_digest",
      "schema_version",
      "target_operation_id",
    ]) ||
    row.schema_version !== PUBLIC_ACTION_SCHEMA_VERSION ||
    !bounded(row.target_operation_id) ||
    !EFFECT.test(row.effect_id) ||
    !DIGEST.test(row.expected_pre_effect_fold_digest) ||
    !validCondition ||
    !DIGEST.test(row.binding_digest)
  )
    throw new Error("invalid conversation control postcondition binding");
  const { binding_digest: _digest, ...preimage } = row;
  if (digestV1("VF-CONVERSATION-CONTROL-POSTCONDITION\0v1\0", preimage) !== row.binding_digest)
    throw new Error("invalid conversation control postcondition binding digest");
}

export function assertConversationControlEffectPlan(
  value: unknown,
): asserts value is ConversationControlEffectPlanV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid conversation control effect plan");
  const plan = value as ConversationControlEffectPlanV1;
  if (
    !exact(plan, [
      "cleanup_artifact_digests",
      "effects",
      "plan_digest",
      "schema_version",
      "target_operation_id",
    ]) ||
    plan.schema_version !== PUBLIC_ACTION_SCHEMA_VERSION ||
    !bounded(plan.target_operation_id) ||
    !Array.isArray(plan.effects) ||
    !Array.isArray(plan.cleanup_artifact_digests) ||
    !DIGEST.test(plan.plan_digest)
  )
    throw new Error("invalid conversation control effect plan");
  let prior = "";
  for (const effect of plan.effects) {
    if (
      !exact(effect, [
        "adapter_fingerprint",
        "effect_id",
        "effect_kind",
        "expected_control_postcondition_digest",
        "mode",
        "native_reference_digest",
        "participant_id",
      ]) ||
      effect.effect_id !==
        controlEffectId({
          target_operation_id: plan.target_operation_id,
          participant_id: effect.participant_id,
          adapter_fingerprint: effect.adapter_fingerprint,
          effect_kind: effect.effect_kind,
          mode: effect.mode,
        }) ||
      (effect.participant_id !== null && !bounded(effect.participant_id)) ||
      !bounded(effect.adapter_fingerprint) ||
      !DIGEST.test(effect.native_reference_digest) ||
      !DIGEST.test(effect.expected_control_postcondition_digest) ||
      (prior && Buffer.compare(Buffer.from(prior), Buffer.from(effect.effect_id)) >= 0)
    )
      throw new Error("invalid conversation control effect");
    if (
      (effect.effect_kind === CONVERSATION_CONTROL_EFFECT_KIND.CANCEL_OR_PROVE_QUIESCENT &&
        !isParticipantCancelModeV1(effect.mode)) ||
      (effect.effect_kind === CONVERSATION_CONTROL_EFFECT_KIND.RECONCILE &&
        !isParticipantStartReconciliationModeV1(effect.mode))
    )
      throw new Error("invalid conversation control effect mode");
    prior = effect.effect_id;
  }
  if (
    plan.cleanup_artifact_digests.some(
      (digest, index) =>
        !DIGEST.test(digest) ||
        (index > 0 &&
          Buffer.compare(
            Buffer.from(plan.cleanup_artifact_digests[index - 1] ?? ""),
            Buffer.from(digest),
          ) >= 0),
    )
  )
    throw new Error("invalid conversation control cleanup artifacts");
  const { plan_digest: _digest, ...preimage } = plan;
  if (digestV1("VF-CONVERSATION-CONTROL-EFFECT-PLAN\0v1\0", preimage) !== plan.plan_digest)
    throw new Error("invalid conversation control effect plan digest");
}
