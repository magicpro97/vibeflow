import type { RoleSpec } from "../../agents/role.js";
import type { Engine } from "../../core/types.js";
import type { EvaluatorOutput, RoundDecision } from "../consensus.js";
import type {
  ConversationMessageQueueQuoteTargetKindV1,
  ConversationMessageQueueTargetParticipantsV1,
} from "../conversation/conversation-message-queue-contract.js";
import type * as ConversationWire from "../conversation/conversation-public-wire-contract.js";
export type { Engine } from "../../core/types.js";
export type { RoleSpec } from "../../agents/role.js";
export type ConversationLifecycle = ConversationWire.ConversationLifecycleV1;
export type ConversationHealth = ConversationWire.ConversationHealthV1;
export type TerminalLifecycle = ConversationWire.ConversationTerminalLifecycleV1;
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
              : K extends "artifact_type"
                ? T[K]
                : K extends
                      | "ref"
                      | "previous_ref"
                      | "input_ref"
                      | "output_ref"
                      | "decision_matrix_ref"
                      | "baseline_comparison_ref"
                  ? null extends T[K]
                    ? OpaqueArtifactId | null
                    : OpaqueArtifactId
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
export type ApprovalOutcome = ConversationWire.ConversationApprovalOutcomeV1;
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
  source: ConversationWire.ConversationSkillSourceV1;
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
  status: ConversationWire.ConversationToolActionStatusV1;
  input_ref: string | null;
  output_ref: string | null;
}
export interface EvaluatorAssessmentPayload {
  round_id: string;
  stage: ConversationWire.ConversationAssessmentStageV1;
  assessment: EvaluatorOutput;
}
export interface UserMessagePayload {
  content: string;
  target_participants: ConversationMessageQueueTargetParticipantsV1;
  quote_refs?: Array<{
    root_session_id: string;
    conversation_id: string;
    revision_id: string;
    target_event_id: string;
    target_kind: ConversationMessageQueueQuoteTargetKindV1;
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
  phase: ConversationWire.ConversationRoundPhaseV1;
}
export interface StateChangePayload {
  lifecycle: ConversationLifecycle;
  health: ConversationHealth;
  terminal: boolean;
  reason: string | null;
}
export interface BaselineResultPayload {
  status: ConversationWire.ConversationBaselineStatusV1;
  answer: string | null;
  confidence: number | null;
  skip_reason: ConversationWire.ConversationBaselineReasonV1 | null;
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
  state: ConversationWire.ConversationOperationStateV1;
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
  artifact_type: ConversationWire.ConversationArtifactTypeV1;
  ref: string;
}
export interface ArtifactUpdatedPayload {
  artifact_id: string;
  artifact_type: ConversationWire.ConversationArtifactTypeV1;
  ref: string;
  previous_ref: string;
}
export interface NativeHistoryReconciledPayload {
  public_session_ref: string;
  status: ConversationWire.ConversationReconciliationStatusV1;
  imported_turn_count: number;
  imported_tool_count: number;
  provenance_refs: string[];
  evidence_refs: string[];
  completeness_reason: string;
}
type TraceKinds = typeof ConversationWire.CONVERSATION_TRACE_EVENT_KIND;
type TraceEventOf<Key extends keyof TraceKinds, Payload> = {
  type: TraceKinds[Key];
  payload: Payload;
};
export type TraceEvent =
  | TraceEventOf<"CONVERSATION_CONFIGURED", ConversationConfiguredPayload>
  | TraceEventOf<"COORDINATOR_DECISION", CoordinatorDecisionPayload>
  | TraceEventOf<"PARTICIPANT_BOUND", ParticipantBoundPayload>
  | TraceEventOf<"SKILL_INJECTED", SkillInjectedPayload>
  | TraceEventOf<"PRECOMMIT", PrecommitPayload>
  | TraceEventOf<"AGENT_RESPONSE_DELTA", AgentResponseDeltaPayload>
  | TraceEventOf<"TOOL_ACTION", ToolActionPayload>
  | TraceEventOf<"EVALUATOR_ASSESSMENT", EvaluatorAssessmentPayload>
  | TraceEventOf<"USER_MESSAGE", UserMessagePayload>
  | TraceEventOf<"CONSENSUS_UPDATE", ConsensusUpdatePayload>
  | TraceEventOf<"ROUND_BOUNDARY", RoundBoundaryPayload>
  | TraceEventOf<"STATE_CHANGE", StateChangePayload>
  | TraceEventOf<"BASELINE_RESULT", BaselineResultPayload>
  | TraceEventOf<"SYNTHESIS_COMPLETED", SynthesisCompletedPayload>
  | TraceEventOf<"CONVERSATION_TERMINAL", ConversationTerminalPayload>
  | TraceEventOf<"DRY_RUN_RESULT", DryRunResultPayload>
  | TraceEventOf<"ERROR", ErrorPayload>
  | TraceEventOf<"OPERATION_LIFECYCLE", OperationLifecyclePayload>
  | TraceEventOf<"APPROVAL_REQUESTED", ApprovalRequestedPayload>
  | TraceEventOf<"APPROVAL_RESOLVED", ApprovalResolvedPayload>
  | TraceEventOf<"CALLER_CANCELLED", CallerCancelledPayload>
  | TraceEventOf<"ARTIFACT_CREATED", ArtifactCreatedPayload>
  | TraceEventOf<"ARTIFACT_UPDATED", ArtifactUpdatedPayload>
  | TraceEventOf<"NATIVE_HISTORY_RECONCILED", NativeHistoryReconciledPayload>;
type AssertTrue<Value extends true> = Value;
export type TraceEventKindParity = AssertTrue<
  ConversationWire.SameUnion<TraceEvent["type"], ConversationWire.ConversationTraceEventKindV1>
>;
export type TraceDecisionOutcomeParity = AssertTrue<
  ConversationWire.SameUnion<
    RoundDecision["outcome"],
    ConversationWire.ConversationDecisionOutcomeV1
  >
>;
export type TraceToolIntentParity = AssertTrue<
  ConversationWire.SameUnion<RoleSpec["tools"][number], ConversationWire.ConversationToolIntentV1>
>;
export type TraceSandboxParity = AssertTrue<
  ConversationWire.SameUnion<
    NonNullable<RoleSpec["sandbox"]>,
    ConversationWire.ConversationSandboxV1
  >
>;
export type TraceArtifactUpdatedTypeParity = AssertTrue<
  ConversationWire.SameUnion<
    ArtifactUpdatedPayload["artifact_type"],
    ConversationWire.ConversationArtifactTypeV1
  >
>;
export type PublicTraceProjection = {
  [T in TraceEvent as T["type"]]: { type: T["type"]; payload: PublicProjection<T["payload"]> };
}[TraceEvent["type"]];
export type PublicTraceEvent = PublicTraceProjection;
export type PublicTraceArtifactUpdatedTypeParity = AssertTrue<
  ConversationWire.SameUnion<
    Extract<
      PublicTraceEvent,
      { type: typeof ConversationWire.CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_UPDATED }
    >["payload"]["artifact_type"],
    ConversationWire.ConversationArtifactTypeV1
  >
>;
export type PublicTraceRequiredArtifactRefParity = AssertTrue<
  null extends Extract<
    PublicTraceEvent,
    {
      type:
        | typeof ConversationWire.CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_CREATED
        | typeof ConversationWire.CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_UPDATED;
    }
  >["payload"]["ref"]
    ? false
    : true
>;
export type PublicTraceRequiredSynthesisRefParity = AssertTrue<
  null extends Extract<
    PublicTraceEvent,
    { type: typeof ConversationWire.CONVERSATION_TRACE_EVENT_KIND.SYNTHESIS_COMPLETED }
  >["payload"]["decision_matrix_ref" | "baseline_comparison_ref"]
    ? false
    : true
>;
export interface PolicyEmission {
  idempotency_key: string;
  event: TraceEvent;
}
