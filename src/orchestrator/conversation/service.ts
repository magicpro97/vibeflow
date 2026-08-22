import { TraceLifecycleConflictError } from "../trace/store.js";
import {
  projectDryRunResult,
  projectRuntimeCreateRequest,
  projectRuntimePreviewRequest,
} from "./boundary-projection.js";
import { ConversationContinuationRuntime } from "./continuation-runtime.js";
import { snapshotRuntimeValue } from "./emission-authority.js";
import { ConversationAuthorityClosedError } from "./lifecycle-gate.js";
import {
  ConversationSubscribers,
  type RuntimeCreateRequest,
  type RuntimePreviewRequest,
  canonicalMessageRequest,
  conversationTerminal,
  isTerminalLifecycle,
  messageRevisionKey,
  projectOrchestrationResult,
} from "./policy-registry.js";
import { ConversationRuntime, type ConversationRuntimeOptions } from "./runtime.js";
import type {
  ApprovalDecision,
  ApprovalResolveResult,
  ConversationCreateRequest,
  ConversationCreateResult,
  ConversationInvocationOptions,
  ConversationListener,
  ConversationManifest,
  ConversationOrchestrationResult,
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
export class ConversationNotFoundError extends Error {}
export class ConversationInvalidTargetParticipantError extends Error {}
export class ConversationControlConflictError extends Error {}
const rethrowControlConflict = (error: unknown): never => {
  if (
    !(error instanceof TraceLifecycleConflictError) &&
    !(error instanceof ConversationAuthorityClosedError)
  )
    throw error;
  throw new ConversationControlConflictError(error.message);
};
/** Public domain service. It delegates every append/launch into its private runtime authority. */
export class ConversationOrchestrator implements ConversationService {
  private readonly runtime: ConversationRuntime;
  private readonly subscribers = new ConversationSubscribers();
  private readonly continuations: ConversationContinuationRuntime;
  private readonly now: () => string;
  private readonly schedule: (task: () => void) => void;
  constructor(private readonly options: ConversationRuntimeOptions) {
    this.runtime = new ConversationRuntime(options);
    this.now = options.now ?? (() => new Date().toISOString());
    this.schedule = options.schedule ?? ((task) => setTimeout(task, 0));
    this.runtime.onAppend((event) => this.subscribers.notify(event));
    this.continuations = new ConversationContinuationRuntime(
      this.runtime,
      options,
      (manifest, operationId, result) => this.finalizeResult(manifest, operationId, result),
      (manifest, operationId) => this.executeConfigured(manifest, operationId),
      this.now,
      this.schedule,
    );
  }
  private manifest(request: RuntimeCreateRequest | RuntimePreviewRequest): ConversationManifest {
    return {
      version: "1.0",
      conversation_id: this.runtime.ids("conversation"),
      workflow_id: this.runtime.ids("workflow"),
      revision_id: this.runtime.ids("revision"),
      run_id: this.runtime.ids("run"),
      parent_conversation_id: "parent" in request ? (request.parent?.conversationId ?? null) : null,
      parent_revision_id: "parent" in request ? (request.parent?.revisionId ?? null) : null,
      topic: request.topic,
      policy: request.policy,
      max_rounds: request.maxRounds,
      baseline_enabled: request.baselineEnabled ?? true,
      evaluator_auto_added: request.evaluatorAutoAdded ?? false,
      repo_root: request.repoRoot,
      phase: request.phase,
      task_text: request.topic,
      bindings: request.bindings.map((binding) => ({
        participant_id: binding.participantId,
        input: binding.input,
      })),
      created_at: this.now(),
    };
  }
  private async materializeRequest(
    request: ConversationCreateRequest | RuntimeCreateRequest,
    options: ConversationInvocationOptions = {},
  ): Promise<RuntimeCreateRequest> {
    const capturedOptions = snapshotRuntimeValue(options);
    const resolved =
      "bindings" in request ? request : await this.resolveRequest(snapshotRuntimeValue(request));
    return projectRuntimeCreateRequest(resolved, capturedOptions);
  }
  private resolveRequest(request: ConversationCreateRequest): Promise<RuntimeCreateRequest> {
    const resolver = this.options.resolveCreateRequest;
    if (!resolver) throw new Error("conversation create requires canonical binding resolution");
    return resolver(request);
  }
  private async previewRequest(
    request: ConversationCreateRequest | RuntimeCreateRequest,
    options: ConversationInvocationOptions,
  ): Promise<RuntimeCreateRequest | RuntimePreviewRequest> {
    if ("bindings" in request || !this.options.resolveDryRunRequest) {
      return this.materializeRequest(request, options);
    }
    const capturedOptions = snapshotRuntimeValue(options);
    const resolved = await this.options.resolveDryRunRequest(snapshotRuntimeValue(request));
    return projectRuntimePreviewRequest(resolved, capturedOptions);
  }
  private async executeConfigured(
    manifest: ConversationManifest,
    operationId: string,
  ): Promise<ConversationCreateResult> {
    let keepLive = false;
    try {
      let result: ConversationOrchestrationResult;
      const policy = this.options.policies.require(manifest.policy);
      try {
        result = await policy.execute(await this.runtime.context(manifest.conversation_id));
      } catch {
        result = {
          operation_id: operationId,
          status: "failed",
          artifact_refs: [],
        };
      }
      result = projectOrchestrationResult(
        result,
        operationId,
        manifest.conversation_id,
        this.options.artifactStore,
      );
      if (result.status === "awaiting_approval" && !policy.continueAfterApproval) {
        result = { operation_id: operationId, status: "failed", artifact_refs: [] };
      }
      result = await this.finalizeResult(manifest, operationId, result);
      keepLive = result.status === "awaiting_approval";
      return {
        conversation_id: manifest.conversation_id,
        revision_id: manifest.revision_id,
        result,
      };
    } finally {
      if (!keepLive) this.runtime.finish(manifest.conversation_id);
    }
  }
  private async finalizeResult(
    manifest: ConversationManifest,
    operationId: string,
    candidate: ConversationOrchestrationResult,
  ): Promise<ConversationOrchestrationResult> {
    let result =
      candidate.operation_id === operationId
        ? candidate
        : { operation_id: operationId, status: "failed" as const, artifact_refs: [] };
    const state = await this.snapshot(manifest.conversation_id);
    if (state && isTerminalLifecycle(state.lifecycle)) {
      const status =
        state.lifecycle === "COMPLETED"
          ? "completed"
          : state.lifecycle === "FAILED"
            ? "failed"
            : "aborted";
      return {
        operation_id: operationId,
        status,
        artifact_refs: status === "completed" ? result.artifact_refs : [],
      };
    }
    if (state?.lifecycle === "PAUSED" && result.status === "completed") {
      result = { operation_id: operationId, status: "aborted", artifact_refs: [] };
    }
    if (this.runtime.operationCancelled(manifest.conversation_id, operationId)) {
      result = { operation_id: operationId, status: "aborted", artifact_refs: [] };
    }
    const requested = conversationTerminal(result.status);
    if (!requested) {
      if (
        result.status === "awaiting_approval" &&
        !(await this.runtime.retain(manifest.conversation_id, operationId))
      ) {
        return { operation_id: operationId, status: "aborted", artifact_refs: [] };
      }
      return result;
    }
    if (state?.lifecycle !== "ACTIVE" && state?.lifecycle !== "PAUSED") {
      return result;
    }
    try {
      const effective = await this.runtime.terminal(
        manifest.conversation_id,
        requested,
        state.health,
        requested === "COMPLETED" ? null : result.status,
        requested === "COMPLETED" ? state.consensus_score : null,
      );
      return effective === requested
        ? result
        : { operation_id: operationId, status: "aborted", artifact_refs: [] };
    } catch {
      await this.runtime.terminal(
        manifest.conversation_id,
        "FAILED",
        state.health,
        "terminal append failed",
        null,
      );
      return { operation_id: operationId, status: "failed", artifact_refs: [] };
    }
  }
  async start(
    input: ConversationCreateRequest | RuntimeCreateRequest,
    options: ConversationInvocationOptions = {},
  ): Promise<ConversationStartResult> {
    const request = await this.materializeRequest(input, options);
    if (!request.topic || !request.policy || request.maxRounds < 1 || !request.bindings.length)
      throw new Error("invalid conversation create request");
    this.options.policies.require(request.policy);
    const manifest = this.manifest(request);
    const bindings = request.bindings.map((binding) => binding.materialized);
    const operationId = this.runtime.begin(manifest, bindings);
    try {
      this.runtime.persist(manifest, bindings);
    } catch (error) {
      await this.runtime.abandon(manifest.conversation_id, "conversation persistence failed");
      throw error;
    }
    try {
      await this.runtime.configure(manifest.conversation_id);
    } catch (error) {
      await this.runtime.abandon(manifest.conversation_id, "conversation configure failed");
      throw error;
    }
    const completion = new Promise<ConversationCreateResult>((resolve, reject) => {
      this.schedule(() => void this.executeConfigured(manifest, operationId).then(resolve, reject));
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
    const request = await this.previewRequest(input, options);
    if (!request.topic || !request.policy || request.maxRounds < 1 || !request.bindings.length)
      throw new Error("invalid conversation dry-run request");
    const manifest = this.manifest(request);
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
    const targets = captured.target_participants ?? "all";
    if (
      targets !== "all" &&
      targets.some(
        (target) => !manifest.bindings.some((binding) => binding.participant_id === target),
      )
    )
      throw new ConversationInvalidTargetParticipantError("unknown target participant");
    if (state.lifecycle === "COMPLETED") {
      const key = messageRevisionKey(captured);
      const existing = this.runtime.childRevision(id, key);
      const child = existing ?? (await this.continuations.childRevision(manifest, captured, key));
      return {
        message_id: key,
        accepted: true,
        child_conversation_id: child,
        location: `/api/conversations/${child}`,
      };
    }
    if (state.lifecycle !== "ACTIVE")
      throw new ConversationControlConflictError("message requires ACTIVE");
    if (!this.runtime.operationId(id)) {
      await this.runtime.restoreControl(id).catch(rethrowControlConflict);
    }
    const messageId = this.runtime.ids("message");
    await this.runtime
      .userMessage(id, { ...captured, target_participants: targets }, `message:${messageId}`)
      .catch(rethrowControlConflict);
    return { message_id: messageId, accepted: true };
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
