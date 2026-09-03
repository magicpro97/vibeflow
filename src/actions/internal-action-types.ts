import type { HOST_ACTION_KIND } from "./host-action-contract.js";
import type {
  ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCE,
  AuthorityRepairDomainV1,
} from "./internal-action-vocabulary-contract.js";
import type { StrictLegacyAdoptCandidateV1 } from "./legacy-adopt-types.js";
import type {
  ACTION_PREVIEW_PROJECTOR_VERSION,
  ACTION_RISK,
  ActionScope,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "./public-action-contract.js";
import type {
  HostActionRequestV1,
  PolicyJsonValueV1,
  PublicCompactionInputV1,
} from "./request-types.js";
import type { CapabilityScope } from "./types.js";

export interface SuspectedLiteralPublicationBindingV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  private_staging_id: string;
  staging_record_digest: string;
  staged_content_digest: string;
  findings_digest: string;
  projector_version: typeof ACTION_PREVIEW_PROJECTOR_VERSION;
  rules_digest: string;
  staged_at: string;
  expires_at: string;
}
export interface OversizedHandoffCandidateV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
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
export type { AuthorityRepairDomainV1 } from "./internal-action-vocabulary-contract.js";
export type AuthorityRepairApprovedTargetPreimageV1 =
  | {
      presence: typeof ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCE.PRESENT;
      corrupt_bytes_sha256: string;
      quarantine_ref: string;
      absence_evidence_digest: null;
    }
  | {
      presence: typeof ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCE.ABSENT;
      corrupt_bytes_sha256: null;
      quarantine_ref: null;
      absence_evidence_digest: string;
    };
export interface AuthorityRepairPlanV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  repair_id: string;
  domain: AuthorityRepairDomainV1;
  authority_scope: ActionScope;
  scope_id: string;
  target_preimage: AuthorityRepairApprovedTargetPreimageV1;
  last_valid_record_digest: string;
  proposed_restored_authority_digest: string;
  lost_tail_digest: string | null;
  journal_identity_digest: string | null;
  repair_steps_digest: string;
  repair_authorization_binding_digest: string;
  permission_digest: string;
  risk: typeof ACTION_RISK.CRITICAL;
  created_at: string;
  expires_at: string;
  plan_digest: string;
}
export type LegacyAdoptCandidateV1 = StrictLegacyAdoptCandidateV1;

export type InternalStagedHostActionV1 =
  | {
      type: typeof HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL;
      binding: SuspectedLiteralPublicationBindingV1;
    }
  | {
      type: typeof HOST_ACTION_KIND.CONVERSATION_ABANDON_REVISION_OPERATION;
      revision_operation_id: string;
      expected_header_digest: string;
    }
  | {
      type: typeof HOST_ACTION_KIND.CONVERSATION_RETRY_REVISION_OPERATION;
      revision_operation_id: string;
      expected_header_digest: string;
      expected_head_digest: string;
    }
  | {
      type: typeof HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION;
      revision_operation_id: string;
      expected_header_digest: string;
      expected_state_digest: string;
      expected_effect_action_operation_id: string;
    }
  | {
      type: typeof HOST_ACTION_KIND.CONTEXT_COMPACT;
      oversized_candidate: OversizedHandoffCandidateV1;
      profile: PublicCompactionInputV1["profile"];
      compaction_input: PublicCompactionInputV1;
    }
  | {
      type: typeof HOST_ACTION_KIND.CAPABILITY_ADOPT;
      scope: CapabilityScope;
      candidate: LegacyAdoptCandidateV1;
    }
  | {
      type: typeof HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY;
      scope: CapabilityScope;
      change: PolicyAuthorityChangeV1;
    }
  | {
      type: typeof HOST_ACTION_KIND.SECRET_REVOKE;
      scope: CapabilityScope;
      private_binding_ref: string;
      expected_binding_digest: string;
    }
  | { type: typeof HOST_ACTION_KIND.AUTHORITY_REPAIR; plan: AuthorityRepairPlanV1 };

export type InternalStagedHostActionKind = InternalStagedHostActionV1["type"];

export type HostActionV1 =
  | Exclude<HostActionRequestV1, { type: InternalStagedHostActionKind }>
  | InternalStagedHostActionV1;
