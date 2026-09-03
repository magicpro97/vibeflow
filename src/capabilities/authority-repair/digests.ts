import { digestV1 } from "../../durability/index.js";
import {
  AUTHORITY_REPAIR_DIGEST_DOMAIN,
  AUTHORITY_REPAIR_SCHEMA_VERSION,
  AUTHORITY_REPAIR_STRATEGY,
} from "./contract.js";
import type { AuthorityRepairActionPlanBindingV1, AuthorityRepairStepsV1 } from "./types.js";

export type AuthorityRepairStepsPreimageV1 =
  | Omit<AuthorityRepairStepsV1, "steps_digest">
  | AuthorityRepairStepsV1;

export function authorityRepairActionPlanDigest(value: AuthorityRepairActionPlanBindingV1): string {
  return digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.ACTION_PLAN, value);
}

export function authorityRepairRestoreSourceRef(steps: AuthorityRepairStepsPreimageV1): string {
  return digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.RESTORE_SOURCE, {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: steps.domain,
    authority_scope: steps.authority_scope,
    scope_id: steps.scope_id,
    journal_identity_digest: steps.journal_identity_digest,
    restore_bytes_sha256: steps.restore_bytes_sha256,
    last_valid_record_digest: steps.last_valid_record_digest,
  });
}

export function authorityRepairQuarantineRef(steps: AuthorityRepairStepsPreimageV1): string | null {
  if (steps.target_preimage.presence !== "present") return null;
  return digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.QUARANTINE, {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: steps.domain,
    authority_scope: steps.authority_scope,
    scope_id: steps.scope_id,
    journal_identity_digest: steps.journal_identity_digest,
    corrupt_bytes_sha256: steps.target_preimage.corrupt_bytes_sha256,
  });
}

export function authorityRepairLostTailDigest(
  steps: AuthorityRepairStepsPreimageV1,
): string | null {
  if (steps.lost_tail_sha256 === null) return null;
  if (steps.target_preimage.presence !== "present")
    throw new Error("absent repair cannot bind lost-tail bytes");
  return digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.LOST_TAIL, {
    corrupt_bytes_sha256: steps.target_preimage.corrupt_bytes_sha256,
    last_valid_record_digest: steps.last_valid_record_digest,
    lost_tail_sha256: steps.lost_tail_sha256,
  });
}

export function authorityRepairJsonExpectedPointer(steps: AuthorityRepairStepsPreimageV1): string {
  if (steps.target_preimage.presence === "present")
    return digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.JSON_HEAD_CURRENT, {
      schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
      domain: steps.domain,
      authority_scope: steps.authority_scope,
      scope_id: steps.scope_id,
      current_bytes_sha256: steps.target_preimage.corrupt_bytes_sha256,
    });
  return digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.JSON_HEAD_ABSENT, {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: steps.domain,
    authority_scope: steps.authority_scope,
    scope_id: steps.scope_id,
    target_locator: steps.target_locator,
    absence_evidence_digest: steps.target_preimage.absence_evidence_digest,
  });
}

export function authorityRepairJsonReplacementPointer(
  steps: AuthorityRepairStepsPreimageV1,
): string {
  return digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.JSON_HEAD_CURRENT, {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: steps.domain,
    authority_scope: steps.authority_scope,
    scope_id: steps.scope_id,
    current_bytes_sha256: steps.restore_bytes_sha256,
  });
}

export function authorityRepairProposedRestoredDigest(steps: AuthorityRepairStepsV1): string {
  if (steps.strategy === AUTHORITY_REPAIR_STRATEGY.REPLACE_AUTHORITY_EPOCH_COMPOUND)
    return digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.COMPOUND_PROPOSED_STATE, {
      schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
      domain: "authority-epoch",
      authority_scope: steps.authority_scope,
      scope_id: steps.scope_id,
      authority_epoch_repair_base_digest: steps.authority_epoch_repair_base_digest,
    });
  return digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.PROPOSED_STATE, {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: steps.domain,
    authority_scope: steps.authority_scope,
    scope_id: steps.scope_id,
    strategy: steps.strategy,
    restore_bytes_sha256: steps.restore_bytes_sha256,
    last_valid_record_digest: steps.last_valid_record_digest,
    replacement_current_pointer_digest: steps.replacement_current_pointer_digest,
    recovery_link_digest: steps.recovery_link_digest,
  });
}
