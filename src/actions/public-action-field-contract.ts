import { PUBLIC_OPERATION_PROGRESS_FIELDS } from "./public-operation-field-contract.js";

const fields = <const Field extends readonly string[]>(...field: Field) => Object.freeze(field);

export const ACTION_PROPOSAL_REQUEST_FIELDS = fields(
  "schema_version",
  "idempotency_key",
  "anchor_event_id",
  "expected",
  "candidate",
);
export const ACTION_WRITABLE_REVISION_EXPECTATION_FIELDS = fields(
  "mode",
  "conversation_id",
  "revision_id",
  "last_seq",
  "conversation_lock_digest",
);
export const ACTION_LINEAGE_RECOVERY_EXPECTATION_FIELDS = fields(
  "mode",
  "root_session_id",
  "conversation_id",
  "revision_id",
  "last_seq",
  "conversation_lock_digest",
  "lineage_head_digest",
  "lineage_head_epoch",
);
export const ACTION_EXPECTED_SOURCE_OPTIONAL_FIELDS = fields(
  "root_session_id",
  "conversation_id",
  "revision_id",
  "last_seq",
  "conversation_lock_digest",
  "lineage_head_digest",
  "lineage_head_epoch",
);
export const ACTION_APPROVAL_CHALLENGE_REQUEST_FIELDS = fields(
  "schema_version",
  "proposal_digest",
  "challenge_class",
);
export const ACTION_APPROVAL_REQUEST_FIELDS = fields(
  "schema_version",
  "proposal_digest",
  "decision",
  "challenge_id",
  "challenge_response",
);
export const ACTION_COMMIT_REQUEST_FIELDS = fields(
  "schema_version",
  "proposal_digest",
  "approval_id",
);
export const ACTION_CANCEL_REQUEST_FIELDS = fields("schema_version", "proposal_digest", "reason");
export const ACTION_PROPOSAL_RESPONSE_FIELDS = fields(
  "schema_version",
  "proposal",
  "approval",
  "operation",
);
export const ACTION_APPROVAL_CHALLENGE_RESPONSE_FIELDS = fields(
  "schema_version",
  "challenge_id",
  "challenge_class",
  "display_phrase",
  "expires_at",
);
export const ACTION_APPROVAL_RESPONSE_FIELDS = fields("schema_version", "approval", "operation");
export const ACTION_MUTATION_RESPONSE_FIELDS = fields("schema_version", "operation");
export const PENDING_ACTION_RESPONSE_FIELDS = fields(
  "schema_version",
  "items",
  "next_cursor",
  "authority_watermark",
);
export const TIMELINE_RESPONSE_FIELDS = fields(
  "schema_version",
  "root_session_id",
  "head",
  "head_epoch",
  "head_digest",
  "items",
  "next_cursor",
);
export const TIMELINE_HEAD_FIELDS = fields("conversation_id", "revision_id", "revision_ordinal");
export const TIMELINE_BOUNDARY_FIELDS = fields(
  "kind",
  "boundary_id",
  "from",
  "to",
  "handoff_id",
  "prompt_projection_digest",
);
export const TIMELINE_START_FIELDS = fields(
  "kind",
  "revision_ordinal",
  "conversation_id",
  "revision_id",
  "anchor_id",
  "action_operations",
);
export const TIMELINE_EVENT_FIELDS = fields(
  "kind",
  "revision_ordinal",
  "event",
  "interaction",
  "action_operations",
);
export const ACTION_OPERATIONS_PAGE_FIELDS = fields(
  "schema_version",
  "items",
  "next_cursor",
  "proposal_set_watermark",
);
export const ACTION_OPERATION_EVENTS_RESPONSE_FIELDS = fields(
  "schema_version",
  "items",
  "next_cursor",
);
export const ACTION_DOMAIN_TERMINAL_RECEIPT_FIELDS = fields(
  "schema_version",
  "operation_id",
  "proposal_id",
  "proposal_digest",
  "dispatch_record_digest",
  "outcome",
  "reason_code",
  "recorded_at",
  "receipt_digest",
);
export const ACTION_PROPOSAL_FIELDS = fields(
  "schema_version",
  "proposal_id",
  "proposal_digest",
  "origin_event_id",
  "action_type",
  "domain",
  "scope",
  "authority_binding_mode",
  "risk",
  "effect_classes",
  "targets",
  "package_pins",
  "adapter_set_digest",
  "plan_digest",
  "policy_digest",
  "permission_digest",
  "reversibility",
  "preview",
  "created_at",
  "expires_at",
);
export const ACTION_APPROVAL_FIELDS = fields(
  "schema_version",
  "approval_id",
  "approval_digest",
  "proposal_id",
  "proposal_digest",
  "decision",
  "challenge_class",
  "decided_by",
  "decided_at",
  "expires_at",
);
export const ACTION_OPERATION_FIELDS = fields(
  "schema_version",
  "operation_id",
  "proposal_id",
  "proposal_digest",
  "approval_id",
  "approval_digest",
  "correlation_id",
  "domain",
  "state",
  "phase_sequence",
  "latest_event_cursor",
  "progress",
  "targets",
  "delivery",
  "result_ref",
  "error",
  "recovery_actions",
  "created_at",
  "updated_at",
);
export const ACTION_PROGRESS_FIELDS = PUBLIC_OPERATION_PROGRESS_FIELDS;
export const ACTION_PACKAGE_PIN_FIELDS = fields(
  "id",
  "version",
  "source_kind",
  "content_sha256",
  "trust",
  "nonportable",
  "pin_digest",
);
export const ACTION_PREVIEW_FIELDS = fields(
  "title",
  "summary",
  "action_type",
  "planning_options",
  "review_fields",
  "targets",
  "target_dispositions",
  "package_pins",
  "permission_delta",
  "dependency_delta",
  "config_diffs",
  "effect_classes",
  "enforcement",
  "reversibility",
  "health_plan",
  "recovery_actions",
  "projector_version",
  "rules_digest",
  "redaction_manifest_digest",
);
export const ACTION_PLANNING_OPTIONS_FIELDS = fields("mode", "network_read");
export const ACTION_REVIEW_FIELD_FIELDS = fields(
  "json_pointer",
  "label",
  "before",
  "after",
  "private_binding_digest",
);
export const ACTION_TARGET_DISPOSITION_FIELDS = fields("target_id", "execution", "reason_code");
export const ACTION_TARGET_BINDING_FIELDS = fields("target_id", "target", "subject");
export const ACTION_PERMISSION_DELTA_FIELDS = fields(
  "permission_id",
  "change",
  "public_scope",
  "enforcement",
);
export const ACTION_DEPENDENCY_DELTA_FIELDS = fields(
  "package_id",
  "change",
  "from_version",
  "to_version",
);
export const ACTION_CONFIG_DIFF_FIELDS = fields(
  "target",
  "target_ids",
  "mode",
  "before_digest",
  "after_digest",
  "bounded_before",
  "bounded_after",
);
export const ACTION_ENFORCEMENT_FIELDS = fields(
  "permission_id",
  "engine",
  "enforcement",
  "explanation",
);
export const ACTION_HEALTH_PLAN_FIELDS = fields(
  "probe_id",
  "kind",
  "evidence_schema_id",
  "target_ids",
  "required",
  "effect_classes",
  "permission_ids",
  "enforcement_digest",
  "timeout_ms",
  "retries",
  "evidence_valid_for_ms",
);
export const PUBLIC_ACTOR_FIELDS = fields("kind", "public_actor_id", "credential_class");
