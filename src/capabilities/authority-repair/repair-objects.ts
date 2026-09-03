import { ACTION_SCOPE } from "../../actions/index.js";
import {
  isAuthorityRepairDomain,
  isAuthorityRepairScopeAllowed,
} from "../../actions/internal-action-vocabulary-contract.js";
import { validateRepairPlan } from "../../actions/internal-repair-validation.js";
import { assertDigest, assertOpaqueId, assertTimestamp } from "../../actions/record-primitives.js";
import { exactObject } from "../../actions/strict-json.js";
import { CAPABILITY_SCOPE, isCapabilityScope } from "../../core/capability-contract.js";
import { digestV1 } from "../../durability/index.js";
import { assertAuthorityRepairDomainLocator } from "./adapter-registry.js";
import {
  AUTHORITY_REPAIR_BINDING_MODE,
  AUTHORITY_REPAIR_DIGEST_DOMAIN,
  AUTHORITY_REPAIR_PLAN_KIND,
  AUTHORITY_REPAIR_SCHEMA_VERSION,
  AUTHORITY_REPAIR_STRATEGY,
} from "./contract.js";
import {
  authorityRepairJsonExpectedPointer,
  authorityRepairJsonReplacementPointer,
  authorityRepairLostTailDigest,
  authorityRepairQuarantineRef,
  authorityRepairRestoreSourceRef,
} from "./digests.js";
import type {
  AuthorityRepairAbsenceEvidenceV1,
  AuthorityRepairActionObjectClosureV1,
  AuthorityRepairStepsV1,
  RepairAuthorizationBindingV1,
} from "./types.js";
import {
  assertNonCompoundLocator,
  assertRawSha256,
  assertScopeTriple,
  assertTargetPreimage,
  invalid,
} from "./validation.js";

export {
  assertAuthorityRepairActionPlan,
  materializeAuthorityRepairActionPlan,
} from "./action-plan.js";

const BINDING_FIELDS = Object.freeze([
  "schema_version",
  "mode",
  "control_scope",
  "control_scope_identity_digest",
  "authority_epoch",
  "authority_head_digest",
  "authority_head_checkpoint_digest",
  "target_domain",
  "target_authority_scope",
  "target_scope_id",
  "binding_digest",
] as const);

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

export function materializeRepairAuthorizationBinding(
  draft: Omit<RepairAuthorizationBindingV1, "binding_digest">,
): RepairAuthorizationBindingV1 {
  return assertRepairAuthorizationBinding({
    ...structuredClone(draft),
    binding_digest: digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.AUTHORIZATION_BINDING, draft),
  });
}

export function assertRepairAuthorizationBinding(
  value: RepairAuthorizationBindingV1,
): RepairAuthorizationBindingV1 {
  exactObject(value, BINDING_FIELDS, [], "$.repair_authorization");
  if (
    value.schema_version !== AUTHORITY_REPAIR_SCHEMA_VERSION ||
    !isAuthorityRepairDomain(value.target_domain) ||
    !isAuthorityRepairScopeAllowed(value.target_domain, value.target_authority_scope)
  )
    invalid("repair authorization target is invalid");
  if (!isCapabilityScope(value.control_scope))
    invalid("repair authorization control scope is invalid");
  const expectedControl =
    value.target_authority_scope === ACTION_SCOPE.USER
      ? CAPABILITY_SCOPE.USER
      : CAPABILITY_SCOPE.PROJECT;
  if (value.control_scope !== expectedControl)
    invalid("repair authorization target is controlled by another authority scope");
  assertDigest(
    value.control_scope_identity_digest,
    "$.repair_authorization.control_scope_identity_digest",
  );
  assertDigest(value.authority_head_digest, "$.repair_authorization.authority_head_digest");
  assertOpaqueId(value.target_scope_id, "$.repair_authorization.target_scope_id");
  if (
    value.target_authority_scope !== ACTION_SCOPE.CONVERSATION &&
    value.target_scope_id !== value.control_scope_identity_digest
  )
    invalid("capability repair target and control identity differ");
  if (!Number.isSafeInteger(value.authority_epoch) || value.authority_epoch < 0)
    invalid("repair authorization epoch is invalid");
  if (value.mode === AUTHORITY_REPAIR_BINDING_MODE.CURRENT) {
    if (value.authority_head_checkpoint_digest !== null)
      invalid("current repair authorization has a checkpoint");
  } else if (value.mode === AUTHORITY_REPAIR_BINDING_MODE.RECOVERY_CHECKPOINT) {
    assertDigest(
      value.authority_head_checkpoint_digest,
      "$.repair_authorization.authority_head_checkpoint_digest",
    );
  } else invalid("repair authorization mode is invalid");
  assertDigest(value.binding_digest, "$.repair_authorization.binding_digest");
  if (
    value.binding_digest !==
    digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.AUTHORIZATION_BINDING, omit(value, "binding_digest"))
  )
    invalid("repair authorization digest mismatch");
  return value;
}

const STEP_FIELDS = Object.freeze([
  "schema_version",
  "domain",
  "authority_scope",
  "scope_id",
  "strategy",
  "target_locator",
  "target_preimage",
  "restore_source_ref",
  "restore_bytes_sha256",
  "last_valid_record_digest",
  "lost_tail_sha256",
  "lost_tail_digest",
  "expected_current_pointer_digest",
  "replacement_current_pointer_digest",
  "recovery_link_digest",
  "journal_identity_digest",
  "authority_epoch_repair_base_digest",
  "steps_digest",
] as const);

export function materializeAuthorityRepairSteps(
  draft: Omit<AuthorityRepairStepsV1, "steps_digest">,
): AuthorityRepairStepsV1 {
  return assertAuthorityRepairSteps({
    ...structuredClone(draft),
    steps_digest: digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.STEPS, draft),
  });
}

export function assertAuthorityRepairSteps(value: AuthorityRepairStepsV1): AuthorityRepairStepsV1 {
  exactObject(value, STEP_FIELDS, [], "$.repair_steps");
  assertScopeTriple(value);
  assertTargetPreimage(value.target_preimage);
  assertDigest(value.restore_source_ref, "$.repair_steps.restore_source_ref");
  assertRawSha256(value.restore_bytes_sha256, "restore bytes SHA-256");
  assertDigest(value.last_valid_record_digest, "$.repair_steps.last_valid_record_digest");
  for (const key of [
    "lost_tail_digest",
    "expected_current_pointer_digest",
    "replacement_current_pointer_digest",
    "recovery_link_digest",
    "journal_identity_digest",
    "authority_epoch_repair_base_digest",
  ] as const)
    if (value[key] !== null) assertDigest(value[key], `$.repair_steps.${key}`);
  if ((value.lost_tail_sha256 === null) !== (value.lost_tail_digest === null))
    invalid("lost-tail fields have different nullability");
  if (value.lost_tail_sha256 !== null) assertRawSha256(value.lost_tail_sha256, "lost-tail SHA-256");
  if (value.restore_source_ref !== authorityRepairRestoreSourceRef(value))
    invalid("restore source reference mismatch");
  if (value.target_preimage.quarantine_ref !== authorityRepairQuarantineRef(value))
    invalid("quarantine reference mismatch");
  if (value.lost_tail_digest !== authorityRepairLostTailDigest(value))
    invalid("lost-tail digest mismatch");

  const compound = value.strategy === AUTHORITY_REPAIR_STRATEGY.REPLACE_AUTHORITY_EPOCH_COMPOUND;
  if (compound !== (value.target_locator === null)) invalid("strategy and target locator mismatch");
  if (!compound) {
    assertNonCompoundLocator(value.target_locator);
    if (value.target_locator.strategy !== value.strategy)
      invalid("nested locator strategy mismatch");
  }
  const journal = value.strategy === AUTHORITY_REPAIR_STRATEGY.NEW_JOURNAL_GENERATION;
  if ((journal || compound) !== (value.journal_identity_digest !== null))
    invalid("journal identity nullability mismatch");
  if (compound !== (value.authority_epoch_repair_base_digest !== null))
    invalid("authority epoch base nullability mismatch");
  if (journal || compound) {
    if (value.replacement_current_pointer_digest === null || value.recovery_link_digest === null)
      invalid("journal repair lacks replacement pointer or recovery link");
  } else if (value.recovery_link_digest !== null) invalid("non-journal repair has recovery link");
  if (value.strategy === AUTHORITY_REPAIR_STRATEGY.REPLACE_JSON_HEAD) {
    if (
      value.expected_current_pointer_digest === null ||
      value.replacement_current_pointer_digest === null
    )
      invalid("JSON-head repair lacks its exact pointer digests");
    if (
      value.expected_current_pointer_digest !== authorityRepairJsonExpectedPointer(value) ||
      value.replacement_current_pointer_digest !== authorityRepairJsonReplacementPointer(value)
    )
      invalid("JSON-head repair pointer digest mismatch");
  }
  if (value.strategy === AUTHORITY_REPAIR_STRATEGY.RESTORE_CONTENT_ADDRESSED_OBJECT) {
    if (
      value.expected_current_pointer_digest !== null ||
      value.replacement_current_pointer_digest !== null
    )
      invalid("content restoration has pointer digests");
  }
  if (
    (journal || compound) &&
    (value.target_preimage.presence !== "present" ||
      value.target_preimage.absence_evidence_digest !== null)
  )
    invalid("journal and compound repair require a present preimage");
  if (
    journal &&
    value.target_locator?.strategy === AUTHORITY_REPAIR_STRATEGY.NEW_JOURNAL_GENERATION
  ) {
    if (value.target_locator.journal_identity_digest !== value.journal_identity_digest)
      invalid("journal locator identity differs from repair steps");
    const selected = value.target_locator.source_selector;
    const expected =
      selected.kind === "canonical-source" ? null : selected.expected_current_pointer_digest;
    if (value.expected_current_pointer_digest !== expected)
      invalid("journal source selector and expected pointer differ");
  }
  assertDigest(value.steps_digest, "$.repair_steps.steps_digest");
  if (
    value.steps_digest !==
    digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.STEPS, omit(value, "steps_digest"))
  )
    invalid("repair steps digest mismatch");
  return value;
}

export function materializeAuthorityRepairAbsenceEvidence(
  draft: Omit<AuthorityRepairAbsenceEvidenceV1, "evidence_digest">,
): AuthorityRepairAbsenceEvidenceV1 {
  return assertAuthorityRepairAbsenceEvidence({
    ...structuredClone(draft),
    evidence_digest: digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.ABSENCE_EVIDENCE, draft),
  });
}

export function assertAuthorityRepairAbsenceEvidence(
  value: AuthorityRepairAbsenceEvidenceV1,
): AuthorityRepairAbsenceEvidenceV1 {
  exactObject(
    value,
    [
      "schema_version",
      "domain",
      "authority_scope",
      "scope_id",
      "target_locator",
      "observed_at",
      "evidence_digest",
    ],
    [],
    "$.absence_evidence",
  );
  assertScopeTriple(value);
  assertNonCompoundLocator(value.target_locator);
  assertTimestamp(value.observed_at, "$.absence_evidence.observed_at");
  assertDigest(value.evidence_digest, "$.absence_evidence.evidence_digest");
  if (
    value.evidence_digest !==
    digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.ABSENCE_EVIDENCE, omit(value, "evidence_digest"))
  )
    invalid("absence evidence digest mismatch");
  return value;
}
