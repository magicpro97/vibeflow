import { assertApproval, assertProposal } from "../../actions/index.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import { canonicalJson, digestV1 } from "../../durability/index.js";
import { CapabilityValidationError, exactKeys } from "../wire/primitives.js";
import {
  AUTHORITY_CHANGE_DIGEST_DOMAIN,
  isOrdinaryAuthorityActionKind,
  validateAuthorityPlan,
  validateEffectPlan,
} from "./contracts.js";
import type {
  AuthorityChangeOperationV1,
  AuthorityChangeTerminalReceiptV1,
  OrdinaryAuthorityOperationBindingV1,
  SecretRevocationCandidateV1,
} from "./types.js";
import { AUTHORITY_CHANGE_TERMINAL_OUTCOME, AUTHORITY_CHANGE_TERMINAL_REASON } from "./types.js";

function fail(message: string, path: string): never {
  throw new CapabilityValidationError(message, path, "integrity_failure");
}

function exact(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

export function materializeOperationHeader(
  draft: Omit<AuthorityChangeOperationV1, "header_digest">,
): AuthorityChangeOperationV1 {
  return validateOperationHeader({
    ...draft,
    header_digest: digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.OPERATION, draft),
  });
}

export function validateOperationHeader(value: AuthorityChangeOperationV1) {
  exactKeys(
    value,
    [
      "schema_version",
      "operation_id",
      "proposal_id",
      "proposal_digest",
      "approval_id",
      "approval_digest",
      "action_type",
      "action_root_locator",
      "action_plan_binding_digest",
      "authority_change_plan_digest",
      "scope",
      "scope_identity_digest",
      "change",
      "authority_subject_id",
      "expected_authority_epoch",
      "expected_authority_head_digest",
      "expected_domain_head_digest",
      "proposed_effect_digest",
      "recovery_plan_digest",
      "permission_digest",
      "created_at",
      "header_digest",
    ],
    [],
    "authority_header",
  );
  if (
    value.schema_version !== "1.0" ||
    !isOrdinaryAuthorityActionKind(value.action_type) ||
    value.header_digest !==
      digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.OPERATION, without(value, "header_digest"))
  )
    fail("authority operation header digest mismatch", "authority_header");
  return value;
}

export function validateOperationBinding(input: OrdinaryAuthorityOperationBindingV1): void {
  const { proposal, approval, header, plan, effect } = input;
  assertProposal(proposal);
  assertApproval(proposal, approval);
  validateAuthorityPlan(plan);
  validateEffectPlan(effect);
  validateOperationHeader(header);
  if (
    proposal.action.type !== header.action_type ||
    !exact(proposal.action, plan.authority_action) ||
    proposal.proposal_id !== header.proposal_id ||
    proposal.proposal_digest !== header.proposal_digest ||
    approval.approval_id !== header.approval_id ||
    approval.approval_digest !== header.approval_digest ||
    proposal.plan_digest !== header.action_plan_binding_digest ||
    plan.plan_digest !== header.authority_change_plan_digest ||
    effect.plan_digest !== header.recovery_plan_digest ||
    plan.recovery_plan_digest !== effect.plan_digest ||
    plan.scope !== header.scope ||
    plan.scope_identity_digest !== header.scope_identity_digest ||
    plan.change !== header.change ||
    plan.authority_subject_id !== header.authority_subject_id ||
    plan.expected_authority_epoch !== header.expected_authority_epoch ||
    plan.expected_authority_head_digest !== header.expected_authority_head_digest ||
    plan.expected_domain_head_digest !== header.expected_domain_head_digest ||
    plan.proposed_effect_digest !== header.proposed_effect_digest ||
    plan.permission_digest !== header.permission_digest ||
    approval.decided_at !== header.created_at ||
    proposal.base.authority_epoch !== header.expected_authority_epoch ||
    proposal.base.authority_head_digest !== header.expected_authority_head_digest ||
    proposal.base.capability_scope !== header.scope ||
    proposal.action_root_locator.kind !== ACTION_ROOT_LOCATOR_KIND.CAPABILITY ||
    !exact(proposal.action_root_locator, header.action_root_locator)
  )
    fail("authority operation escaped its approved immutable closure", "authority_header");
}

export function materializeTerminalReceipt(
  draft: Omit<AuthorityChangeTerminalReceiptV1, "receipt_digest">,
): AuthorityChangeTerminalReceiptV1 {
  return validateTerminalReceipt({
    ...draft,
    receipt_digest: digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.TERMINAL, draft),
  });
}

export function validateTerminalReceipt(value: AuthorityChangeTerminalReceiptV1) {
  exactKeys(
    value,
    [
      "schema_version",
      "operation_id",
      "sequence",
      "previous_receipt_digest",
      "proposal_id",
      "proposal_digest",
      "approval_id",
      "approval_digest",
      "plan_digest",
      "action_root_locator",
      "operation_header_digest",
      "scope",
      "scope_identity_digest",
      "change",
      "expected_authority_head_digest",
      "observed_authority_head_digest",
      "outcome",
      "reason_code",
      "recorded_at",
      "receipt_digest",
    ],
    [],
    "authority_terminal",
  );
  const sequenceShapeIsValid =
    Number.isSafeInteger(value.sequence) &&
    (value.sequence === 0 || value.sequence === 1) &&
    (value.sequence === 0) === (value.previous_receipt_digest === null);
  const outcomeReasonIsValid =
    (value.outcome === AUTHORITY_CHANGE_TERMINAL_OUTCOME.NEEDS_RECOVERY &&
      value.reason_code === AUTHORITY_CHANGE_TERMINAL_REASON.PARTIAL_STATE_UNPROVEN) ||
    (value.outcome === AUTHORITY_CHANGE_TERMINAL_OUTCOME.FAILED &&
      (value.reason_code === AUTHORITY_CHANGE_TERMINAL_REASON.AUTHORITY_STALE ||
        value.reason_code === AUTHORITY_CHANGE_TERMINAL_REASON.PRE_EFFECT_REVALIDATION_FAILED));
  if (
    value.schema_version !== "1.0" ||
    !sequenceShapeIsValid ||
    !outcomeReasonIsValid ||
    !Object.values(AUTHORITY_CHANGE_TERMINAL_OUTCOME).some(
      (candidate) => candidate === value.outcome,
    ) ||
    !Object.values(AUTHORITY_CHANGE_TERMINAL_REASON).some(
      (candidate) => candidate === value.reason_code,
    ) ||
    value.receipt_digest !==
      digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.TERMINAL, without(value, "receipt_digest"))
  )
    fail("authority terminal receipt digest mismatch", "authority_terminal");
  return value;
}

export function validateSecretRevocationCandidate(value: SecretRevocationCandidateV1) {
  exactKeys(
    value,
    [
      "schema_version",
      "private_binding_id",
      "scope",
      "scope_identity_digest",
      "package_id",
      "input_id",
      "secret_handle_id_digest",
      "broker_binding_epoch",
      "broker_scope_digest",
      "source_current_head_digest",
      "source_action_root_locator",
      "source_private_input_binding_digest",
      "created_at",
      "binding_digest",
    ],
    [],
    "secret_candidate",
  );
  const expected = digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.SECRET_CANDIDATE, {
    schema_version: value.schema_version,
    scope: value.scope,
    scope_identity_digest: value.scope_identity_digest,
    package_id: value.package_id,
    input_id: value.input_id,
    secret_handle_id_digest: value.secret_handle_id_digest,
    broker_binding_epoch: value.broker_binding_epoch,
    broker_scope_digest: value.broker_scope_digest,
    source_current_head_digest: value.source_current_head_digest,
    source_action_root_locator: value.source_action_root_locator,
    source_private_input_binding_digest: value.source_private_input_binding_digest,
    created_at: value.created_at,
  });
  if (
    value.schema_version !== "1.0" ||
    value.binding_digest !== expected ||
    value.private_binding_id !== `vf-secret-revocation-binding-${expected.slice(7)}`
  )
    fail("secret revocation candidate identity mismatch", "secret_candidate");
  return value;
}
