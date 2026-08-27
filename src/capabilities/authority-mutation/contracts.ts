import {
  CAPABILITY_AUTHORITY_CHANGE,
  CAPABILITY_GRANT_TRANSITION,
  type CapabilityGrantTransition,
} from "../../actions/capability-security-contract.js";
import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import { EMPTY_PERMISSION_DIGEST, validateInternalHostAction } from "../../actions/index.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import {
  ACTION_DOMAIN,
  ACTION_EFFECT_CLASS,
  ACTION_PLANNING_MODE,
  ACTION_PLANNING_NETWORK_READ_VALUE,
  ACTION_REVERSIBILITY_VALUE,
} from "../../actions/public-action-contract.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import { digestV1 } from "../../durability/index.js";
import type { AuthorityEpochHeadV1 } from "../authority/index.js";
import { CapabilityValidationError, exactKeys } from "../wire/primitives.js";
import { validateAutomationGrantBinding } from "./automation-grant-authority.js";
import type {
  AuthorityActionPlanBindingV1,
  AuthorityChangeEffectPlanV1,
  AuthorityChangePlanV1,
  OrdinaryAuthorityActionV1,
  PolicyAuthorityInverseDescriptorV1,
  SecretRevocationCandidateV1,
} from "./types.js";
import { AUTHORITY_CHANGE_EFFECT_KIND, ORDINARY_AUTHORITY_ACTION_KINDS } from "./types.js";

export const AUTHORITY_CHANGE_DIGEST_DOMAIN = Object.freeze({
  EFFECT: "VF-AUTHORITY-DOMAIN-EFFECT\0v1\0",
  EFFECT_PLAN: "VF-AUTHORITY-CHANGE-EFFECT-PLAN\0v1\0",
  INVERSE: "VF-POLICY-AUTHORITY-INVERSE\0v1\0",
  PLAN: "VF-AUTHORITY-CHANGE-PLAN\0v1\0",
  ACTION_PLAN: "VF-ACTION-PLAN\0v1\0",
  OPERATION: "VF-AUTHORITY-CHANGE-OPERATION\0v1\0",
  TERMINAL: "VF-AUTHORITY-CHANGE-TERMINAL-RECEIPT\0v1\0",
  SECRET_CANDIDATE: "VF-SECRET-REVOCATION-CANDIDATE\0v1\0",
} as const);

const AUTHORITY_CHANGE_BY_ACTION = Object.freeze({
  [HOST_ACTION_KIND.GRANT_CREATE]: CAPABILITY_AUTHORITY_CHANGE.GRANT_CHANGED,
  [HOST_ACTION_KIND.GRANT_RENEW]: CAPABILITY_AUTHORITY_CHANGE.GRANT_CHANGED,
  [HOST_ACTION_KIND.GRANT_REVOKE]: CAPABILITY_AUTHORITY_CHANGE.GRANT_CHANGED,
  [HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY]: CAPABILITY_AUTHORITY_CHANGE.POLICY_CHANGED,
  [HOST_ACTION_KIND.SECRET_REVOKE]: CAPABILITY_AUTHORITY_CHANGE.SECRET_REVOKED,
  [HOST_ACTION_KIND.REGISTRY_TRUST_KEY]: CAPABILITY_AUTHORITY_CHANGE.REGISTRY_TRUST_CHANGED,
} as const);

function fail(message: string, path = "authority.mutation"): never {
  throw new CapabilityValidationError(message, path, "integrity_failure");
}

function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

export function isOrdinaryAuthorityActionKind(
  value: unknown,
): value is (typeof ORDINARY_AUTHORITY_ACTION_KINDS)[number] {
  return (
    typeof value === "string" &&
    ORDINARY_AUTHORITY_ACTION_KINDS.some((candidate) => candidate === value)
  );
}

export function authorityChangeForAction(
  action: OrdinaryAuthorityActionV1,
): AuthorityChangePlanV1["change"] {
  return AUTHORITY_CHANGE_BY_ACTION[action.type];
}

export function authoritySubjectForAction(
  action: OrdinaryAuthorityActionV1,
  generatedGrantId: string | null,
  secretCandidate: SecretRevocationCandidateV1 | null,
): string {
  switch (action.type) {
    case HOST_ACTION_KIND.GRANT_CREATE:
      return generatedGrantId ?? fail("grant issuance requires its pre-proposal subject ID");
    case HOST_ACTION_KIND.GRANT_RENEW:
    case HOST_ACTION_KIND.GRANT_REVOKE:
      return action.grant_id;
    case HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY:
      return action.change.scope_identity_digest;
    case HOST_ACTION_KIND.SECRET_REVOKE:
      return (
        secretCandidate?.secret_handle_id_digest ??
        fail("secret revocation requires its exact retained candidate")
      );
    case HOST_ACTION_KIND.REGISTRY_TRUST_KEY:
      return action.change.key_id;
  }
}

export function expectedDomainHead(
  head: AuthorityEpochHeadV1,
  change: AuthorityChangePlanV1["change"],
  secretPreviousFrameDigest: string | null,
): string | null {
  switch (change) {
    case CAPABILITY_AUTHORITY_CHANGE.GRANT_CHANGED:
      return head.grant_head_digest;
    case CAPABILITY_AUTHORITY_CHANGE.POLICY_CHANGED:
      return head.policy_head_digest;
    case CAPABILITY_AUTHORITY_CHANGE.SECRET_REVOKED:
      return secretPreviousFrameDigest;
    case CAPABILITY_AUTHORITY_CHANGE.REGISTRY_TRUST_CHANGED:
      return head.trust_head_digest;
  }
}

export function materializeAuthorityEffectDigest(input: {
  scope: CapabilityScope;
  scope_identity_digest: string;
  change: AuthorityChangePlanV1["change"];
  authority_subject_id: string;
  authority_action: OrdinaryAuthorityActionV1;
  expected_authority_epoch: number;
  expected_authority_head_digest: string;
  expected_domain_head_digest: string | null;
}): string {
  return digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.EFFECT, {
    schema_version: "1.0",
    ...input,
  });
}

export function materializeEffectPlan(
  draft: Omit<AuthorityChangeEffectPlanV1, "plan_digest">,
): AuthorityChangeEffectPlanV1 {
  const value = {
    ...draft,
    plan_digest: digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.EFFECT_PLAN, draft),
  };
  return validateEffectPlan(value);
}

export function validateEffectPlan(value: AuthorityChangeEffectPlanV1) {
  exactKeys(
    value,
    [
      "schema_version",
      "scope",
      "scope_identity_digest",
      "change",
      "authority_subject_id",
      "effect_kind",
      "expected_preimage_sha256",
      "expected_preimage_byte_length",
      "private_preimage_content_digest",
      "replacement_sha256",
      "replacement_byte_length",
      "private_replacement_content_digest",
      "private_preimage_ref",
      "private_replacement_ref",
      "inverse_descriptor_digest",
      "plan_digest",
    ],
    [],
    "authority_effect_plan",
  );
  const policy = value.change === CAPABILITY_AUTHORITY_CHANGE.POLICY_CHANGED;
  const nullable = [
    value.expected_preimage_sha256,
    value.expected_preimage_byte_length,
    value.private_preimage_content_digest,
    value.replacement_sha256,
    value.replacement_byte_length,
    value.private_replacement_content_digest,
    value.private_preimage_ref,
    value.private_replacement_ref,
    value.inverse_descriptor_digest,
  ];
  if (
    value.schema_version !== "1.0" ||
    (policy &&
      (value.effect_kind !== AUTHORITY_CHANGE_EFFECT_KIND.SETTINGS_REPLACEMENT ||
        nullable.some((item) => item === null))) ||
    (!policy &&
      (value.effect_kind !== AUTHORITY_CHANGE_EFFECT_KIND.JOURNAL_ONLY ||
        nullable.some((item) => item !== null))) ||
    value.plan_digest !==
      digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.EFFECT_PLAN, without(value, "plan_digest"))
  )
    fail("authority effect plan is not its exact typed closure", "authority_effect_plan");
  return value;
}

export function materializePolicyInverse(
  draft: Omit<PolicyAuthorityInverseDescriptorV1, "descriptor_digest">,
): PolicyAuthorityInverseDescriptorV1 {
  const value = {
    ...draft,
    descriptor_digest: digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.INVERSE, draft),
  };
  return validatePolicyInverse(value);
}

export function validatePolicyInverse(value: PolicyAuthorityInverseDescriptorV1) {
  exactKeys(
    value,
    [
      "schema_version",
      "scope",
      "scope_identity_digest",
      "settings_schema_version",
      "expected_current_sha256",
      "expected_current_policy_digest",
      "restore_sha256",
      "restore_byte_length",
      "restore_content_digest",
      "restore_policy_digest",
      "private_restore_ref",
      "descriptor_digest",
    ],
    [],
    "policy_inverse",
  );
  if (
    value.schema_version !== "1.0" ||
    value.descriptor_digest !==
      digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.INVERSE, without(value, "descriptor_digest"))
  )
    fail("policy inverse descriptor digest mismatch", "policy_inverse");
  return value;
}

export function materializeAuthorityPlan(
  draft: Omit<AuthorityChangePlanV1, "plan_digest">,
): AuthorityChangePlanV1 {
  const value = {
    ...draft,
    plan_digest: digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.PLAN, draft),
  };
  return validateAuthorityPlan(value);
}

export function validateAuthorityPlan(value: AuthorityChangePlanV1) {
  exactKeys(
    value,
    [
      "schema_version",
      "scope",
      "scope_identity_digest",
      "change",
      "authority_subject_id",
      "authority_action",
      "expected_authority_epoch",
      "expected_authority_head_digest",
      "expected_domain_head_digest",
      "automation_grant_binding",
      "permission_digest",
      "proposed_effect_digest",
      "recovery_plan_digest",
      "created_at",
      "expires_at",
      "plan_digest",
    ],
    [],
    "authority_plan",
  );
  const action = validateInternalHostAction(value.authority_action);
  const grantBinding = value.automation_grant_binding
    ? validateAutomationGrantBinding(value.automation_grant_binding)
    : null;
  if (
    !isOrdinaryAuthorityActionKind(action.type) ||
    value.schema_version !== "1.0" ||
    authorityChangeForAction(action as OrdinaryAuthorityActionV1) !== value.change ||
    (grantBinding
      ? grantBinding.scope !== value.scope ||
        grantBinding.scope_identity_digest !== value.scope_identity_digest ||
        grantBinding.action_type !== action.type ||
        grantBinding.authority_epoch !== value.expected_authority_epoch ||
        grantBinding.authority_head_digest !== value.expected_authority_head_digest
      : false) ||
    value.permission_digest !== EMPTY_PERMISSION_DIGEST ||
    value.proposed_effect_digest !==
      materializeAuthorityEffectDigest({
        scope: value.scope,
        scope_identity_digest: value.scope_identity_digest,
        change: value.change,
        authority_subject_id: value.authority_subject_id,
        authority_action: value.authority_action,
        expected_authority_epoch: value.expected_authority_epoch,
        expected_authority_head_digest: value.expected_authority_head_digest,
        expected_domain_head_digest: value.expected_domain_head_digest,
      }) ||
    value.plan_digest !==
      digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.PLAN, without(value, "plan_digest"))
  )
    fail("authority change plan is not its exact semantic effect", "authority_plan");
  return value;
}

export function materializeActionPlan(input: {
  scope: CapabilityScope;
  scope_identity_digest: string;
  permission_digest: string;
  native_plan_digest: string;
  effect_class: "project-write" | "user-write";
  reversibility: AuthorityActionPlanBindingV1["steps"][0]["reversibility"];
}): AuthorityActionPlanBindingV1 {
  return {
    schema_version: "1.0",
    domain: ACTION_DOMAIN.CAPABILITY,
    action_root_locator: {
      kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
      scope: input.scope,
      scope_identity_digest: input.scope_identity_digest,
    },
    planning_options: {
      mode: ACTION_PLANNING_MODE.DURABLE,
      network_read: ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY,
    },
    execution_object_closure_digest: null,
    permission_digest: input.permission_digest,
    steps: [
      {
        order: 0,
        step_id: `authority-change-${input.native_plan_digest.slice("sha256:".length, 33)}`,
        plan_kind: "authority-change",
        plan_digest: input.native_plan_digest,
        target_ids: [],
        effect_classes: [input.effect_class],
        reversibility: input.reversibility,
      },
    ],
  };
}

export function actionPlanDigest(value: AuthorityActionPlanBindingV1): string {
  return digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.ACTION_PLAN, value);
}

export function validateActionPlan(
  value: AuthorityActionPlanBindingV1,
  nativePlan: AuthorityChangePlanV1,
): AuthorityActionPlanBindingV1 {
  const step = value.steps[0];
  if (
    value.schema_version !== "1.0" ||
    value.domain !== ACTION_DOMAIN.CAPABILITY ||
    value.execution_object_closure_digest !== null ||
    value.planning_options.mode !== ACTION_PLANNING_MODE.DURABLE ||
    value.planning_options.network_read !==
      ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY ||
    value.permission_digest !== nativePlan.permission_digest ||
    value.steps.length !== 1 ||
    !step ||
    step.order !== 0 ||
    step.plan_kind !== "authority-change" ||
    step.plan_digest !== nativePlan.plan_digest ||
    step.target_ids.length !== 0 ||
    step.effect_classes.length !== 1 ||
    (step.effect_classes[0] !== ACTION_EFFECT_CLASS.PROJECT_WRITE &&
      step.effect_classes[0] !== ACTION_EFFECT_CLASS.USER_WRITE) ||
    ![
      ACTION_REVERSIBILITY_VALUE.REVERSIBLE,
      ACTION_REVERSIBILITY_VALUE.COMPENSATABLE,
      ACTION_REVERSIBILITY_VALUE.MANUAL,
      ACTION_REVERSIBILITY_VALUE.IRREVERSIBLE,
    ].some((candidate) => candidate === step.reversibility)
  )
    fail("action plan does not contain one exact authority-change step", "action_plan");
  return value;
}

export function grantTransitionForAction(
  action: OrdinaryAuthorityActionV1,
): CapabilityGrantTransition | null {
  if (action.type === HOST_ACTION_KIND.GRANT_CREATE) return CAPABILITY_GRANT_TRANSITION.ISSUED;
  if (action.type === HOST_ACTION_KIND.GRANT_RENEW) return CAPABILITY_GRANT_TRANSITION.RENEWED;
  if (action.type === HOST_ACTION_KIND.GRANT_REVOKE) return CAPABILITY_GRANT_TRANSITION.REVOKED;
  return null;
}

export {
  materializeOperationHeader,
  materializeTerminalReceipt,
  validateOperationBinding,
  validateOperationHeader,
  validateSecretRevocationCandidate,
  validateTerminalReceipt,
} from "./operation-contracts.js";
