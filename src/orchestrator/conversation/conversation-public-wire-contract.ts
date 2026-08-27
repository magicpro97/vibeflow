import {
  ROLE_SANDBOX,
  ROLE_SANDBOXES,
  ROLE_TOOL_INTENT,
  ROLE_TOOL_INTENTS,
  type RoleSandbox,
  type ToolIntent,
} from "../../core/role-contract.js";
import { SKILL_SOURCE, SKILL_SOURCES, type SkillSource } from "../../core/skill-contract.js";

/**
 * Browser-safe closed vocabularies for the public conversation snapshot and trace wire.
 * Backend DTOs, browser DTOs, and runtime guards must infer from this authority.
 */
export * from "./conversation-handoff-wire-contract.js";
export * from "./conversation-lifecycle-contract.js";
export * from "./conversation-baseline-contract.js";
export * from "./conversation-brainstorm-contract.js";

const frozenValues = <Value extends string>(record: Readonly<Record<string, Value>>) =>
  Object.freeze(Object.values(record)) as readonly Value[];

export type SameUnion<Left, Right> = Exclude<Left, Right> extends never
  ? Exclude<Right, Left> extends never
    ? true
    : false
  : false;

export const CONVERSATION_PUBLIC_SCHEMA_VERSION = "1.0" as const;

export const CONVERSATION_PUBLIC_PROFILE = Object.freeze({
  COMPACTION: "vf-public-compaction/1",
  HANDOFF: "vf-public-handoff/1",
} as const);

export const CONVERSATION_PUBLIC_ARTIFACT_RESOLVER = Object.freeze({
  CONVERSATION: "conversation-artifact-v1",
} as const);

export const CONVERSATION_PUBLIC_ARTIFACT_DELIVERY = Object.freeze({
  INLINE_PUBLIC_TEXT: "inline-public-text",
  RESOLVER: "conversation-artifact-resolver",
} as const);

export const CONVERSATION_PUBLIC_ARTIFACT_KIND = Object.freeze({
  CONVERSATION: "conversation-artifact",
  OMITTED_EVENTS: "omitted-public-events",
} as const);

export const CONVERSATION_PUBLIC_ARTIFACT_REFERENCE_FIELDS = Object.freeze([
  "artifact_id",
  "artifact_kind",
  "byte_length",
  "content_sha256",
  "media_type",
  "resolver",
] as const);

export const CONVERSATION_PUBLIC_HANDOFF_BINDING_FIELDS = Object.freeze([
  "continuity",
  "engine",
  "model",
  "participant_id",
  "role_ref",
] as const);

export const CONVERSATION_PUBLIC_HANDOFF_EVENT_COMMON_FIELDS = Object.freeze([
  "conversation_id",
  "created_at",
  "event_id",
  "public_seq",
  "redaction_manifest_digest",
  "revision_id",
  "revision_ordinal",
  "text",
] as const);

export const CONVERSATION_PUBLIC_HANDOFF_MESSAGE_FIELDS = Object.freeze([
  ...CONVERSATION_PUBLIC_HANDOFF_EVENT_COMMON_FIELDS,
  "author_public_id",
] as const);

export const CONVERSATION_PUBLIC_HANDOFF_RESPONSE_FIELDS = Object.freeze([
  ...CONVERSATION_PUBLIC_HANDOFF_EVENT_COMMON_FIELDS,
  "participant_id",
  "role_ref",
  "terminal_status",
] as const);

export const CONVERSATION_HANDOFF_OPTIONAL_GROUP_FIELDS = Object.freeze([
  "anchor_event_id",
  "anchor_public_seq",
  "anchor_revision_ordinal",
  "artifact_ids",
  "event_ids",
  "group_id",
  "schema_version",
  "source_public_head_digest",
] as const);

export const CONVERSATION_HANDOFF_SELECTION_PLAN_FIELDS = Object.freeze([
  "active_compaction_digest",
  "mandatory_artifact_ids",
  "optional_groups",
  "prompt_budget_bytes",
  "schema_version",
  "selection_digest",
  "source_public_head_digest",
] as const);

export const CONVERSATION_PUBLIC_EVENT_RANGE_FIELDS = Object.freeze([
  "artifact",
  "canonical_events_sha256",
  "event_count",
  "first_event_id",
  "first_public_seq",
  "last_event_id",
  "last_public_seq",
  "revision_id",
  "revision_ordinal",
] as const);

export const CONVERSATION_CONTEXT_HANDOFF_FIELDS = Object.freeze([
  "artifacts",
  "bindings",
  "compaction",
  "consensus",
  "digest",
  "handoff_id",
  "handoff_selection_digest",
  "policy",
  "projection_profile",
  "prompt_projection",
  "prompt_projection_digest",
  "schema_version",
  "source",
  "topic",
  "transcript",
] as const);

export const CONVERSATION_HANDOFF_CONTINUITY = Object.freeze({
  RETAINED: "retained",
  ADDED: "added",
} as const);

export const CONVERSATION_HANDOFF_CONTINUITIES = frozenValues(CONVERSATION_HANDOFF_CONTINUITY);

/** Canonical browser-safe scalar domains used by both trace producers and consumers. */
export const isConversationPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export const isConversationNonnegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0;

export const isConversationScore = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  !Object.is(value, -0) &&
  value >= 0 &&
  value <= 1;

export const isConversationNullableScore = (value: unknown): value is number | null =>
  value === null || isConversationScore(value);

export const CONVERSATION_APPROVAL_OUTCOME = Object.freeze({
  APPROVE: "approve",
  REJECT: "reject",
} as const);
export type ConversationApprovalOutcomeV1 =
  (typeof CONVERSATION_APPROVAL_OUTCOME)[keyof typeof CONVERSATION_APPROVAL_OUTCOME];
export const CONVERSATION_APPROVAL_OUTCOMES = frozenValues(CONVERSATION_APPROVAL_OUTCOME);

export const CONVERSATION_OPERATION_STATE = Object.freeze({
  REQUESTED: "requested",
  DISPATCHED: "dispatched",
  ACKNOWLEDGED: "acknowledged",
  COMPLETED: "completed",
  AMBIGUOUS: "ambiguous",
} as const);
export type ConversationOperationStateV1 =
  (typeof CONVERSATION_OPERATION_STATE)[keyof typeof CONVERSATION_OPERATION_STATE];
export const CONVERSATION_OPERATION_STATES = frozenValues(CONVERSATION_OPERATION_STATE);

export const CONVERSATION_ARTIFACT_TYPE = Object.freeze({
  DECISION_MATRIX: "decision_matrix",
  PLAN: "plan",
  DIFF: "diff",
  TESTS: "tests",
  SYNTHESIS: "synthesis",
  TRANSCRIPT: "transcript",
  COMPACTION: "compaction",
} as const);
export type ConversationArtifactTypeV1 =
  (typeof CONVERSATION_ARTIFACT_TYPE)[keyof typeof CONVERSATION_ARTIFACT_TYPE];
export const CONVERSATION_ARTIFACT_TYPES = frozenValues(CONVERSATION_ARTIFACT_TYPE);

export const CONVERSATION_TOOL_ACTION_STATUS = Object.freeze({
  STARTED: "started",
  COMPLETED: "completed",
  FAILED: "failed",
} as const);
export type ConversationToolActionStatusV1 =
  (typeof CONVERSATION_TOOL_ACTION_STATUS)[keyof typeof CONVERSATION_TOOL_ACTION_STATUS];
export const CONVERSATION_TOOL_ACTION_STATUSES = frozenValues(CONVERSATION_TOOL_ACTION_STATUS);

export const CONVERSATION_ASSESSMENT_STAGE = Object.freeze({
  BLIND: "blind",
  FULL: "full",
} as const);
export type ConversationAssessmentStageV1 =
  (typeof CONVERSATION_ASSESSMENT_STAGE)[keyof typeof CONVERSATION_ASSESSMENT_STAGE];
export const CONVERSATION_ASSESSMENT_STAGES = frozenValues(CONVERSATION_ASSESSMENT_STAGE);

export const CONVERSATION_ROUND_PHASE = Object.freeze({ START: "start", END: "end" } as const);
export type ConversationRoundPhaseV1 =
  (typeof CONVERSATION_ROUND_PHASE)[keyof typeof CONVERSATION_ROUND_PHASE];
export const CONVERSATION_ROUND_PHASES = frozenValues(CONVERSATION_ROUND_PHASE);

export const CONVERSATION_BASELINE_STATUS = Object.freeze({
  SUCCESS: "success",
  FAILED: CONVERSATION_TOOL_ACTION_STATUS.FAILED,
  SKIPPED: "skipped",
} as const);
export type ConversationBaselineStatusV1 =
  (typeof CONVERSATION_BASELINE_STATUS)[keyof typeof CONVERSATION_BASELINE_STATUS];
export const CONVERSATION_BASELINE_STATUSES = frozenValues(CONVERSATION_BASELINE_STATUS);

export const CONVERSATION_RECONCILIATION_STATUS = Object.freeze({
  RECONCILED: "reconciled",
  PARTIAL: "partial",
  UNAVAILABLE: "unavailable",
} as const);
export type ConversationReconciliationStatusV1 =
  (typeof CONVERSATION_RECONCILIATION_STATUS)[keyof typeof CONVERSATION_RECONCILIATION_STATUS];
export const CONVERSATION_RECONCILIATION_STATUSES = frozenValues(
  CONVERSATION_RECONCILIATION_STATUS,
);

export const CONVERSATION_SKILL_SOURCE = SKILL_SOURCE;
export type ConversationSkillSourceV1 = SkillSource;
export const CONVERSATION_SKILL_SOURCES = SKILL_SOURCES;

export const CONVERSATION_SANDBOX = ROLE_SANDBOX;
export type ConversationSandboxV1 = RoleSandbox;
export const CONVERSATION_SANDBOXES = ROLE_SANDBOXES;

export const CONVERSATION_TOOL_INTENT = ROLE_TOOL_INTENT;
export type ConversationToolIntentV1 = ToolIntent;
export const CONVERSATION_TOOL_INTENTS = ROLE_TOOL_INTENTS;

export const CONVERSATION_TRACE_EVENT_KIND = Object.freeze({
  CONVERSATION_CONFIGURED: "conversation_configured",
  COORDINATOR_DECISION: "coordinator_decision",
  PARTICIPANT_BOUND: "participant_bound",
  SKILL_INJECTED: "skill_injected",
  PRECOMMIT: "precommit",
  AGENT_RESPONSE_DELTA: "agent_response_delta",
  TOOL_ACTION: "tool_action",
  EVALUATOR_ASSESSMENT: "evaluator_assessment",
  USER_MESSAGE: "user_message",
  CONSENSUS_UPDATE: "consensus_update",
  ROUND_BOUNDARY: "round_boundary",
  STATE_CHANGE: "state_change",
  BASELINE_RESULT: "baseline_result",
  SYNTHESIS_COMPLETED: "synthesis_completed",
  CONVERSATION_TERMINAL: "conversation_terminal",
  DRY_RUN_RESULT: "dry_run_result",
  ERROR: "error",
  OPERATION_LIFECYCLE: "operation_lifecycle",
  APPROVAL_REQUESTED: "approval_requested",
  APPROVAL_RESOLVED: "approval_resolved",
  CALLER_CANCELLED: "caller_cancelled",
  ARTIFACT_CREATED: "artifact_created",
  ARTIFACT_UPDATED: "artifact_updated",
  NATIVE_HISTORY_RECONCILED: "native_history_reconciled",
} as const);
export type ConversationTraceEventKindV1 =
  (typeof CONVERSATION_TRACE_EVENT_KIND)[keyof typeof CONVERSATION_TRACE_EVENT_KIND];
export const CONVERSATION_TRACE_EVENT_KINDS = frozenValues(CONVERSATION_TRACE_EVENT_KIND);

/** One exact payload-schema authority compiled independently by backend and browser guards. */
export const CONVERSATION_TRACE_EVENT_PAYLOAD_SCHEMAS = Object.freeze({
  conversation_configured:
    "topic:text participants:participantArray policy:text max_rounds:positiveInteger",
  coordinator_decision: "selected_policy:text reason:text",
  participant_bound:
    "participant_id:reference engine:engine model:model prompt_hash:reference tools:tools sandbox:sandbox",
  skill_injected: "skill_refs:referenceArray resolved_hashes:referenceArray source:skillSource",
  precommit: "round_id:reference participant_id:reference answer:text evidence:textArray",
  agent_response_delta:
    "round_id:reference participant_id:reference content_delta:text final_claim:nullableText final_evidence:textArray completes_response:boolean",
  tool_action:
    "tool:reference action:text status:toolStatus input_ref:nullableReference output_ref:nullableReference",
  evaluator_assessment: "round_id:reference stage:assessmentStage assessment:assessment",
  user_message:
    "content:text target_participants:targetParticipants quote_refs?:quoteReferenceArray",
  consensus_update: "round_id:reference decision:decision",
  round_boundary: "round_id:reference phase:roundPhase",
  state_change: "lifecycle:lifecycle health:health terminal:boolean reason:nullableText",
  baseline_result:
    "status:baselineStatus answer:nullableText confidence:nullableScore skip_reason:nullableBaselineReason",
  synthesis_completed: "decision_matrix_ref:reference baseline_comparison_ref:reference",
  conversation_terminal:
    "lifecycle:terminalLifecycle terminal:terminalTrue final_score:nullableScore",
  dry_run_result:
    "participants:dryRunParticipantArray evaluator_auto_added:boolean engines_available:engineArray models_valid:boolean",
  error: "agent_id:nullableReference code:reference message:text",
  operation_lifecycle: "operation_id:reference attempt_id:reference state:operationState",
  approval_requested: "token:approvalToken description:text",
  approval_resolved: "decision:approvalDecision",
  caller_cancelled: "operation_id:reference actor:reference reason:nullableText",
  artifact_created: "artifact_id:reference artifact_type:artifactType ref:reference",
  artifact_updated:
    "artifact_id:reference artifact_type:artifactType ref:reference previous_ref:reference",
  native_history_reconciled:
    "public_session_ref:reference status:reconciliationStatus imported_turn_count:nonnegativeInteger imported_tool_count:nonnegativeInteger provenance_refs:referenceArray evidence_refs:referenceArray completeness_reason:text",
} satisfies Readonly<Record<ConversationTraceEventKindV1, string>>);

export const CONVERSATION_DECISION_OUTCOME = Object.freeze({
  ABORT: "abort",
  CONSENSUS: "consensus",
  CONTINUE: "continue",
  EXHAUSTED: "exhausted",
} as const);
export type ConversationDecisionOutcomeV1 =
  (typeof CONVERSATION_DECISION_OUTCOME)[keyof typeof CONVERSATION_DECISION_OUTCOME];
export type ConversationContinuingDecisionOutcomeV1 = Exclude<
  ConversationDecisionOutcomeV1,
  typeof CONVERSATION_DECISION_OUTCOME.ABORT
>;
export const CONVERSATION_DECISION_OUTCOMES = frozenValues(CONVERSATION_DECISION_OUTCOME);
export const CONVERSATION_CONTINUING_DECISION_OUTCOMES = Object.freeze([
  CONVERSATION_DECISION_OUTCOME.CONSENSUS,
  CONVERSATION_DECISION_OUTCOME.CONTINUE,
  CONVERSATION_DECISION_OUTCOME.EXHAUSTED,
] as const satisfies readonly ConversationContinuingDecisionOutcomeV1[]);
export const CONVERSATION_INVALID_ASSESSMENT_REASON = "invalid_assessment" as const;
export const CONVERSATION_CONVERGENCE_NOT_APPLICABLE = "not_applicable" as const;
