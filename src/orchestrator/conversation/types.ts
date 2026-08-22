import type { AgentBinding, ResolvedAgentBinding } from "../../agents/binding.js";
import type { Engine } from "../../core/types.js";
import type { EngineChunk, EngineSessionResult } from "../../dispatch/session-types.js";
import type { EvaluatorOutput, RoundDecision } from "../consensus.js";
import type {
  ApprovalDecision,
  ApprovalToken,
  ConversationHealth,
  ConversationLifecycle,
  OpaqueSessionRef,
  PolicyEmission,
  PublicStoredTraceEvent,
  StoredTraceEvent,
  TerminalLifecycle,
  TraceCorrelation,
  TraceEvent,
} from "../trace/types.js";

export type {
  ApprovalDecision,
  ApprovalToken,
  ConversationHealth,
  ConversationLifecycle,
  TerminalLifecycle,
};

declare const attemptRefBrand: unique symbol;
export type AttemptRef = string & { readonly [attemptRefBrand]: "AttemptRef" };
declare const conversationArtifactRefBrand: unique symbol;
export type ConversationArtifactRef = string & {
  readonly [conversationArtifactRefBrand]: "ConversationArtifactRef";
};

export type ConversationArtifactType =
  | "decision_matrix"
  | "plan"
  | "diff"
  | "tests"
  | "synthesis"
  | "transcript";

export interface ArtifactCreateRequest {
  artifact_type: ConversationArtifactType;
  content: string | Uint8Array;
  idempotency_key: string;
}

export interface ArtifactCreateResult {
  artifact_id: string;
  ref: ConversationArtifactRef;
}

export interface ArtifactUpdateRequest extends ArtifactCreateRequest {
  artifact_id: string;
  previous_ref: ConversationArtifactRef;
}

export interface ArtifactUpdateResult extends ArtifactCreateResult {
  previous_ref: ConversationArtifactRef;
}

export type PolicyAttemptPurpose =
  | "direct"
  | "participant"
  | "evaluator"
  | "baseline"
  | "plan"
  | "review"
  | "verify"
  | "orchestrate";

export interface PolicyAttemptRequest {
  participantId: string;
  bindingIndex: number;
  purpose: PolicyAttemptPurpose;
  promptInput: string;
  parent?: AttemptRef;
}

type EventOf<T extends TraceEvent["type"]> = Extract<TraceEvent, { type: T }>;
type EmissionOf<T extends TraceEvent["type"]> = Omit<PolicyEmission, "event"> & {
  event: EventOf<T>;
};

export type CoordinatorEmission = EmissionOf<
  | "round_boundary"
  | "consensus_update"
  | "baseline_result"
  | "synthesis_completed"
  | "dry_run_result"
  | "approval_requested"
  | "error"
>;

export type AttemptEmission = EmissionOf<
  "precommit" | "agent_response_delta" | "tool_action" | "evaluator_assessment" | "error"
>;

export interface PolicyAttempt {
  readonly ref: AttemptRef;
  readonly completion: Promise<EngineSessionResult>;
  emit(emission: AttemptEmission): Promise<StoredTraceEvent>;
  onChunk(listener: (chunk: Readonly<EngineChunk>) => void): Unsubscribe;
}

export interface ConversationContext {
  readonly correlation: Readonly<TraceCorrelation>;
  readonly topic: string;
  readonly policy: string;
  readonly maxRounds: number;
  readonly baselineEnabled: boolean;
  readonly evaluatorAutoAdded: boolean;
  readonly bindings: readonly ResolvedAgentBinding[];
  readonly participantIds: readonly string[];
  readonly bindingReadiness: readonly Readonly<{
    engine_available: boolean;
    model_valid: boolean;
  }>[];
  readonly signal: AbortSignal;
  messages(): Promise<readonly MessageRequest[]>;
  emit(emission: CoordinatorEmission): Promise<StoredTraceEvent>;
  launchAttempt(request: PolicyAttemptRequest): PolicyAttempt;
  createArtifact(request: ArtifactCreateRequest): Promise<ArtifactCreateResult>;
  updateArtifact(request: ArtifactUpdateRequest): Promise<ArtifactUpdateResult>;
}

export interface ConversationPolicy {
  readonly name: string;
  dryRun(context: ConversationContext): Promise<DryRunResult>;
  execute(context: ConversationContext): Promise<ConversationOrchestrationResult>;
  continueAfterApproval?(
    context: ConversationContext,
    decision: ApprovalDecision,
  ): Promise<ConversationOrchestrationResult>;
}

/** JSON-safe authority needed to rematerialize a participant through the canonical binder. */
export interface ConversationBinding {
  participant_id: string;
  input: AgentBinding;
}

/** Private conversation index record; it deliberately stores no materialized spawn projection. */
export interface ConversationManifest {
  version: "1.0";
  conversation_id: string;
  workflow_id: string;
  revision_id: string;
  run_id: string;
  parent_conversation_id: string | null;
  parent_revision_id: string | null;
  topic: string;
  policy: string;
  max_rounds: number;
  /** Legacy records omit this field and are normalized to true on read. */
  baseline_enabled?: boolean;
  /** Private resolver decision; legacy records normalize to false. */
  evaluator_auto_added?: boolean;
  repo_root: string;
  phase: number;
  task_text: string;
  bindings: ConversationBinding[];
  created_at: string;
}

export interface DryRunParticipant {
  participant_id: string;
  role_ref: string;
  engine: Engine;
  model: string | null;
  engine_available: boolean;
  model_valid: boolean;
}

export interface DryRunResult {
  participants: DryRunParticipant[];
  evaluator_auto_added: boolean;
  engines_available: Engine[];
  models_valid: boolean;
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

/** Active rounds retain partial responses; an ended round always has complete=true and a decision. */
export interface Round {
  round_id: string;
  participant_responses: RoundResponse[];
  evaluator_assessments: RoundAssessment[];
  decision: RoundDecision | null;
  complete: boolean;
}

export interface ConversationParticipantSnapshot {
  participant_id: string;
  role_ref: string;
  engine: Engine;
  model: string | null;
  public_session_ref: OpaqueSessionRef | null;
}

export interface ConversationSnapshot {
  conversation_id: string;
  lifecycle: ConversationLifecycle;
  health: ConversationHealth;
  policy: string;
  topic: string;
  participants: ConversationParticipantSnapshot[];
  rounds: Round[];
  consensus_score: number | null;
  last_seq: number;
}

export type FoldedConversation = ConversationSnapshot;

export interface ConversationCreateParticipant {
  role_ref: string;
  engine: string;
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

/** Runtime result; the Task 8 HTTP adapter adds its independently-issued stream token. */
export interface ConversationCreateResult {
  conversation_id: string;
  revision_id: string;
  result: ConversationOrchestrationResult;
}

export interface ConversationInvocationOptions {
  baselineEnabled?: boolean;
}

export interface ConversationStartResult {
  conversation_id: string;
  revision_id: string;
  operation_id: string;
  completion: Promise<ConversationCreateResult>;
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

export type ApprovalResolveResponse = ApprovalDecision & { resolved: true };
export type ApprovalResolveResult =
  | { status: 202; body: ApprovalResolveResponse }
  | { status: 404; body: { code: "approval_not_found" } }
  | {
      status: 409;
      body: {
        code: "approval_route_body_mismatch" | "approval_operation_mismatch" | "approval_conflict";
      };
    };

export interface OperationCancelCommand {
  conversation_id: string;
  operation_id: string;
  actor: string;
  reason: string | null;
}

export type OperationCancelResult =
  | { status: 202; body: { operation_id: string; cancelled: true } }
  | { status: 404; body: { code: "operation_not_found" } }
  | {
      status: 409;
      body: {
        code:
          | "operation_route_body_mismatch"
          | "operation_conversation_mismatch"
          | "operation_not_cancellable";
      };
    };

export interface ConversationOrchestrationResult {
  operation_id: string;
  status: "completed" | "aborted" | "failed" | "awaiting_approval";
  artifact_refs: string[];
}

export interface StreamTokenRenewalResponse {
  stream_token: string;
  stream_token_expires_at: string;
}

export type ConversationListener = (event: PublicStoredTraceEvent) => void;
export type Unsubscribe = () => void;

export interface ConversationService {
  create(
    request: ConversationCreateRequest,
    options?: ConversationInvocationOptions,
  ): Promise<ConversationCreateResult>;
  start(
    request: ConversationCreateRequest,
    options?: ConversationInvocationOptions,
  ): Promise<ConversationStartResult>;
  dryRun(
    request: ConversationCreateRequest,
    options?: ConversationInvocationOptions,
  ): Promise<DryRunResult>;
  message(id: string, request: MessageRequest): Promise<MessageResponse>;
  pause(id: string): Promise<PauseResponse>;
  resume(id: string): Promise<ResumeResponse>;
  stop(id: string): Promise<StopResponse>;
  resolveApproval(id: string, decision: ApprovalDecision): Promise<ApprovalResolveResult>;
  cancelOperation(command: OperationCancelCommand): Promise<OperationCancelResult>;
  snapshot(id: string): Promise<ConversationSnapshot | null>;
  events(id: string, afterSeq: number): Promise<PublicStoredTraceEvent[] | null>;
  subscribe(id: string, listener: ConversationListener, afterSeq?: number): Unsubscribe | null;
}

export type ConversationSseFrame =
  | { id: string; event: "trace"; data: PublicStoredTraceEvent }
  | { id: string; event: "snapshot"; data: ConversationSnapshot }
  | { event: "error"; data: { code: string; message: string } }
  | { event: "heartbeat"; data: "" };
