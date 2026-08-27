import type { ActionProposalRequestV1, ActionRequestAuthorityV1 } from "../../actions/index.js";
import { digestV1 } from "../../durability/index.js";
import { TraceLifecycleConflictError } from "../trace/store.js";
import { projectDryRunResult } from "./boundary-projection.js";
import { ConversationContinuationRuntime } from "./continuation-runtime.js";
import type { ConversationQueuedMessageDeliveryHostV1 } from "./conversation-message-queue-dispatcher.js";
import type { ConversationMessageQueueRuntimeV1 } from "./conversation-message-queue-runtime.js";
import type { ConversationQueuedMessageDeliveryAuthorityV1 } from "./conversation-message-queue-trace-authority.js";
import {
  CONVERSATION_LIFECYCLE,
  CONVERSATION_TERMINAL_LIFECYCLE,
  CONVERSATION_TRANSITION_LIFECYCLE,
} from "./conversation-public-wire-contract.js";
import { snapshotRuntimeValue } from "./emission-authority.js";
import { ConversationAuthorityClosedError } from "./lifecycle-gate.js";
import {
  ConversationSubscribers,
  type RuntimeCreateRequest,
  canonicalMessageRequest,
  isTerminalLifecycle,
  messageRevisionKey,
} from "./policy-registry.js";
import { ConversationRequestMaterializer } from "./request-materializer.js";
import { proposeDeferredConversationAction } from "./revision-action-service.js";
import type { ConversationRevisionAuthority } from "./revision-authority.js";
import type { ConversationDeferredRevisionAuthority } from "./revision-deferred-authority.js";
import { RevisionLaneRetryRuntime } from "./revision-lane-retry-runtime.js";
import { continueTerminalConversationMessage } from "./revision-message.js";
import {
  createConversationDeferredRevisionAuthority,
  createConversationRevisionAuthority,
  withConversationHomeAuthorities,
} from "./revision-service-factory.js";
import { ConversationRuntime, type ConversationRuntimeOptions } from "./runtime.js";
import {
  ConversationControlConflictError,
  ConversationInvalidTargetParticipantError,
  ConversationNotFoundError,
  rethrowControlConflict,
} from "./service-errors.js";
import { ConversationExecutionRuntime } from "./service-execution-runtime.js";
import { createConversationServiceMessageQueue } from "./service-message-queue-factory.js";
import { ConversationPreparedSourcePublicationV1 } from "./service-prepared-publication.js";
import { ConversationServiceQueueWakeV1 } from "./service-queue-wake.js";
import { revisionQuiescenceReader } from "./service-revision-quiescence.js";
import {
  type ConversationAllocatedStartV1,
  ConversationStartAuthorityV1,
} from "./service-start-authority.js";
export {
  ConversationControlConflictError,
  ConversationInvalidTargetParticipantError,
  ConversationNotFoundError,
} from "./service-errors.js";
import type {
  ApprovalDecision,
  ApprovalResolveResult,
  ConversationCreateRequest,
  ConversationCreateResult,
  ConversationInvocationOptions,
  ConversationListener,
  ConversationService,
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
/** Public domain service. It delegates every append/launch into its private runtime authority. */
export class ConversationOrchestrator
  implements ConversationService, ConversationQueuedMessageDeliveryHostV1
{
  private readonly options: ConversationRuntimeOptions;
  private readonly runtime: ConversationRuntime;
  private readonly subscribers = new ConversationSubscribers();
  private readonly continuations: ConversationContinuationRuntime;
  private readonly revisions: ConversationRevisionAuthority;
  private readonly deferredRevisions: ConversationDeferredRevisionAuthority;
  private readonly requests: ConversationRequestMaterializer;
  private readonly revisionLaneRetry: RevisionLaneRetryRuntime | null;
  private readonly execution: ConversationExecutionRuntime;
  private readonly starts: ConversationStartAuthorityV1;
  private readonly now: () => string;
  private readonly schedule: (task: () => void) => void;
  private readonly preparedPublication: ConversationPreparedSourcePublicationV1;
  private readonly queueWake: ConversationServiceQueueWakeV1;
  readonly messageQueue: ConversationMessageQueueRuntimeV1 | null;
  constructor(options: ConversationRuntimeOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.options = withConversationHomeAuthorities(options, this.now);
    this.runtime = new ConversationRuntime(this.options);
    this.schedule = this.options.schedule ?? ((task) => setTimeout(task, 0));
    this.requests = new ConversationRequestMaterializer(this.runtime, this.options, this.now);
    this.execution = new ConversationExecutionRuntime(this.runtime, this.options);
    this.queueWake = new ConversationServiceQueueWakeV1(this.execution, () => this.messageQueue);
    this.preparedPublication = new ConversationPreparedSourcePublicationV1(
      this.subscribers,
      this.options.onConversationSourceCommitted,
    );
    this.starts = new ConversationStartAuthorityV1(
      this.runtime,
      this.requests,
      { execute: (manifest, operationId) => this.queueWake.execute(manifest, operationId) },
      this.options,
      this.now,
      this.schedule,
      this.preparedPublication.authority,
    );
    this.revisionLaneRetry = this.options.homeAuthorities
      ? new RevisionLaneRetryRuntime(this.options, this.options.homeAuthorities.handoffs)
      : null;
    this.runtime.onAppend((event) => this.preparedPublication.append(event));
    this.continuations = new ConversationContinuationRuntime(
      this.runtime,
      this.options,
      (manifest, operationId, result) => this.execution.finalize(manifest, operationId, result),
      (conversationId) => this.queueWake.wake(conversationId),
    );
    this.revisions = createConversationRevisionAuthority(
      this.options,
      this.runtime,
      this.now,
      this.schedule,
      (manifest, operationId) => this.queueWake.execute(manifest, operationId),
      (conversationId) => this.queueWake.wake(conversationId),
    );
    this.deferredRevisions = createConversationDeferredRevisionAuthority(
      this.options,
      this.runtime,
      this.now,
      this.schedule,
      (manifest, operationId) => this.queueWake.execute(manifest, operationId),
      (conversationId) => this.queueWake.wake(conversationId),
    );
    this.messageQueue = createConversationServiceMessageQueue(
      this.options,
      this.now,
      this,
      this.schedule,
    );
  }
  async start(
    input: ConversationCreateRequest | RuntimeCreateRequest,
    options: ConversationInvocationOptions = {},
  ): Promise<ConversationStartResult> {
    return this.starts.start(input, options);
  }
  startAllocated(
    input: ConversationAllocatedStartV1,
    options: ConversationInvocationOptions = {},
  ): Promise<ConversationStartResult> {
    return this.starts.startAllocated(input, options);
  }
  async create(
    input: ConversationCreateRequest | RuntimeCreateRequest,
    options: ConversationInvocationOptions = {},
  ): Promise<ConversationCreateResult> {
    return (await this.start(input, options)).completion;
  }
  async dryRun(
    input: ConversationCreateRequest | RuntimeCreateRequest,
    options: ConversationInvocationOptions = {},
  ): Promise<DryRunResult> {
    const request = await this.requests.preview(input, options);
    if (!request.topic || !request.policy || request.maxRounds < 1 || !request.bindings.length)
      throw new Error("invalid conversation dry-run request");
    const manifest = this.requests.manifest(request);
    const bindings = request.bindings.map((binding) =>
      "preview" in binding ? binding.preview : binding.materialized,
    );
    const result = await this.options.policies
      .require(manifest.policy)
      .dryRun(this.runtime.previewContext(manifest, bindings));
    return projectDryRunResult(result);
  }
  async message(id: string, request: MessageRequest): Promise<MessageResponse> {
    const captured = canonicalMessageRequest(snapshotRuntimeValue(request));
    if (this.messageQueue) {
      const key = this.runtime.ids("message");
      const principal = digestV1("VF-CONVERSATION-SERVICE-MESSAGE-PRINCIPAL\0v1\0", {
        schema_version: "1.0",
        principal: "conversation-service",
      });
      const result = this.messageQueue.enqueueCompatibility(id, principal, key, captured);
      return { message_id: result.item.queue_item_id, accepted: true };
    }
    const manifest = this.runtime.manifest(id);
    const state = await this.snapshot(id);
    if (!manifest || !state) throw new ConversationNotFoundError("conversation not found");
    const quoteRefs = captured.quote_refs
      ? this.options.socialAuthority?.humanQuotes(id, captured.quote_refs)
      : undefined;
    if (captured.quote_refs && !quoteRefs)
      throw new Error("conversation interaction authority is unavailable");
    const message = {
      ...captured,
      ...(quoteRefs ? { quote_refs: quoteRefs } : {}),
    };
    const targets = message.target_participants ?? "all";
    if (
      targets !== "all" &&
      targets.some(
        (target) => !manifest.bindings.some((binding) => binding.participant_id === target),
      )
    )
      throw new ConversationInvalidTargetParticipantError("unknown target participant");
    if (isTerminalLifecycle(state.lifecycle)) {
      const key = messageRevisionKey(message);
      return continueTerminalConversationMessage({
        revisions: this.revisions,
        conversationId: id,
        snapshot: state,
        request: { ...message, target_participants: targets },
        messageKey: key,
      }).catch(rethrowControlConflict);
    }
    if (state.lifecycle !== CONVERSATION_TRANSITION_LIFECYCLE.ACTIVE)
      throw new ConversationControlConflictError("message requires ACTIVE");
    if (!this.runtime.operationId(id)) {
      await this.runtime.restoreControl(id).catch(rethrowControlConflict);
    }
    const messageId = this.runtime.ids("message");
    await this.runtime
      .userMessage(id, { ...message, target_participants: targets }, `message:${messageId}`)
      .catch(rethrowControlConflict);
    return { message_id: messageId, accepted: true };
  }
  async deliverQueuedMessage(input: {
    conversation_id: string;
    request: MessageRequest & { target_participants: "all" | string[] };
    message_key: string;
    authority: ConversationQueuedMessageDeliveryAuthorityV1;
  }): Promise<{ childId: string }> {
    const snapshot = await this.snapshot(input.conversation_id);
    if (!snapshot || !isTerminalLifecycle(snapshot.lifecycle))
      throw new ConversationControlConflictError("queued message requires stable terminal");
    const result = await this.revisions.continueMessageAction(
      input.conversation_id,
      snapshot,
      input.request,
      input.message_key,
      undefined,
      undefined,
      input.authority,
    );
    return { childId: result.childId };
  }
  queuedMessageReady(conversationId: string, revisionOperationId: string | null): boolean {
    return this.revisionOperationQuiescent(conversationId, revisionOperationId);
  }
  async proposeConversationAction(
    id: string,
    request: ActionProposalRequestV1,
    authority: ActionRequestAuthorityV1,
  ) {
    return proposeDeferredConversationAction({
      conversationId: id,
      manifest: this.runtime.manifest(id),
      snapshot: await this.snapshot(id),
      request,
      authority,
      revisions: this.deferredRevisions,
    });
  }
  commitConversationAction(input: {
    conversationId: string;
    proposalId: string;
    proposalDigest: string;
    approvalId: string;
    authority: ActionRequestAuthorityV1;
  }) {
    return this.deferredRevisions.commitAction(input).catch(rethrowControlConflict);
  }
  async pause(id: string): Promise<PauseResponse> {
    const state = await this.snapshot(id);
    if (!state) throw new ConversationNotFoundError("conversation not found");
    if (state.lifecycle !== CONVERSATION_TRANSITION_LIFECYCLE.ACTIVE)
      throw new ConversationControlConflictError("pause requires ACTIVE");
    if (!this.runtime.operationId(id)) {
      await this.runtime.restoreControl(id).catch(rethrowControlConflict);
    }
    try {
      await this.runtime.transition(id, CONVERSATION_TRANSITION_LIFECYCLE.PAUSED, state.health);
    } catch (error) {
      rethrowControlConflict(error);
    }
    return { paused: true, lifecycle: CONVERSATION_TRANSITION_LIFECYCLE.PAUSED };
  }
  async resume(id: string): Promise<ResumeResponse> {
    const state = await this.snapshot(id);
    if (!state) throw new ConversationNotFoundError("conversation not found");
    if (state.lifecycle !== CONVERSATION_TRANSITION_LIFECYCLE.PAUSED)
      throw new ConversationControlConflictError("resume requires PAUSED");
    await this.runtime.restore(id).catch(rethrowControlConflict);
    try {
      await this.runtime.transition(id, CONVERSATION_TRANSITION_LIFECYCLE.ACTIVE, state.health);
    } catch (error) {
      rethrowControlConflict(error);
    }
    return { resumed: true, active_state: CONVERSATION_TRANSITION_LIFECYCLE.ACTIVE };
  }
  async stop(id: string): Promise<StopResponse> {
    const state = await this.runtime.controlState(id);
    if (!state) throw new ConversationNotFoundError("conversation not found");
    if (isTerminalLifecycle(state.lifecycle))
      throw new ConversationControlConflictError("conversation is terminal");
    if (!this.runtime.operationId(id)) {
      await this.runtime.restoreControl(id).catch(rethrowControlConflict);
    }
    if (state.lifecycle === CONVERSATION_LIFECYCLE.INIT) await this.runtime.configure(id, false);
    const terminal = await this.runtime
      .terminal(
        id,
        CONVERSATION_TERMINAL_LIFECYCLE.STOPPED,
        state.health,
        null,
        null,
        "conversation stopped",
      )
      .catch(rethrowControlConflict);
    this.runtime.finish(id);
    this.queueWake.wake(id);
    if (terminal !== CONVERSATION_TERMINAL_LIFECYCLE.STOPPED)
      throw new ConversationControlConflictError("conversation is terminal");
    return { stopped: true, terminal_state: CONVERSATION_TERMINAL_LIFECYCLE.STOPPED };
  }
  async resolveApproval(id: string, decision: ApprovalDecision): Promise<ApprovalResolveResult> {
    const captured = snapshotRuntimeValue(decision);
    const state = await this.snapshot(id);
    const probe = await this.runtime.resolveApproval(id, captured, false);
    if (!probe.requiresRestore || state?.lifecycle !== CONVERSATION_TRANSITION_LIFECYCLE.ACTIVE)
      return probe.response;
    try {
      await this.runtime.restore(id);
    } catch (error) {
      const retry = await this.runtime.resolveApproval(id, captured, false);
      if (!retry.requiresRestore) return retry.response;
      if (
        error instanceof ConversationAuthorityClosedError ||
        error instanceof TraceLifecycleConflictError
      ) {
        return { status: 409, body: { code: "approval_conflict" } };
      }
      throw error;
    }
    const resolution = await this.runtime.resolveApproval(id, captured, true);
    if (resolution.fresh && resolution.response.status === 202) {
      this.continuations.start(id, captured);
    }
    return resolution.response;
  }
  async cancelOperation(command: OperationCancelCommand): Promise<OperationCancelResult> {
    const captured = snapshotRuntimeValue(command);
    const durable = await this.runtime.prepareCancellation(captured);
    if (durable) return durable;
    return this.runtime.cancelOperation(captured);
  }
  revisionOperationQuiescent(conversationId: string, revisionOperationId: string | null): boolean {
    return revisionQuiescenceReader(
      this.runtime,
      this.revisionLaneRetry,
      this.options.homeAuthorities?.revisionLanes ?? null,
    )(conversationId, revisionOperationId);
  }
  retryRevisionLanes(input: Parameters<RevisionLaneRetryRuntime["retry"]>[0]) {
    if (!this.revisionLaneRetry) throw new Error("revision retry runtime authority is absent");
    return this.queueWake.settle(
      input.operation.root_session_id,
      this.revisionLaneRetry.retry(input),
    );
  }
  wakeMessageQueue(conversationId: string): void {
    this.queueWake.wake(conversationId);
  }
  snapshot(id: string) {
    return this.runtime.snapshot(id);
  }
  events(id: string, afterSeq: number) {
    return this.runtime.events(id, afterSeq);
  }
  subscribe(id: string, listener: ConversationListener, afterSeq = 0): Unsubscribe | null {
    if (!this.runtime.exists(id)) return null;
    return this.subscribers.subscribe(id, listener, () => this.events(id, afterSeq), afterSeq);
  }
}
