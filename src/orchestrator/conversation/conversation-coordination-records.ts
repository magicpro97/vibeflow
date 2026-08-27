import type {
  CONVERSATION_COORDINATION_DIRECTIVE_KIND,
  CONVERSATION_COORDINATION_LANE,
  CONVERSATION_COORDINATION_SCHEMA_VERSION,
  ConversationCoordinationEscalationReasonV1,
  ConversationCoordinationLaneV1,
  ConversationCoordinationResolutionSourceV1,
  ConversationCoordinationTerminalOutcomeV1,
} from "./conversation-coordination-contract.js";

export interface CoordinationTaskContractV1 {
  task_id: string;
  executor_participant_id: string;
  goal: string;
  scope: string[];
  forbidden: string[];
  must_haves: string[];
  verify_oracles: string[];
  source_message_refs: string[];
}

export interface ExecutorClarificationV1 {
  task_id: string;
  question_id: string;
  question: string;
  blocking_reason: string;
  attempted_interpretations: string[];
  required_decision: string;
}

export interface CoordinatorResolutionV1 {
  task_id: string;
  question_id: string;
  answer: string;
  source: ConversationCoordinationResolutionSourceV1;
  source_refs: string[];
  assumptions: string[];
}

export interface CoordinationResolutionAttemptV1 {
  source: ConversationCoordinationResolutionSourceV1;
  outcome: string;
  source_refs: string[];
}

export interface UserEscalationV1 {
  task_id: string;
  question_id: string;
  question: string;
  reason_code: ConversationCoordinationEscalationReasonV1;
  resolution_attempts: CoordinationResolutionAttemptV1[];
  impact: string;
  options: string[];
}

export interface ExecutorCompletionV1 {
  task_id: string;
  summary: string;
  changed_paths: string[];
  evidence_refs: string[];
  verification: { commands: string[]; passed: true };
}

export interface ExecutorBlockedV1 {
  task_id: string;
  reason: string;
  evidence_refs: string[];
  recoverable: boolean;
}

export interface CoordinationFinalizationV1 {
  completed_task_ids: string[];
  reviewed_head: string;
  summary: string;
  evidence_refs: string[];
}

export interface CoordinationMalformedOutputV1 {
  correction_key: string;
  participant_id: string;
  lane: Exclude<ConversationCoordinationLaneV1, typeof CONVERSATION_COORDINATION_LANE.HOST>;
  diagnostic_code: string;
}

export interface CoordinationEpochTerminationV1 {
  outcome: ConversationCoordinationTerminalOutcomeV1;
  reason_code: string;
}

type Directive<Kind extends string, Key extends string, Value> = {
  schema_version: typeof CONVERSATION_COORDINATION_SCHEMA_VERSION;
  kind: Kind;
} & Record<Key, Value>;

export type CoordinatorCoordinationDirectiveV1 =
  | Directive<
      typeof CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK,
      "task",
      CoordinationTaskContractV1
    >
  | Directive<
      typeof CONVERSATION_COORDINATION_DIRECTIVE_KIND.RESOLVE_CLARIFICATION,
      "resolution",
      CoordinatorResolutionV1
    >
  | Directive<
      typeof CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE,
      "finalization",
      CoordinationFinalizationV1
    >
  | Directive<
      typeof CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT,
      "escalation",
      UserEscalationV1
    >;

export type ExecutorCoordinationDirectiveV1 =
  | Directive<
      typeof CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_COORDINATOR_CLARIFICATION,
      "clarification",
      ExecutorClarificationV1
    >
  | Directive<
      typeof CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK,
      "completion",
      ExecutorCompletionV1
    >
  | Directive<
      typeof CONVERSATION_COORDINATION_DIRECTIVE_KIND.REPORT_BLOCKED,
      "blocked",
      ExecutorBlockedV1
    >;

export type HostCoordinationDirectiveV1 =
  | Directive<
      typeof CONVERSATION_COORDINATION_DIRECTIVE_KIND.MALFORMED_OUTPUT,
      "correction",
      CoordinationMalformedOutputV1
    >
  | Directive<
      typeof CONVERSATION_COORDINATION_DIRECTIVE_KIND.TERMINATE_EPOCH,
      "termination",
      CoordinationEpochTerminationV1
    >;

export type ConversationCoordinationDirectiveV1 =
  | CoordinatorCoordinationDirectiveV1
  | ExecutorCoordinationDirectiveV1
  | HostCoordinationDirectiveV1;

export interface ConversationCoordinationRecordV1 {
  schema_version: typeof CONVERSATION_COORDINATION_SCHEMA_VERSION;
  epoch_id: string;
  record_id: string;
  operation_id: string;
  revision_id: string;
  step: number;
  coordinator_participant_id: string;
  actor_participant_id: string;
  actor_lane: ConversationCoordinationLaneV1;
  previous_ref: string | null;
  directive: ConversationCoordinationDirectiveV1;
}

export interface StoredConversationCoordinationRecordV1 {
  artifact_ref: string;
  record: ConversationCoordinationRecordV1;
}
