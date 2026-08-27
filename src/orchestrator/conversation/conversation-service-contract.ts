import type { ApprovalDecision, PublicStoredTraceEvent } from "../trace/types.js";
import type { PublicConversationMessageQueueInvalidationV1 } from "./conversation-message-queue-records.js";
import type { ConversationSseFrameV1 } from "./conversation-sse-contract.js";
import type {
  ApprovalResolveResult,
  ConversationCreateRequest,
  ConversationCreateResult,
  ConversationInvocationOptions,
  ConversationListener,
  ConversationSnapshot,
  ConversationStartResult,
  DryRunResult,
  MessageRequest,
  MessageResponse,
  OperationCancelCommand,
  OperationCancelResult,
  PauseResponse,
  ResumeResponse,
  StopResponse,
  Unsubscribe,
} from "./types.js";

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
