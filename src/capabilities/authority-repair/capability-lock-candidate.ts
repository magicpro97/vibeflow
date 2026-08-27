import { createHash } from "node:crypto";
import { ACTION_AUTHORITY_REPAIR_DOMAIN as D } from "../../actions/internal-action-vocabulary-contract.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import type { CapabilityLockRepairSourceV1 } from "./capability-lock-source.js";
import {
  AUTHORITY_REPAIR_CONTROL_STATE,
  AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND,
  AUTHORITY_REPAIR_LIMIT,
  AUTHORITY_REPAIR_SCHEMA_VERSION,
  AUTHORITY_REPAIR_STRATEGY,
} from "./contract.js";
import {
  authorityRepairJsonExpectedPointer,
  authorityRepairJsonReplacementPointer,
  authorityRepairQuarantineRef,
  authorityRepairRestoreSourceRef,
} from "./digests.js";
import type { AuthorityRepairPreparedCandidateV1 } from "./production-registry.js";
import { materializeAuthorityRepairAbsenceEvidence } from "./repair-objects.js";
import type { AuthorityRepairStepsV1 } from "./types.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function materializeCapabilityLockRepairCandidateV1(
  source: CapabilityLockRepairSourceV1,
  now: () => string,
): AuthorityRepairPreparedCandidateV1 {
  const createdAt = now();
  const expiresAt = new Date(
    Date.parse(createdAt) + AUTHORITY_REPAIR_LIMIT.PLAN_TTL_MS,
  ).toISOString();
  const targetLocator = {
    strategy: AUTHORITY_REPAIR_STRATEGY.REPLACE_JSON_HEAD,
    target: {
      kind: AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND.CAPABILITY_LOCK,
      scope: source.paths.scope,
      scope_identity_digest: source.scope_identity_digest,
    },
  } as const;
  const absence =
    source.target_bytes === null
      ? materializeAuthorityRepairAbsenceEvidence({
          schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
          domain: D.CAPABILITY_LOCK,
          authority_scope: source.paths.scope,
          scope_id: source.scope_identity_digest,
          target_locator: targetLocator,
          observed_at: createdAt,
        })
      : null;
  const steps: Omit<AuthorityRepairStepsV1, "steps_digest"> = {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: D.CAPABILITY_LOCK,
    authority_scope: source.paths.scope,
    scope_id: source.scope_identity_digest,
    strategy: AUTHORITY_REPAIR_STRATEGY.REPLACE_JSON_HEAD,
    target_locator: targetLocator,
    target_preimage:
      source.target_bytes === null
        ? {
            presence: "absent",
            corrupt_bytes_sha256: null,
            quarantine_ref: null,
            absence_evidence_digest: (absence as NonNullable<typeof absence>).evidence_digest,
          }
        : {
            presence: "present",
            corrupt_bytes_sha256: sha256(source.target_bytes),
            quarantine_ref: "",
            absence_evidence_digest: null,
          },
    restore_source_ref: "",
    restore_bytes_sha256: sha256(source.checkpoint_bytes),
    last_valid_record_digest: source.checkpoint.content_digest,
    lost_tail_sha256: null,
    lost_tail_digest: null,
    expected_current_pointer_digest: "",
    replacement_current_pointer_digest: "",
    recovery_link_digest: null,
    journal_identity_digest: null,
    authority_epoch_repair_base_digest: null,
  };
  if (steps.target_preimage.presence === "present") {
    const quarantineRef = authorityRepairQuarantineRef(steps);
    if (!quarantineRef) throw new Error("present capability-lock repair has no quarantine ref");
    steps.target_preimage.quarantine_ref = quarantineRef;
  }
  steps.restore_source_ref = authorityRepairRestoreSourceRef(steps);
  steps.expected_current_pointer_digest = authorityRepairJsonExpectedPointer(steps);
  steps.replacement_current_pointer_digest = authorityRepairJsonReplacementPointer(steps);
  const candidateDigest = digestV1("VF-CAPABILITY-LOCK-REPAIR-CANDIDATE\0v1\0", {
    scope: source.paths.scope,
    scope_identity_digest: source.scope_identity_digest,
    authority_head_digest: source.authority.authority_head_digest,
    checkpoint_digest: source.checkpoint.content_digest,
    target_preimage: steps.target_preimage,
  });
  return Object.freeze({
    candidate_id: `vf-repair-candidate-${digestHex(candidateDigest)}`,
    conversation_id: null,
    checkpoint_digest: source.checkpoint.content_digest,
    control_state: AUTHORITY_REPAIR_CONTROL_STATE.CURRENT_VALID,
    authorization: {
      schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
      control_scope: source.paths.scope,
      control_scope_identity_digest: source.scope_identity_digest,
      authority_epoch: source.authority.authority_epoch,
      authority_head_digest: source.authority.authority_head_digest,
      authority_head_checkpoint_digest: null,
      target_domain: D.CAPABILITY_LOCK,
      target_authority_scope: source.paths.scope,
      target_scope_id: source.scope_identity_digest,
    },
    steps,
    proposal_base: {
      root_session_id: null,
      conversation_id: null,
      revision_id: null,
      last_seq: null,
      conversation_lock_digest: null,
      lineage_head_digest: null,
      lineage_head_epoch: null,
      capability_scope: source.paths.scope,
      capability_generation_ordinal: null,
      capability_generation_id: null,
      capability_lock_digest: null,
      capability_parent_generation_digests: [],
      user_prerequisites: [],
    },
    policy_digest: source.authority.policy_digest,
    grant_digest: source.authority.grant_digest,
    restore_bytes: Buffer.from(source.checkpoint_bytes),
    epoch_base: null,
    created_at: createdAt,
    expires_at: expiresAt,
  });
}
