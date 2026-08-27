import type { BrowserHostActionRequestV1 } from "../../actions/index.js";
import type { AgentBinding, ResolvedAgentBinding } from "../../agents/binding.js";
import type { AgentHostToolV1, Engine } from "../../core/agent-contract.js";
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
import type { ConversationOrchestrationResultStatus } from "./conversation-command-result-contract.js";
import type {
  AgentSocialIntentRequestV1,
  PublicQuoteReferenceV1,
} from "./conversation-interaction-types.js";
import type { ConversationMessageQueueTargetParticipantsV1 } from "./conversation-message-queue-contract.js";
import type { PublicConversationMessageQueueInvalidationV1 } from "./conversation-message-queue-records.js";
import type * as ConversationWire from "./conversation-public-wire-contract.js";
import type { ConversationSseFrameV1 } from "./conversation-sse-contract.js";
import type { PrivateFileRangeHandoffBindingV1 } from "./private-file-range-staging-store.js";
import type {
  ConversationTurnPreparationRequestV1,
  PreparedConversationTurnV1,
} from "./turn-delivery-types.js";

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

export type ConversationArtifactType = ConversationWire.ConversationArtifactTypeV1;

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
  delivery?: PreparedConversationTurnV1;
  parent?: AttemptRef;
}

type EventOf<T extends TraceEvent["type"]> = Extract<TraceEvent, { type: T }>;
type EmissionOf<T extends TraceEvent["type"]> = Omit<PolicyEmission, "event"> & {
  event: EventOf<T>;
};

export type CoordinatorEmission = EmissionOf<
  | typeof ConversationWire.CONVERSATION_TRACE_EVENT_KIND.ROUND_BOUNDARY
  | typeof ConversationWire.CONVERSATION_TRACE_EVENT_KIND.CONSENSUS_UPDATE
  | typeof ConversationWire.CONVERSATION_TRACE_EVENT_KIND.BASELINE_RESULT
  | typeof ConversationWire.CONVERSATION_TRACE_EVENT_KIND.SYNTHESIS_COMPLETED
  | typeof ConversationWire.CONVERSATION_TRACE_EVENT_KIND.DRY_RUN_RESULT
  | typeof ConversationWire.CONVERSATION_TRACE_EVENT_KIND.APPROVAL_REQUESTED
  | typeof ConversationWire.CONVERSATION_TRACE_EVENT_KIND.ERROR
>;

export type AttemptEmission = EmissionOf<
  | typeof ConversationWire.CONVERSATION_TRACE_EVENT_KIND.PRECOMMIT
  | typeof ConversationWire.CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA
  | typeof ConversationWire.CONVERSATION_TRACE_EVENT_KIND.TOOL_ACTION
  | typeof ConversationWire.CONVERSATION_TRACE_EVENT_KIND.EVALUATOR_ASSESSMENT
  | typeof ConversationWire.CONVERSATION_TRACE_EVENT_KIND.ERROR
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
  prepareTurn(request: ConversationTurnPreparationRequestV1): Promise<PreparedConversationTurnV1>;
  publishSocialIntent(input: {
    participant_id: string;
    response_event_id: string;
    request: AgentSocialIntentRequestV1;
  }): { accepted: boolean; diagnostic_code: string | null };
  stageActionCandidate(input: {
    participant_id: string;
    response_idempotency_key: string;
    candidate: unknown;
  }): { accepted: boolean; diagnostic_code: string | null };
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
  /** Host-owned tools are independent of native CLI tools and are denied when omitted. */
  host_tools?: ConversationHostToolV1[];
}

export type ConversationHostToolV1 = AgentHostToolV1;

export interface BrowserHostActionCandidateV1 {
  schema_version: "1.0";
  candidate: BrowserHostActionRequestV1;
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
  stage: ConversationWire.ConversationAssessmentStageV1;
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
  engine: Engine;
  model?: string;
  host_tools?: ConversationHostToolV1[];
}

export interface ConversationCreateRequest {
  topic: string;
  policy?: string;
  participants?: ConversationCreateParticipant[];
  max_rounds?: number;
  private_file_range?: PrivateFileRangeHandoffBindingV1;
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
  target_participants?: ConversationMessageQueueTargetParticipantsV1;
  quote_refs?: PublicQuoteReferenceV1[];
  private_file_range?: PrivateFileRangeHandoffBindingV1;
}

export interface MessageResponse {
  message_id: string;
  accepted: true;
  child_conversation_id?: string;
  location?: string;
}

export interface PauseResponse {
  paused: true;
  lifecycle: typeof ConversationWire.CONVERSATION_TRANSITION_LIFECYCLE.PAUSED;
}

export interface ResumeResponse {
  resumed: true;
  active_state: typeof ConversationWire.CONVERSATION_TRANSITION_LIFECYCLE.ACTIVE;
}

export interface StopResponse {
  stopped: true;
  terminal_state: typeof ConversationWire.CONVERSATION_TERMINAL_LIFECYCLE.STOPPED;
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
  status: ConversationOrchestrationResultStatus;
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

export type ConversationSseFrame = ConversationSseFrameV1<
  PublicStoredTraceEvent,
  ConversationSnapshot,
  PublicConversationMessageQueueInvalidationV1
>;
