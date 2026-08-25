import type { RoleSpec } from "../../agents/role.js";
import type { Engine } from "../../core/types.js";
import type { EvaluatorOutput, RoundDecision } from "../consensus.js";
export type { Engine } from "../../core/types.js";
export type { RoleSpec } from "../../agents/role.js";
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
export interface TraceCorrelation {
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
  engine?: Engine;
  evidence_refs?: string[];
  parent_attempt_id?: string;
}
export interface TraceAppendInput {
  idempotency_key: string;
  event: TraceEvent;
}
export interface StoredTraceEvent extends TraceCorrelation {
  event_id: string;
  seq: number;
  ts: string;
  idempotency_key: string;
  event: TraceEvent;
}
export interface InternalTraceStoreRecord {
  stored_event: StoredTraceEvent;
  native_session_id: string | null;
  /** Internal journal transaction framing. Never enters the public projection. */
  batch_id?: string;
  batch_index?: number;
  batch_size?: number;
}
declare const publicTextBrand: unique symbol;
declare const opaqueArtifactIdBrand: unique symbol;
declare const opaqueSessionRefBrand: unique symbol;
export type PublicText = string & { readonly [publicTextBrand]: "PublicText" };
export type OpaqueArtifactId = string & { readonly [opaqueArtifactIdBrand]: "OpaqueArtifactId" };
export type OpaqueSessionRef = string & { readonly [opaqueSessionRefBrand]: "OpaqueSessionRef" };
export type PublicProjection<T> = T extends string
  ? PublicText
  : T extends number | boolean | null
    ? T
    : T extends readonly (infer U)[]
      ? PublicProjection<U>[]
      : T extends object
        ? {
            [K in keyof T as K extends "native_session_id" | "prompt_template" | "raw_env"
              ? never
              : K]: K extends "public_session_ref"
              ? OpaqueSessionRef
              : K extends
                    | "ref"
                    | "previous_ref"
                    | "input_ref"
                    | "output_ref"
                    | "decision_matrix_ref"
                    | "baseline_comparison_ref"
                ? OpaqueArtifactId | null
                : K extends "evidence_refs" | "provenance_refs"
                  ? OpaqueArtifactId[]
                  : PublicProjection<T[K]>;
          }
        : never;
export interface PublicTraceCorrelation {
  workflow_id: PublicText;
  conversation_id: PublicText;
  revision_id: PublicText;
  run_id: PublicText;
  turn_id: PublicText;
  operation_id: PublicText;
  attempt_id: PublicText;
  unit_id?: PublicText;
  participant_id?: PublicText;
  role_ref?: PublicText;
  role_resolved_hash?: PublicText;
  skill_refs?: PublicText[];
  skill_resolved_hashes?: PublicText[];
  engine?: Engine;
  evidence_refs?: OpaqueArtifactId[];
  parent_attempt_id?: PublicText;
}
export interface PublicStoredTraceEvent extends PublicTraceCorrelation {
  event_id: PublicText;
  seq: number;
  ts: PublicText;
  public_session_ref: OpaqueSessionRef | null;
  event: PublicTraceEvent;
}
export type Participant = {
  participant_id: string;
  role_ref: string;
  engine: Engine;
  model: string | null;
};
export interface ApprovalToken {
  approval_id: string;
  operation_id: string;
  actor: string;
}
export type ApprovalOutcome = "approve" | "reject";
export interface ApprovalDecision extends ApprovalToken {
  outcome: ApprovalOutcome;
  reason: string | null;
}
export interface ConversationConfiguredPayload {
  topic: string;
  participants: Participant[];
  policy: string;
  max_rounds: number;
}
export interface CoordinatorDecisionPayload {
  selected_policy: string;
  reason: string;
}
export interface ParticipantBoundPayload {
  participant_id: string;
  engine: Engine;
  model: string | null;
  prompt_hash: string;
  tools: RoleSpec["tools"];
  sandbox: NonNullable<RoleSpec["sandbox"]>;
}
export interface SkillInjectedPayload {
  skill_refs: string[];
  resolved_hashes: string[];
  source: "repo" | "shared" | "builtin";
}
export interface PrecommitPayload {
  round_id: string;
  participant_id: string;
  answer: string;
  evidence: string[];
}
export interface AgentResponseDeltaPayload {
  round_id: string;
  participant_id: string;
  content_delta: string;
  final_claim: string | null;
  final_evidence: string[];
  completes_response: boolean;
}
export interface ToolActionPayload {
  tool: string;
  action: string;
  status: "started" | "completed" | "failed";
  input_ref: string | null;
  output_ref: string | null;
}
export interface EvaluatorAssessmentPayload {
  round_id: string;
  stage: "blind" | "full";
  assessment: EvaluatorOutput;
}
export interface UserMessagePayload {
  content: string;
  target_participants: string[] | "all";
  quote_refs?: Array<{
    root_session_id: string;
    conversation_id: string;
    revision_id: string;
    target_event_id: string;
    target_kind: "user-message" | "completed-agent-response";
    content_digest: string;
    author_public_id: string;
  }>;
}
export interface ConsensusUpdatePayload {
  round_id: string;
  decision: RoundDecision;
}
export interface RoundBoundaryPayload {
  round_id: string;
  phase: "start" | "end";
}
export interface StateChangePayload {
  lifecycle: ConversationLifecycle;
  health: ConversationHealth;
  terminal: boolean;
  reason: string | null;
}
export interface BaselineResultPayload {
  status: "success" | "failed" | "skipped";
  answer: string | null;
  confidence: number | null;
  skip_reason: string | null;
}
export interface SynthesisCompletedPayload {
  decision_matrix_ref: string;
  baseline_comparison_ref: string;
}
export interface ConversationTerminalPayload {
  lifecycle: TerminalLifecycle;
  terminal: true;
  final_score: number | null;
}
export interface DryRunResultPayload {
  participants: Array<Participant & { engine_available: boolean; model_valid: boolean }>;
  evaluator_auto_added: boolean;
  engines_available: Engine[];
  models_valid: boolean;
}
export interface ErrorPayload {
  agent_id: string | null;
  code: string;
  message: string;
}
export interface OperationLifecyclePayload {
  operation_id: string;
  attempt_id: string;
  state: "requested" | "dispatched" | "acknowledged" | "completed" | "ambiguous";
}
export interface ApprovalRequestedPayload {
  token: ApprovalToken;
  description: string;
}
export interface ApprovalResolvedPayload {
  decision: ApprovalDecision;
}
export interface CallerCancelledPayload {
  operation_id: string;
  actor: string;
  reason: string | null;
}
export interface ArtifactCreatedPayload {
  artifact_id: string;
  artifact_type:
    | "decision_matrix"
    | "plan"
    | "diff"
    | "tests"
    | "synthesis"
    | "transcript"
    | "compaction";
  ref: string;
}
export interface ArtifactUpdatedPayload {
  artifact_id: string;
  artifact_type: string;
  ref: string;
  previous_ref: string;
}
export interface NativeHistoryReconciledPayload {
  public_session_ref: string;
  status: "reconciled" | "partial" | "unavailable";
  imported_turn_count: number;
  imported_tool_count: number;
  provenance_refs: string[];
  evidence_refs: string[];
  completeness_reason: string;
}
export type TraceEvent =
  | { type: "conversation_configured"; payload: ConversationConfiguredPayload }
  | { type: "coordinator_decision"; payload: CoordinatorDecisionPayload }
  | { type: "participant_bound"; payload: ParticipantBoundPayload }
  | { type: "skill_injected"; payload: SkillInjectedPayload }
  | { type: "precommit"; payload: PrecommitPayload }
  | { type: "agent_response_delta"; payload: AgentResponseDeltaPayload }
  | { type: "tool_action"; payload: ToolActionPayload }
  | { type: "evaluator_assessment"; payload: EvaluatorAssessmentPayload }
  | { type: "user_message"; payload: UserMessagePayload }
  | { type: "consensus_update"; payload: ConsensusUpdatePayload }
  | { type: "round_boundary"; payload: RoundBoundaryPayload }
  | { type: "state_change"; payload: StateChangePayload }
  | { type: "baseline_result"; payload: BaselineResultPayload }
  | { type: "synthesis_completed"; payload: SynthesisCompletedPayload }
  | { type: "conversation_terminal"; payload: ConversationTerminalPayload }
  | { type: "dry_run_result"; payload: DryRunResultPayload }
  | { type: "error"; payload: ErrorPayload }
  | { type: "operation_lifecycle"; payload: OperationLifecyclePayload }
  | { type: "approval_requested"; payload: ApprovalRequestedPayload }
  | { type: "approval_resolved"; payload: ApprovalResolvedPayload }
  | { type: "caller_cancelled"; payload: CallerCancelledPayload }
  | { type: "artifact_created"; payload: ArtifactCreatedPayload }
  | { type: "artifact_updated"; payload: ArtifactUpdatedPayload }
  | { type: "native_history_reconciled"; payload: NativeHistoryReconciledPayload };
export type PublicTraceProjection = {
  [T in TraceEvent as T["type"]]: { type: T["type"]; payload: PublicProjection<T["payload"]> };
}[TraceEvent["type"]];
export type PublicTraceEvent = PublicTraceProjection;
export interface PolicyEmission {
  idempotency_key: string;
  event: TraceEvent;
}
