import type { Engine } from "../../core/agent-contract.js";
import type { PublicQuoteReferenceV1 } from "../../orchestrator/conversation/conversation-interaction-types.js";
import type { ConversationMessageQueueTargetParticipantsV1 } from "../../orchestrator/conversation/conversation-message-queue-contract.js";
import type * as ConversationWire from "../../orchestrator/conversation/conversation-public-wire-contract.js";
import {
  type CONVERSATION_CONVERGENCE_NOT_APPLICABLE,
  type CONVERSATION_DECISION_OUTCOME,
  type CONVERSATION_INVALID_ASSESSMENT_REASON,
  type CONVERSATION_LIFECYCLE,
  type CONVERSATION_TRACE_EVENT_KIND,
  isConversationTerminalLifecycle,
} from "../../orchestrator/conversation/conversation-public-wire-contract.js";

export type ConversationEngine = Engine;
export type ConversationLifecycle = ConversationWire.ConversationLifecycleV1;
export type ConversationHealth = ConversationWire.ConversationHealthV1;
export type TerminalLifecycle = ConversationWire.ConversationTerminalLifecycleV1;
export type ApprovalOutcome = ConversationWire.ConversationApprovalOutcomeV1;
export type OperationState = ConversationWire.ConversationOperationStateV1;
export type ConversationArtifactType = ConversationWire.ConversationArtifactTypeV1;
export interface BooleanGate {
  value: boolean;
  evidence: string;
}
export interface ConvergenceGate {
  value: boolean | typeof CONVERSATION_CONVERGENCE_NOT_APPLICABLE;
  evidence: string;
}
export interface EvaluatorOutput {
  agreement: BooleanGate;
  conflict_resolution: BooleanGate;
  evidence_quality: BooleanGate;
  convergence: ConvergenceGate;
}
export type RoundDecision =
  | {
      outcome: typeof CONVERSATION_DECISION_OUTCOME.ABORT;
      score: null;
      reason: typeof CONVERSATION_INVALID_ASSESSMENT_REASON;
    }
  | { outcome: ConversationWire.ConversationContinuingDecisionOutcomeV1; score: number };
export interface ConversationParticipantSnapshot {
  participant_id: string;
  role_ref: string;
  engine: ConversationEngine;
  model: string | null;
  public_session_ref: string | null;
}

export interface RoundResponse {
  participant_id: string;
  content: string;
  claim: string | null;
  evidence: string[];
  complete: boolean;
}

export interface RoundAssessment {
  stage: ConversationWire.ConversationAssessmentStageV1;
  assessment: EvaluatorOutput;
}

export interface ConversationRound {
  round_id: string;
  participant_responses: RoundResponse[];
  evaluator_assessments: RoundAssessment[];
  decision: RoundDecision | null;
  complete: boolean;
}

export interface ConversationSnapshot {
  conversation_id: string;
  lifecycle: ConversationLifecycle;
  health: ConversationHealth;
  policy: string;
  topic: string;
  participants: ConversationParticipantSnapshot[];
  rounds: ConversationRound[];
  consensus_score: number | null;
  last_seq: number;
}

export interface ConversationCreateParticipant {
  role_ref: string;
  engine: ConversationEngine;
  model?: string;
}

export interface ConversationCreateRequest {
  topic: string;
  policy?: string;
  participants?: ConversationCreateParticipant[];
  max_rounds?: number;
}

export interface ConversationCreateResponse {
  conversation_id: string;
  stream_token: string;
  stream_token_expires_at: string;
}

export interface MessageRequest {
  content: string;
  target_participants?: ConversationMessageQueueTargetParticipantsV1;
}

export interface MessageResponse {
  message_id: string;
  accepted: true;
  child_conversation_id?: string;
  location?: string;
}

export interface PauseResponse {
  paused: true;
  lifecycle: typeof CONVERSATION_LIFECYCLE.PAUSED;
}

export interface ResumeResponse {
  resumed: true;
  active_state: typeof CONVERSATION_LIFECYCLE.ACTIVE;
}

export interface StopResponse {
  stopped: true;
  terminal_state: typeof CONVERSATION_LIFECYCLE.STOPPED;
}

export interface ApprovalDecision {
  approval_id: string;
  operation_id: string;
  actor: string;
  outcome: ApprovalOutcome;
  reason: string | null;
}

export interface ApprovalResolveResponse extends ApprovalDecision {
  resolved: true;
}

export interface OperationCancelCommand {
  conversation_id: string;
  operation_id: string;
  actor: string;
  reason: string | null;
}

export interface StreamTokenRenewalResponse {
  stream_token: string;
  stream_token_expires_at: string;
}

export interface ConversationTraceCorrelation {
  workflow_id: string;
  conversation_id: string;
  revision_id: string;
  run_id: string;
  turn_id: string;
  operation_id: string;
  attempt_id: string;
  unit_id?: string;
  participant_id?: string;
  role_ref?: string;
  role_resolved_hash?: string;
  skill_refs?: string[];
  skill_resolved_hashes?: string[];
  engine?: ConversationEngine;
  evidence_refs?: string[];
  parent_attempt_id?: string;
}

export type ConversationTraceEvent =
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_CONFIGURED;
      payload: {
        topic: string;
        participants: Array<{
          participant_id: string;
          role_ref: string;
          engine: ConversationEngine;
          model: string | null;
        }>;
        policy: string;
        max_rounds: number;
      };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.COORDINATOR_DECISION;
      payload: { selected_policy: string; reason: string };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.PARTICIPANT_BOUND;
      payload: {
        participant_id: string;
        engine: ConversationEngine;
        model: string | null;
        prompt_hash: string;
        tools: unknown;
        sandbox: unknown;
      };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.SKILL_INJECTED;
      payload: {
        skill_refs: string[];
        resolved_hashes: string[];
        source: ConversationWire.ConversationSkillSourceV1;
      };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.PRECOMMIT;
      payload: { round_id: string; participant_id: string; answer: string; evidence: string[] };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA;
      payload: {
        round_id: string;
        participant_id: string;
        content_delta: string;
        final_claim: string | null;
        final_evidence: string[];
        completes_response: boolean;
      };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.TOOL_ACTION;
      payload: {
        tool: string;
        action: string;
        status: ConversationWire.ConversationToolActionStatusV1;
        input_ref: string | null;
        output_ref: string | null;
      };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.EVALUATOR_ASSESSMENT;
      payload: {
        round_id: string;
        stage: ConversationWire.ConversationAssessmentStageV1;
        assessment: EvaluatorOutput;
      };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.USER_MESSAGE;
      payload: {
        content: string;
        target_participants: ConversationMessageQueueTargetParticipantsV1;
        quote_refs?: PublicQuoteReferenceV1[];
      };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.CONSENSUS_UPDATE;
      payload: { round_id: string; decision: RoundDecision };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.ROUND_BOUNDARY;
      payload: { round_id: string; phase: ConversationWire.ConversationRoundPhaseV1 };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.STATE_CHANGE;
      payload: {
        lifecycle: ConversationLifecycle;
        health: ConversationHealth;
        terminal: boolean;
        reason: string | null;
      };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.BASELINE_RESULT;
      payload: {
        status: ConversationWire.ConversationBaselineStatusV1;
        answer: string | null;
        confidence: number | null;
        skip_reason: ConversationWire.ConversationBaselineReasonV1 | null;
      };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.SYNTHESIS_COMPLETED;
      payload: { decision_matrix_ref: string; baseline_comparison_ref: string };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_TERMINAL;
      payload: { lifecycle: TerminalLifecycle; terminal: true; final_score: number | null };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.DRY_RUN_RESULT;
      payload: {
        participants: Array<Record<string, unknown>>;
        evaluator_auto_added: boolean;
        engines_available: ConversationEngine[];
        models_valid: boolean;
      };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.ERROR;
      payload: { agent_id: string | null; code: string; message: string };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.OPERATION_LIFECYCLE;
      payload: { operation_id: string; attempt_id: string; state: OperationState };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.APPROVAL_REQUESTED;
      payload: {
        token: { approval_id: string; operation_id: string; actor: string };
        description: string;
      };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.APPROVAL_RESOLVED;
      payload: { decision: ApprovalDecision };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.CALLER_CANCELLED;
      payload: { operation_id: string; actor: string; reason: string | null };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_CREATED;
      payload: { artifact_id: string; artifact_type: ConversationArtifactType; ref: string };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_UPDATED;
      payload: {
        artifact_id: string;
        artifact_type: ConversationArtifactType;
        ref: string;
        previous_ref: string;
      };
    }
  | {
      type: typeof CONVERSATION_TRACE_EVENT_KIND.NATIVE_HISTORY_RECONCILED;
      payload: {
        public_session_ref: string;
        status: ConversationWire.ConversationReconciliationStatusV1;
        imported_turn_count: number;
        imported_tool_count: number;
        provenance_refs: string[];
        evidence_refs: string[];
        completeness_reason: string;
      };
    };

export const CONVERSATION_TRACE_EVENT_KIND_PARITY = true satisfies ConversationWire.SameUnion<
  ConversationTraceEvent["type"],
  ConversationWire.ConversationTraceEventKindV1
>;

export interface ConversationTraceRecord extends ConversationTraceCorrelation {
  event_id: string;
  seq: number;
  ts: string;
  public_session_ref: string | null;
  event: ConversationTraceEvent;
}

export const OPAQUE_ARTIFACT_PATTERN = /^artifact_[A-Za-z0-9_-]{43}$/;
export const OPAQUE_SESSION_PATTERN = /^session_[A-Za-z0-9_-]{43}$/;
export {
  createConversationStreamAttemptGuard,
  recoverConversationStreamAttempt,
} from "./conversation-stream-attempt.js";

export const isTerminalLifecycle = isConversationTerminalLifecycle;
