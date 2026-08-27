import { digestHex, digestV1 } from "../../durability/index.js";
import { CONVERSATION_POLICY } from "./conversation-policy-contract.js";

export const CONVERSATION_COORDINATION_SCHEMA_VERSION = "1.0" as const;

export const CONVERSATION_COORDINATION_POLICY = CONVERSATION_POLICY.COORDINATE;
export const CONVERSATION_COORDINATION_TOOL = "vf.coordination" as const;
export const CONVERSATION_COORDINATION_WORKSPACE_KEY_PREFIX = "coordination-primary" as const;
export const CONVERSATION_COORDINATION_RESPONSE_ROUND_PREFIX = "coordination:" as const;

export function conversationCoordinationResponseRoundId(anchor: string): string {
  if (!anchor.trim()) throw new Error("coordination response anchor is required");
  return `${CONVERSATION_COORDINATION_RESPONSE_ROUND_PREFIX}${anchor}`;
}

export function isConversationCoordinationResponseRoundId(value: string): boolean {
  return (
    value.startsWith(CONVERSATION_COORDINATION_RESPONSE_ROUND_PREFIX) &&
    value.length > CONVERSATION_COORDINATION_RESPONSE_ROUND_PREFIX.length
  );
}

export function conversationCoordinationEpochId(input: {
  workflow_id: string;
  operation_id: string;
  revision_id: string;
}): string {
  return digestV1("VF-CONVERSATION-COORDINATION-EPOCH\0v1\0", {
    schema_version: CONVERSATION_COORDINATION_SCHEMA_VERSION,
    workflow_id: input.workflow_id,
    operation_id: input.operation_id,
    revision_id: input.revision_id,
  });
}

export function conversationCoordinationWorkspaceKey(epochId: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(epochId)) throw new Error("invalid coordination epoch");
  return `${CONVERSATION_COORDINATION_WORKSPACE_KEY_PREFIX}-${digestHex(epochId).slice(0, 24)}`;
}

export function conversationCoordinationTopicMessageRef(input: {
  workflow_id: string;
  conversation_id: string;
  revision_id: string;
  topic: string;
}): string {
  return digestV1("VF-CONVERSATION-COORDINATION-TOPIC-MESSAGE\0v1\0", {
    schema_version: CONVERSATION_COORDINATION_SCHEMA_VERSION,
    ...input,
  });
}

export const CONVERSATION_COORDINATION_LANE = Object.freeze({
  COORDINATOR: "coordinator",
  EXECUTOR: "executor",
  HOST: "host",
} as const);
export type ConversationCoordinationLaneV1 =
  (typeof CONVERSATION_COORDINATION_LANE)[keyof typeof CONVERSATION_COORDINATION_LANE];

export const CONVERSATION_COORDINATION_DIRECTIVE_KIND = Object.freeze({
  DELEGATE_TASK: "delegate_task",
  RESOLVE_CLARIFICATION: "resolve_clarification",
  FINALIZE: "finalize_coordination",
  REQUEST_USER_INPUT: "request_user_input",
  REQUEST_COORDINATOR_CLARIFICATION: "request_coordinator_clarification",
  COMPLETE_TASK: "complete_delegated_task",
  REPORT_BLOCKED: "report_blocked",
  MALFORMED_OUTPUT: "malformed_output",
  TERMINATE_EPOCH: "terminate_epoch",
} as const);
export type ConversationCoordinationDirectiveKindV1 =
  (typeof CONVERSATION_COORDINATION_DIRECTIVE_KIND)[keyof typeof CONVERSATION_COORDINATION_DIRECTIVE_KIND];

export const CONVERSATION_COORDINATION_RESOLUTION_SOURCE = Object.freeze({
  TASK_SPEC: "task-spec",
  CONVERSATION_CONTEXT: "conversation-context",
  REPO_EVIDENCE: "repo-evidence",
  SAFE_DEFAULT: "safe-default",
} as const);
export type ConversationCoordinationResolutionSourceV1 =
  (typeof CONVERSATION_COORDINATION_RESOLUTION_SOURCE)[keyof typeof CONVERSATION_COORDINATION_RESOLUTION_SOURCE];
export const CONVERSATION_COORDINATION_RESOLUTION_SOURCES = Object.freeze(
  Object.values(CONVERSATION_COORDINATION_RESOLUTION_SOURCE),
) as readonly ConversationCoordinationResolutionSourceV1[];

export const CONVERSATION_COORDINATION_ESCALATION_REASON = Object.freeze({
  MISSING_USER_PREFERENCE: "missing-user-preference",
  CONFLICTING_NON_NEGOTIABLES: "conflicting-non-negotiables",
  CREDENTIAL_OR_EXTERNAL_AUTHORITY: "credential-or-external-authority",
  IRREVERSIBLE_SCOPE_CHOICE: "irreversible-scope-choice",
} as const);
export type ConversationCoordinationEscalationReasonV1 =
  (typeof CONVERSATION_COORDINATION_ESCALATION_REASON)[keyof typeof CONVERSATION_COORDINATION_ESCALATION_REASON];
export const CONVERSATION_COORDINATION_ESCALATION_REASONS = Object.freeze(
  Object.values(CONVERSATION_COORDINATION_ESCALATION_REASON),
) as readonly ConversationCoordinationEscalationReasonV1[];

export const CONVERSATION_COORDINATION_PHASE = Object.freeze({
  COORDINATOR_PLANNING: "coordinator-planning",
  EXECUTOR_RUNNING: "executor-running",
  COORDINATOR_RESOLVING: "coordinator-resolving",
  COORDINATOR_REVIEWING: "coordinator-reviewing",
  NEEDS_INPUT: "needs-input",
  COMPLETED: "completed",
  TERMINATED: "terminated",
} as const);
export type ConversationCoordinationPhaseV1 =
  (typeof CONVERSATION_COORDINATION_PHASE)[keyof typeof CONVERSATION_COORDINATION_PHASE];

export const CONVERSATION_COORDINATION_TERMINAL_OUTCOME = Object.freeze({
  FAILED: "failed",
  ABORTED: "aborted",
} as const);
export type ConversationCoordinationTerminalOutcomeV1 =
  (typeof CONVERSATION_COORDINATION_TERMINAL_OUTCOME)[keyof typeof CONVERSATION_COORDINATION_TERMINAL_OUTCOME];

export const CONVERSATION_COORDINATION_CORRECTION_CODE = "malformed-coordination-output" as const;

export const CONVERSATION_COORDINATION_DIAGNOSTIC = Object.freeze({
  WORKSPACE_REQUIRES_CLEAN_COMMIT: "coordination_workspace_requires_clean_commit",
  WORKSPACE_VERIFICATION_FAILED: "coordination_workspace_verification_failed",
  USER_DECISION_SOURCE_UNVERIFIED: "coordination_user_decision_source_unverified",
} as const);

export const CONVERSATION_COORDINATION_LIMIT = Object.freeze({
  MAX_TASKS: 8,
  MAX_CLARIFICATIONS_PER_TASK: 3,
  MAX_USER_ESCALATIONS_PER_TASK: 2,
  MAX_TOTAL_RECORDS: 32,
  MAX_TOTAL_ATTEMPTS: 32,
  MAX_OUTPUT_CORRECTIONS_PER_TRANSITION: 1,
  MAX_LIST_ITEMS: 32,
  MAX_OPTIONS: 5,
  MAX_TEXT_BYTES: 16 * 1024,
  MAX_REFERENCE_BYTES: 512,
  MAX_OUTPUT_BYTES: 128 * 1024,
} as const);

export const CONVERSATION_COORDINATION_SETTLEMENT = Object.freeze({
  COMPLETED: "completed",
  FAILED: "failed",
  NEEDS_INPUT: "needs-input",
} as const);
export type ConversationCoordinationSettlementV1 =
  (typeof CONVERSATION_COORDINATION_SETTLEMENT)[keyof typeof CONVERSATION_COORDINATION_SETTLEMENT];

export interface ConversationCoordinationWorkspaceObservationV1 {
  workspace_key: string;
  branch_ref: string | null;
  head: string | null;
  verified_head: string | null;
  dirty: boolean;
  quiescent: boolean;
  evidence_refs: readonly string[];
}
