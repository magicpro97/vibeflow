import type {
  AuthorityRepairApprovedTargetPreimageV1,
  AuthorityRepairPlanV1,
} from "../../actions/internal-action-types.js";
import type { AuthorityRepairDomainV1 } from "../../actions/internal-action-vocabulary-contract.js";
import type { ActionDomain, ActionScope } from "../../actions/public-action-vocabulary-contract.js";
import type {
  ActionApprovalV1,
  ActionEffectClass,
  ActionPlanningOptionsV1,
  ActionProposalV1,
  PrivateActionRootLocatorV1,
  PublicActor,
  Reversibility,
} from "../../actions/types.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import type {
  AUTHORITY_REPAIR_CONTENT_TARGET_KIND,
  AUTHORITY_REPAIR_EVENT_STATE,
  AUTHORITY_REPAIR_JOURNAL_SOURCE_KIND,
  AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND,
  AUTHORITY_REPAIR_OBJECT_SCHEMA_ID,
  AUTHORITY_REPAIR_PLAN_KIND,
  AUTHORITY_REPAIR_SCHEMA_VERSION,
  AuthorityRepairBindingModeV1,
  AuthorityRepairReasonCodeV1,
  AuthorityRepairStrategyV1,
  AuthorityRepairTerminalStateV1,
  RECOVERY_BOOTSTRAP_IDENTITY_KIND,
  RECOVERY_BOOTSTRAP_PAYLOAD_KIND,
} from "./contract.js";

export interface AuthorityRepairActionPlanBindingV1 {
  schema_version: typeof AUTHORITY_REPAIR_SCHEMA_VERSION;
  domain: ActionDomain;
  action_root_locator: PrivateActionRootLocatorV1;
  planning_options: ActionPlanningOptionsV1;
  execution_object_closure_digest: null;
  permission_digest: string;
  steps: [
    {
      order: 0;
      step_id: string;
      plan_kind: typeof AUTHORITY_REPAIR_PLAN_KIND;
      plan_digest: string;
      target_ids: string[];
      effect_classes: ActionEffectClass[];
      reversibility: Reversibility;
    },
  ];
}

export interface AuthorityRepairActionObjectClosureV1 {
  authorization: RepairAuthorizationBindingV1;
  steps: AuthorityRepairStepsV1;
  plan: AuthorityRepairPlanV1;
  action_plan: AuthorityRepairActionPlanBindingV1;
}

export interface AuthorityRepairActionObjectsV1 {
  authorization: RepairAuthorizationBindingV1;
  plan: AuthorityRepairPlanV1;
  action_plan: AuthorityRepairActionPlanBindingV1;
}

export interface RepairAuthorizationBindingV1 {
  schema_version: typeof AUTHORITY_REPAIR_SCHEMA_VERSION;
  mode: AuthorityRepairBindingModeV1;
  control_scope: CapabilityScope;
  control_scope_identity_digest: string;
  authority_epoch: number;
  authority_head_digest: string;
  authority_head_checkpoint_digest: string | null;
  target_domain: AuthorityRepairDomainV1;
  target_authority_scope: ActionScope;
  target_scope_id: string;
  binding_digest: string;
}

export type AuthorityRepairJournalSourceSelectorV1 =
  | { kind: typeof AUTHORITY_REPAIR_JOURNAL_SOURCE_KIND.CANONICAL }
  | {
      kind: typeof AUTHORITY_REPAIR_JOURNAL_SOURCE_KIND.RECOVERY_GENERATION;
      expected_current_pointer_digest: string;
      generation_id: string;
      generation_digest: string;
    };

export type AuthorityRepairJsonHeadTargetV1 =
  | {
      kind: typeof AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND.CONVERSATION_MANIFEST;
      conversation_id: string;
    }
  | {
      kind: typeof AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND.LINEAGE_HEAD;
      root_session_id: string;
      lineage_storage_key: string;
    }
  | {
      kind: typeof AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND.LINEAGE_RESERVATION;
      root_session_id: string;
      lineage_storage_key: string;
    }
  | {
      kind: typeof AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND.CAPABILITY_LOCK;
      scope: CapabilityScope;
      scope_identity_digest: string;
    }
  | { kind: typeof AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND.SCOPE_IDENTITY; scope: CapabilityScope }
  | {
      kind: typeof AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND.AUTHORITY_EPOCH_ZERO_HEAD;
      scope: CapabilityScope;
      scope_identity_digest: string;
    };

export type AuthorityRepairContentTargetV1 =
  | {
      kind: typeof AUTHORITY_REPAIR_CONTENT_TARGET_KIND.CONVERSATION_OBJECT;
      object_schema_id: string;
      record_digest: string;
    }
  | {
      kind: typeof AUTHORITY_REPAIR_CONTENT_TARGET_KIND.LINEAGE_ASSOCIATION;
      association_id: string;
      record_digest: string;
    }
  | {
      kind: typeof AUTHORITY_REPAIR_CONTENT_TARGET_KIND.REVISION_OPERATION_HEADER;
      operation_id: string;
      record_digest: string;
    }
  | {
      kind: typeof AUTHORITY_REPAIR_CONTENT_TARGET_KIND.ACTION_RECORD;
      key: Readonly<Record<string, unknown>>;
    }
  | {
      kind: typeof AUTHORITY_REPAIR_CONTENT_TARGET_KIND.ACTION_BLOB;
      blob_kind: string;
      content_digest: string;
      raw_sha256: string;
      byte_length: number;
      binding_record_digest: string;
    }
  | {
      kind: typeof AUTHORITY_REPAIR_CONTENT_TARGET_KIND.CAPABILITY_GENERATION;
      generation_id: string;
      record_digest: string;
    }
  | {
      kind: typeof AUTHORITY_REPAIR_CONTENT_TARGET_KIND.CAPABILITY_OBJECT;
      object_schema_id: string;
      record_digest: string;
    }
  | {
      kind: typeof AUTHORITY_REPAIR_CONTENT_TARGET_KIND.CAPABILITY_RUNTIME_EVIDENCE_BLOB;
      content_digest: string;
      raw_sha256: string;
      byte_length: number;
      binding_digest: string;
    }
  | {
      kind: typeof AUTHORITY_REPAIR_CONTENT_TARGET_KIND.CAPABILITY_RUNTIME_EVIDENCE_BINDING;
      content_digest: string;
      binding_digest: string;
    }
  | {
      kind: typeof AUTHORITY_REPAIR_CONTENT_TARGET_KIND.CAPABILITY_OPERATION_HEADER;
      operation_id: string;
      record_digest: string;
    }
  | {
      kind: typeof AUTHORITY_REPAIR_CONTENT_TARGET_KIND.CAPABILITY_OUTBOX_PAYLOAD;
      public_payload_digest: string;
    }
  | {
      kind: typeof AUTHORITY_REPAIR_CONTENT_TARGET_KIND.AUTHORITY_CHANGE_OPERATION_HEADER;
      operation_id: string;
      record_digest: string;
    }
  | {
      kind: typeof AUTHORITY_REPAIR_CONTENT_TARGET_KIND.AUTHORITY_REPAIR_HEADER;
      operation_id: string;
      record_digest: string;
    }
  | {
      kind: typeof AUTHORITY_REPAIR_CONTENT_TARGET_KIND.AUTHORITY_REPAIR_OBJECT;
      object_schema_id: (typeof AUTHORITY_REPAIR_OBJECT_SCHEMA_ID)[keyof typeof AUTHORITY_REPAIR_OBJECT_SCHEMA_ID];
      record_digest: string;
    };

export type AuthorityRepairNonCompoundTargetLocatorV1 =
  | {
      strategy: "replace-json-head";
      target: AuthorityRepairJsonHeadTargetV1;
    }
  | {
      strategy: "new-journal-generation";
      journal_identity_digest: string;
      source_selector: AuthorityRepairJournalSourceSelectorV1;
    }
  | {
      strategy: "restore-content-addressed-object";
      target: AuthorityRepairContentTargetV1;
    };

export interface AuthorityRepairAbsenceEvidenceV1 {
  schema_version: typeof AUTHORITY_REPAIR_SCHEMA_VERSION;
  domain: AuthorityRepairDomainV1;
  authority_scope: ActionScope;
  scope_id: string;
  target_locator: Extract<
    AuthorityRepairNonCompoundTargetLocatorV1,
    { strategy: "replace-json-head" | "restore-content-addressed-object" }
  >;
  observed_at: string;
  evidence_digest: string;
}

export interface AuthorityRepairStepsV1 {
  schema_version: typeof AUTHORITY_REPAIR_SCHEMA_VERSION;
  domain: AuthorityRepairDomainV1;
  authority_scope: ActionScope;
  scope_id: string;
  strategy: AuthorityRepairStrategyV1;
  target_locator: AuthorityRepairNonCompoundTargetLocatorV1 | null;
  target_preimage: AuthorityRepairApprovedTargetPreimageV1;
  restore_source_ref: string;
  restore_bytes_sha256: string;
  last_valid_record_digest: string;
  lost_tail_sha256: string | null;
  lost_tail_digest: string | null;
  expected_current_pointer_digest: string | null;
  replacement_current_pointer_digest: string | null;
  recovery_link_digest: string | null;
  journal_identity_digest: string | null;
  authority_epoch_repair_base_digest: string | null;
  steps_digest: string;
}

export interface AuthorityEpochRepairBaseV1 {
  schema_version: typeof AUTHORITY_REPAIR_SCHEMA_VERSION;
  authority_scope: CapabilityScope;
  scope_id: string;
  head_corrupt_bytes_sha256: string;
  head_quarantine_ref: string;
  head_restore_source_ref: string;
  restored_head_bytes_sha256: string;
  restored_head_digest: string;
  head_expected_current_pointer_digest: string;
  head_replacement_pointer_digest: string;
  event_journal_identity_digest: string;
  event_source_selector: AuthorityRepairJournalSourceSelectorV1;
  event_corrupt_bytes_sha256: string;
  event_quarantine_ref: string;
  event_restore_source_ref: string;
  event_restore_bytes_sha256: string;
  event_last_valid_record_digest: string | null;
  event_lost_tail_sha256: string | null;
  event_lost_tail_digest: string | null;
  event_expected_current_pointer_digest: string | null;
  event_repair_base_generation_digest: string;
  event_repair_base_pointer_digest: string;
  base_digest: string;
}

export interface AuthorityRepairOperationV1 {
  schema_version: typeof AUTHORITY_REPAIR_SCHEMA_VERSION;
  repair_id: string;
  operation_id: string;
  proposal_id: string;
  proposal_digest: string;
  plan_digest: string;
  action_plan_binding_digest: string;
  action_root_locator: PrivateActionRootLocatorV1;
  domain: AuthorityRepairPlanV1["domain"];
  authority_scope: AuthorityRepairPlanV1["authority_scope"];
  scope_id: string;
  target_preimage: AuthorityRepairApprovedTargetPreimageV1;
  last_valid_record_digest: string;
  proposed_restored_authority_digest: string;
  repair_authorization_binding_digest: string;
  permission_digest: string;
  approval_id: string;
  approval_digest: string;
  created_by: PublicActor;
  created_at: string;
  header_digest: string;
}

export interface AuthorityRepairEventV1 {
  schema_version: typeof AUTHORITY_REPAIR_SCHEMA_VERSION;
  repair_id: string;
  operation_id: string;
  header_digest: string;
  sequence: number;
  previous_event_digest: string | null;
  state: (typeof AUTHORITY_REPAIR_EVENT_STATE)[keyof typeof AUTHORITY_REPAIR_EVENT_STATE];
  observed_authority_digest: string | null;
  reason_code: AuthorityRepairReasonCodeV1 | null;
  recorded_at: string;
  event_digest: string;
}

export interface RecoveryBootstrapIdentityV1 {
  schema_version: typeof AUTHORITY_REPAIR_SCHEMA_VERSION;
  bootstrap_id: string;
  created_at: string;
  content_digest: string;
}

export interface RecoveryBootstrapActivationReceiptV1 {
  schema_version: typeof AUTHORITY_REPAIR_SCHEMA_VERSION;
  identity_kind: typeof RECOVERY_BOOTSTRAP_IDENTITY_KIND;
  scope: null;
  scope_identity_digest: null;
  bootstrap_identity_digest: string;
  initial_authority_head_digest: null;
  initial_journal_byte_length: 0;
  initial_journal_sha256: string;
  identity_created_at: string;
  receipt_digest: string;
}

export type RecoveryBootstrapPayloadV1 =
  | {
      kind: typeof RECOVERY_BOOTSTRAP_PAYLOAD_KIND.PROPOSAL_CREATED;
      proposal: ActionProposalV1;
      repair_plan_digest: string;
    }
  | {
      kind: typeof RECOVERY_BOOTSTRAP_PAYLOAD_KIND.APPROVAL_DECISION;
      proposal_id: string;
      from: "pending_review";
      to: "approved" | "denied";
      approval: ActionApprovalV1;
    }
  | {
      kind: typeof RECOVERY_BOOTSTRAP_PAYLOAD_KIND.REPAIR_DISPATCH;
      proposal_id: string;
      operation: AuthorityRepairOperationV1;
    }
  | {
      kind: typeof RECOVERY_BOOTSTRAP_PAYLOAD_KIND.TERMINAL_MIRROR;
      proposal_id: string;
      repair_id: string;
      operation_id: string;
      header_digest: string;
      outcome: AuthorityRepairTerminalStateV1;
      authority_repair_event_digest: string;
      previous_mirrored_event_digest: string | null;
    };

export interface RecoveryBootstrapEventV1 {
  schema_version: typeof AUTHORITY_REPAIR_SCHEMA_VERSION;
  bootstrap_identity_digest: string;
  sequence: number;
  previous_event_digest: string | null;
  payload: RecoveryBootstrapPayloadV1;
  recorded_at: string;
  event_digest: string;
}
