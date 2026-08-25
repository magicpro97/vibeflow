import type { StrictLegacyAdoptCandidateV1 } from "./legacy-adopt-types.js";
import type {
  HostActionRequestV1,
  PolicyJsonValueV1,
  PublicCompactionInputV1,
} from "./request-types.js";
import type { CapabilityScope } from "./types.js";

type StagedActionKind =
  | "conversation.publish_suspected_literal"
  | "conversation.abandon_revision_operation"
  | "conversation.retry_revision_operation"
  | "conversation.reconcile_revision_operation"
  | "context.compact"
  | "capability.adopt"
  | "policy.update_authority"
  | "secret.revoke"
  | "authority.repair";

export interface SuspectedLiteralPublicationBindingV1 {
  schema_version: "1.0";
  private_staging_id: string;
  staging_record_digest: string;
  staged_content_digest: string;
  findings_digest: string;
  projector_version: "vf-public-projector/1";
  rules_digest: string;
  staged_at: string;
  expires_at: string;
}
export interface OversizedHandoffCandidateV1 {
  schema_version: "1.0";
  candidate_id: string;
  source: {
    conversation_id: string;
    revision_id: string;
    last_seq: number;
    lock_digest: string;
  };
  source_public_head_digest: string;
  selection_plan_digest: string;
  mandatory_projection_digest: string;
  prompt_budget_bytes: number;
  encoded_candidate_bytes: number;
  overflow_bytes: number;
  private_candidate_ref: string;
  created_at: string;
  expires_at: string;
  candidate_digest: string;
}
export interface PolicyAuthorityChangeV1 {
  scope: CapabilityScope;
  scope_identity_digest: string;
  settings_schema_version: string;
  expected_settings_sha256: string;
  replacement_settings_sha256: string;
  expected_policy_digest: string;
  replacement_authority_subtree: PolicyJsonValueV1;
  replacement_policy_digest: string;
}
export type AuthorityRepairDomainV1 =
  | "conversation-manifest"
  | "conversation-journal"
  | "conversation-content"
  | "lineage-head"
  | "lineage-reservation"
  | "lineage-association"
  | "revision-operation"
  | "action-authority"
  | "capability-lock"
  | "capability-operation"
  | "capability-outbox"
  | "scope-identity"
  | "authority-epoch"
  | "grant-authority"
  | "policy-authority"
  | "registry-trust"
  | "secret-revocation"
  | "authority-repair";
export type AuthorityRepairApprovedTargetPreimageV1 =
  | {
      presence: "present";
      corrupt_bytes_sha256: string;
      quarantine_ref: string;
      absence_evidence_digest: null;
    }
  | {
      presence: "absent";
      corrupt_bytes_sha256: null;
      quarantine_ref: null;
      absence_evidence_digest: string;
    };
export interface AuthorityRepairPlanV1 {
  schema_version: "1.0";
  repair_id: string;
  domain: AuthorityRepairDomainV1;
  authority_scope: "conversation" | "project" | "user";
  scope_id: string;
  target_preimage: AuthorityRepairApprovedTargetPreimageV1;
  last_valid_record_digest: string;
  proposed_restored_authority_digest: string;
  lost_tail_digest: string | null;
  journal_identity_digest: string | null;
  repair_steps_digest: string;
  repair_authorization_binding_digest: string;
  permission_digest: string;
  risk: "critical";
  created_at: string;
  expires_at: string;
  plan_digest: string;
}
export type LegacyAdoptCandidateV1 = StrictLegacyAdoptCandidateV1;

export type HostActionV1 =
  | Exclude<HostActionRequestV1, { type: StagedActionKind }>
  | {
      type: "conversation.publish_suspected_literal";
      binding: SuspectedLiteralPublicationBindingV1;
    }
  | {
      type: "conversation.abandon_revision_operation";
      revision_operation_id: string;
      expected_header_digest: string;
    }
  | {
      type: "conversation.retry_revision_operation";
      revision_operation_id: string;
      expected_header_digest: string;
      expected_head_digest: string;
    }
  | {
      type: "conversation.reconcile_revision_operation";
      revision_operation_id: string;
      expected_header_digest: string;
      expected_state_digest: string;
      expected_effect_action_operation_id: string;
    }
  | {
      type: "context.compact";
      oversized_candidate: OversizedHandoffCandidateV1;
      profile: "vf-public-compaction/1";
      compaction_input: PublicCompactionInputV1;
    }
  | { type: "capability.adopt"; scope: CapabilityScope; candidate: LegacyAdoptCandidateV1 }
  | { type: "policy.update_authority"; scope: CapabilityScope; change: PolicyAuthorityChangeV1 }
  | {
      type: "secret.revoke";
      scope: CapabilityScope;
      private_binding_ref: string;
      expected_binding_digest: string;
    }
  | { type: "authority.repair"; plan: AuthorityRepairPlanV1 };
