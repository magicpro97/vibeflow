export type ConversationEngine = "claude" | "codex" | "copilot" | "opencode" | "antigravity";
export type ConversationLifecycle =
  | "INIT"
  | "ACTIVE"
  | "PAUSED"
  | "COMPLETED"
  | "STOPPED"
  | "FAILED"
  | "ABORTED";
export type ConversationHealth = "healthy" | "degraded";
export type TerminalLifecycle = "COMPLETED" | "STOPPED" | "FAILED" | "ABORTED";
export type ApprovalOutcome = "approve" | "reject";
export type OperationState =
  | "requested"
  | "dispatched"
  | "acknowledged"
  | "completed"
  | "ambiguous";
export type ConversationArtifactType =
  | "decision_matrix"
  | "plan"
  | "diff"
  | "tests"
  | "synthesis"
  | "transcript";
export interface BooleanGate {
  value: boolean;
  evidence: string;
}
export interface ConvergenceGate {
  value: boolean | "not_applicable";
  evidence: string;
}
export interface EvaluatorOutput {
  agreement: BooleanGate;
  conflict_resolution: BooleanGate;
  evidence_quality: BooleanGate;
  convergence: ConvergenceGate;
}

export type RoundDecision =
  | { outcome: "abort"; score: null; reason: "invalid_assessment" }
  | { outcome: "consensus" | "continue" | "exhausted"; score: number };

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
  stage: "blind" | "full";
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
  target_participants?: string[] | "all";
}

export interface MessageResponse {
  message_id: string;
  accepted: true;
  child_conversation_id?: string;
  location?: string;
}

export interface PauseResponse {
  paused: true;
  lifecycle: "PAUSED";
}

export interface ResumeResponse {
  resumed: true;
  active_state: "ACTIVE";
}

export interface StopResponse {
  stopped: true;
  terminal_state: "STOPPED";
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
      type: "conversation_configured";
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
  | { type: "coordinator_decision"; payload: { selected_policy: string; reason: string } }
  | {
      type: "participant_bound";
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
      type: "skill_injected";
      payload: {
        skill_refs: string[];
        resolved_hashes: string[];
        source: "repo" | "shared" | "builtin";
      };
    }
  | {
      type: "precommit";
      payload: { round_id: string; participant_id: string; answer: string; evidence: string[] };
    }
  | {
      type: "agent_response_delta";
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
      type: "tool_action";
      payload: {
        tool: string;
        action: string;
        status: "started" | "completed" | "failed";
        input_ref: string | null;
        output_ref: string | null;
      };
    }
  | {
      type: "evaluator_assessment";
      payload: { round_id: string; stage: "blind" | "full"; assessment: EvaluatorOutput };
    }
  | { type: "user_message"; payload: { content: string; target_participants: string[] | "all" } }
  | { type: "consensus_update"; payload: { round_id: string; decision: RoundDecision } }
  | { type: "round_boundary"; payload: { round_id: string; phase: "start" | "end" } }
  | {
      type: "state_change";
      payload: {
        lifecycle: ConversationLifecycle;
        health: ConversationHealth;
        terminal: boolean;
        reason: string | null;
      };
    }
  | {
      type: "baseline_result";
      payload: {
        status: "success" | "failed" | "skipped";
        answer: string | null;
        confidence: number | null;
        skip_reason: string | null;
      };
    }
  | {
      type: "synthesis_completed";
      payload: { decision_matrix_ref: string; baseline_comparison_ref: string };
    }
  | {
      type: "conversation_terminal";
      payload: { lifecycle: TerminalLifecycle; terminal: true; final_score: number | null };
    }
  | {
      type: "dry_run_result";
      payload: {
        participants: Array<Record<string, unknown>>;
        evaluator_auto_added: boolean;
        engines_available: ConversationEngine[];
        models_valid: boolean;
      };
    }
  | { type: "error"; payload: { agent_id: string | null; code: string; message: string } }
  | {
      type: "operation_lifecycle";
      payload: { operation_id: string; attempt_id: string; state: OperationState };
    }
  | {
      type: "approval_requested";
      payload: {
        token: { approval_id: string; operation_id: string; actor: string };
        description: string;
      };
    }
  | { type: "approval_resolved"; payload: { decision: ApprovalDecision } }
  | {
      type: "caller_cancelled";
      payload: { operation_id: string; actor: string; reason: string | null };
    }
  | {
      type: "artifact_created";
      payload: { artifact_id: string; artifact_type: ConversationArtifactType; ref: string | null };
    }
  | {
      type: "artifact_updated";
      payload: {
        artifact_id: string;
        artifact_type: string;
        ref: string | null;
        previous_ref: string | null;
      };
    }
  | {
      type: "native_history_reconciled";
      payload: {
        public_session_ref: string;
        status: "reconciled" | "partial" | "unavailable";
        imported_turn_count: number;
        imported_tool_count: number;
        provenance_refs: string[];
        evidence_refs: string[];
        completeness_reason: string;
      };
    };

export interface ConversationTraceRecord extends ConversationTraceCorrelation {
  event_id: string;
  seq: number;
  ts: string;
  public_session_ref: string | null;
  event: ConversationTraceEvent;
}

export const OPAQUE_ARTIFACT_PATTERN = /^artifact_[A-Za-z0-9_-]{43}$/;
export const OPAQUE_SESSION_PATTERN = /^session_[A-Za-z0-9_-]{43}$/;
const FATAL_STREAM_ERRORS = new Set(["conversation_not_found", "stream_unavailable"]);

export function createConversationStreamAttemptGuard() {
  let recoverable = true;
  return {
    acceptTypedError(raw: string) {
      let payload: { code?: unknown; message?: unknown } = {};
      try {
        const decoded: unknown = JSON.parse(raw);
        if (decoded && typeof decoded === "object") payload = decoded as typeof payload;
      } catch {
        // Malformed typed frames remain recoverable transport failures.
      }
      const code = typeof payload.code === "string" ? payload.code : "";
      const fatal = FATAL_STREAM_ERRORS.has(code);
      if (fatal) recoverable = false;
      return {
        fatal,
        message:
          typeof payload.message === "string" && payload.message.trim()
            ? payload.message
            : code || "conversation stream failed",
      };
    },
    canRecover: () => recoverable,
  };
}

export async function recoverConversationStreamAttempt(
  attempt: ReturnType<typeof createConversationStreamAttemptGuard>,
  renew: () => Promise<boolean>,
  reconnect: () => void,
) {
  if (!attempt.canRecover()) return "terminal" as const;
  if (await renew()) return "renewed" as const;
  if (!attempt.canRecover()) return "terminal" as const;
  reconnect();
  return "reconnecting" as const;
}

export function isTerminalLifecycle(lifecycle: ConversationLifecycle): boolean {
  return (
    lifecycle === "COMPLETED" ||
    lifecycle === "STOPPED" ||
    lifecycle === "FAILED" ||
    lifecycle === "ABORTED"
  );
}
