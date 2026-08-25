import type { ActionProposalRequestV1, ActionRequestAuthorityV1 } from "../../actions/index.js";
import { TraceLifecycleConflictError } from "../trace/store.js";
import { projectDryRunResult } from "./boundary-projection.js";
import { ConversationContinuationRuntime } from "./continuation-runtime.js";
import { snapshotRuntimeValue } from "./emission-authority.js";
import { ConversationAuthorityClosedError } from "./lifecycle-gate.js";
import {
  ConversationSubscribers,
  type RuntimeCreateRequest,
  bindingAuthorities,
  canonicalMessageRequest,
  isTerminalLifecycle,
  messageRevisionKey,
} from "./policy-registry.js";
import {
  settleConfiguredPrivateFileRange,
  settlePersistFailedPrivateFileRange,
} from "./private-file-range-commit-authority.js";
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
import { revisionQuiescenceReader } from "./service-revision-quiescence.js";
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
export class ConversationOrchestrator implements ConversationService {
  private readonly options: ConversationRuntimeOptions;
  private readonly runtime: ConversationRuntime;
  private readonly subscribers = new ConversationSubscribers();
  private readonly continuations: ConversationContinuationRuntime;
  private readonly revisions: ConversationRevisionAuthority;
  private readonly deferredRevisions: ConversationDeferredRevisionAuthority;
  private readonly requests: ConversationRequestMaterializer;
  private readonly revisionLaneRetry: RevisionLaneRetryRuntime | null;
  private readonly execution: ConversationExecutionRuntime;
  private readonly now: () => string;
  private readonly schedule: (task: () => void) => void;
  constructor(options: ConversationRuntimeOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.options = withConversationHomeAuthorities(options, this.now);
    this.runtime = new ConversationRuntime(this.options);
    this.schedule = this.options.schedule ?? ((task) => setTimeout(task, 0));
    this.requests = new ConversationRequestMaterializer(this.runtime, this.options, this.now);
    this.execution = new ConversationExecutionRuntime(this.runtime, this.options);
    this.revisionLaneRetry = this.options.homeAuthorities
      ? new RevisionLaneRetryRuntime(this.options, this.options.homeAuthorities.handoffs)
      : null;
    this.runtime.onAppend((event) => {
      this.subscribers.notify(event);
      this.options.onConversationSourceCommitted?.(event);
    });
    this.continuations = new ConversationContinuationRuntime(
      this.runtime,
      this.options,
      (manifest, operationId, result) => this.execution.finalize(manifest, operationId, result),
    );
    this.revisions = createConversationRevisionAuthority(
      this.options,
      this.runtime,
      this.now,
      this.schedule,
      (manifest, operationId) => this.execution.execute(manifest, operationId),
    );
    this.deferredRevisions = createConversationDeferredRevisionAuthority(
      this.options,
      this.runtime,
      this.now,
      this.schedule,
      (manifest, operationId) => this.execution.execute(manifest, operationId),
    );
  }
  async start(
    input: ConversationCreateRequest | RuntimeCreateRequest,
    options: ConversationInvocationOptions = {},
  ): Promise<ConversationStartResult> {
    const request = await this.requests.materialize(input, options);
    if (!request.topic || !request.policy || request.maxRounds < 1 || !request.bindings.length)
      throw new Error("invalid conversation create request");
    this.options.policies.require(request.policy);
    const manifest = this.requests.manifest(request);
    const bindings = request.bindings.map((binding) => binding.materialized);
    const privateFileRange = request.private_file_range;
    const createContextKey = `conversation-create:${manifest.conversation_id}`;
    if (privateFileRange && !this.options.homeAuthorities)
      throw new Error("private file range authority is unavailable");
    if (privateFileRange && this.options.homeAuthorities) {
      this.options.homeAuthorities.privateFileRanges.reserve(
        privateFileRange,
        createContextKey,
        this.now(),
      );
      try {
        this.options.homeAuthorities.privateTurnContexts.writeCreate({
          conversationId: manifest.conversation_id,
          targetParticipantIds: manifest.bindings.map((binding) => binding.participant_id),
          createdAt: this.now(),
          handoff: privateFileRange,
          fileRange: this.options.homeAuthorities.privateFileRanges.content(privateFileRange),
        });
      } catch (error) {
        this.options.homeAuthorities.privateFileRanges.release(
          privateFileRange,
          createContextKey,
          this.now(),
        );
        throw error;
      }
    }
    let operationId: string;
    try {
      operationId = this.runtime.begin(manifest, bindings);
    } catch (error) {
      if (privateFileRange && this.options.homeAuthorities)
        this.options.homeAuthorities.privateFileRanges.release(
          privateFileRange,
          createContextKey,
          this.now(),
        );
      throw error;
    }
    try {
      this.runtime.persist(manifest, bindings);
    } catch (error) {
      if (privateFileRange && this.options.homeAuthorities)
        settlePersistFailedPrivateFileRange(
          this.options.artifactStore,
          this.options.homeAuthorities,
          privateFileRange,
          manifest.conversation_id,
          createContextKey,
          this.now(),
          manifest,
          bindingAuthorities(manifest, bindings),
        );
      await this.runtime.abandon(manifest.conversation_id, "conversation persistence failed");
      throw error;
    }
    try {
      await this.runtime.configure(manifest.conversation_id);
    } catch (error) {
      if (privateFileRange && this.options.homeAuthorities)
        await settleConfiguredPrivateFileRange(
          this.options.traceStore,
          this.options.homeAuthorities,
          privateFileRange,
          manifest.conversation_id,
          createContextKey,
          this.now(),
        );
      await this.runtime.abandon(manifest.conversation_id, "conversation configure failed");
      throw error;
    }
    if (privateFileRange && this.options.homeAuthorities) {
      this.options.homeAuthorities.privateFileRanges.consume(
        privateFileRange,
        createContextKey,
        `conversation:${manifest.conversation_id}:create`,
        this.now(),
      );
    }
    const completion = new Promise<ConversationCreateResult>((resolve, reject) => {
      this.schedule(() => void this.execution.execute(manifest, operationId).then(resolve, reject));
    });
    void completion.catch(() => undefined);
    return Object.freeze({
      conversation_id: manifest.conversation_id,
      revision_id: manifest.revision_id,
      operation_id: operationId,
      completion,
    });
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
    if (state.lifecycle !== "ACTIVE")
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
    if (state.lifecycle !== "ACTIVE")
      throw new ConversationControlConflictError("pause requires ACTIVE");
    if (!this.runtime.operationId(id)) {
      await this.runtime.restoreControl(id).catch(rethrowControlConflict);
    }
    try {
      await this.runtime.transition(id, "PAUSED", state.health);
    } catch (error) {
      rethrowControlConflict(error);
    }
    return { paused: true, lifecycle: "PAUSED" };
  }
  async resume(id: string): Promise<ResumeResponse> {
    const state = await this.snapshot(id);
    if (!state) throw new ConversationNotFoundError("conversation not found");
    if (state.lifecycle !== "PAUSED")
      throw new ConversationControlConflictError("resume requires PAUSED");
    await this.runtime.restore(id).catch(rethrowControlConflict);
    try {
      await this.runtime.transition(id, "ACTIVE", state.health);
    } catch (error) {
      rethrowControlConflict(error);
    }
    return { resumed: true, active_state: "ACTIVE" };
  }
  async stop(id: string): Promise<StopResponse> {
    const state = await this.runtime.controlState(id);
    if (!state) throw new ConversationNotFoundError("conversation not found");
    if (isTerminalLifecycle(state.lifecycle))
      throw new ConversationControlConflictError("conversation is terminal");
    if (!this.runtime.operationId(id)) {
      await this.runtime.restoreControl(id).catch(rethrowControlConflict);
    }
    if (state.lifecycle === "INIT") await this.runtime.configure(id, false);
    const terminal = await this.runtime
      .terminal(id, "STOPPED", state.health, null, null, "conversation stopped")
      .catch(rethrowControlConflict);
    this.runtime.finish(id);
    if (terminal !== "STOPPED")
      throw new ConversationControlConflictError("conversation is terminal");
    return { stopped: true, terminal_state: "STOPPED" };
  }
  async resolveApproval(id: string, decision: ApprovalDecision): Promise<ApprovalResolveResult> {
    const captured = snapshotRuntimeValue(decision);
    const state = await this.snapshot(id);
    const probe = await this.runtime.resolveApproval(id, captured, false);
    if (!probe.requiresRestore || state?.lifecycle !== "ACTIVE") return probe.response;
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

  revisionOperationQuiescent(conversationId: string, operationId: string): boolean {
    return revisionQuiescenceReader(
      this.runtime,
      this.revisionLaneRetry,
      this.options.homeAuthorities?.revisionLanes ?? null,
    )(conversationId, operationId);
  }
  retryRevisionLanes(input: Parameters<RevisionLaneRetryRuntime["retry"]>[0]) {
    if (!this.revisionLaneRetry) throw new Error("revision retry runtime authority is absent");
    return this.revisionLaneRetry.retry(input);
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
