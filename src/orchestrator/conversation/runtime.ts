import { randomUUID } from "node:crypto";
import type { MaterializedAgentBinding, PreviewAgentBinding } from "../../agents/binding.js";
import { TraceLifecycleConflictError, type TraceStore } from "../trace/store.js";
import type { PublicStoredTraceEvent, TraceCorrelation } from "../trace/types.js";
import type { PersistedResumeBinding } from "./artifact-store.js";
import type { ConversationQueuedMessageDeliveryAuthorityV1 } from "./conversation-message-queue-runtime.js";
import {
  CONVERSATION_TERMINAL_LIFECYCLE,
  CONVERSATION_TRANSITION_LIFECYCLE,
  type ConversationTransitionLifecycleV1,
  isConversationGracefulTerminalLifecycle,
} from "./conversation-public-wire-contract.js";
import { previewBindingPolicyContext } from "./emission-authority.js";
import type { LiveConversation } from "./lifecycle-gate.js";
import type { RevisionPreparationPlanV1 } from "./lineage-revision-operation.js";
import { OperationTransitionReservedError } from "./operation-registry.js";
// biome-ignore format: production file ceiling
import {
  configurationEmissions, type rehydrateConversation, terminalJournalState,
} from "./policy-registry.js";
import { preparedStartCorrelation } from "./prepared-start-correlation.js";
import { configurationEnvelope } from "./restart-authority.js";
import { ConversationRestoreOperationMismatchError } from "./restart-runtime.js";
import { ConversationAppendNotifier } from "./runtime-append-notifier.js";
import {
  type ConversationRuntimeAuthorities,
  createConversationRuntimeAuthorities,
} from "./runtime-authorities.js";
import { runtimeCorrelation } from "./runtime-correlation.js";
import { createConversationRuntimeDelegates } from "./runtime-delegates.js";
import { createRuntimeLiveConversation } from "./runtime-live-conversation.js";
import type { ConversationRuntimeOptions } from "./runtime-options.js";
import { createRuntimePolicyContext } from "./runtime-policy-context.js";
import { publishRuntimeUserMessage } from "./runtime-private-file-message.js";
import { createConversationRuntimeReaders } from "./runtime-readers.js";
// biome-ignore format: production file ceiling
import type {
  ApprovalDecision, ConversationContext, ConversationCreateRequest, ConversationHealth, ConversationManifest, ConversationSnapshot, MessageRequest, OperationCancelCommand, OperationCancelResult, TerminalLifecycle,
} from "./types.js";
export type { ConversationRuntimeOptions } from "./runtime-options.js";
export { ConversationRestoreOperationMismatchError };
type RuntimeDelegates = ReturnType<typeof createConversationRuntimeDelegates>;
export class ConversationRuntime {
  private readonly id: (kind: string) => string;
  private readonly operations: ConversationRuntimeAuthorities["operations"];
  private readonly effects: ConversationRuntimeAuthorities["effects"];
  private readonly artifacts: ConversationRuntimeAuthorities["artifacts"];
  private readonly restarts: ConversationRuntimeAuthorities["restarts"];
  private readonly attempts: ConversationRuntimeAuthorities["attempts"];
  private readonly controls: ConversationRuntimeAuthorities["controls"];
  private readonly emissions: ConversationRuntimeAuthorities["emissions"];
  readonly controlState: ConversationRuntimeAuthorities["restarts"]["controlState"];
  readonly events: (id: string, afterSeq: number) => Promise<PublicStoredTraceEvent[] | null>;
  readonly operationOwnerState: ConversationRuntimeAuthorities["operations"]["ownerState"];
  readonly rehydrate: (id: string) => ReturnType<typeof rehydrateConversation>;
  readonly snapshot: (id: string) => Promise<ConversationSnapshot | null>;
  readonly exists!: RuntimeDelegates["exists"];
  readonly manifest!: RuntimeDelegates["manifest"];
  readonly operationId!: RuntimeDelegates["operationId"];
  readonly restore!: RuntimeDelegates["restore"];
  readonly restoreControl!: RuntimeDelegates["restoreControl"];
  readonly prepareCancellation!: RuntimeDelegates["prepareCancellation"];
  readonly resolveApproval!: RuntimeDelegates["resolveApproval"];
  readonly cancelOperation!: RuntimeDelegates["cancelOperation"];
  readonly operationCancelled!: RuntimeDelegates["operationCancelled"];
  readonly retain!: RuntimeDelegates["retain"];
  readonly persist!: RuntimeDelegates["persist"];
  readonly persistPrepared!: RuntimeDelegates["persistPrepared"];
  readonly ids!: RuntimeDelegates["ids"];
  private readonly live = new Map<string, LiveConversation>();
  private readonly terminalRuns = new Map<string, Promise<TerminalLifecycle>>();
  private readonly notifier = new ConversationAppendNotifier();
  constructor(private readonly options: ConversationRuntimeOptions) {
    this.id = options.id ?? (() => randomUUID());
    const authorities = createConversationRuntimeAuthorities(options, {
      id: (kind) => this.id(kind),
      current: (id) => this.live.get(id),
      notify: (event) => this.notifier.notify(event),
      correlation: (manifest, operationId, attemptId) =>
        this.correlation(manifest, operationId, attemptId),
      manifest: (id) => this.manifest(id),
      begin: (...args) => this.begin(...args),
    });
    this.operations = authorities.operations;
    this.effects = authorities.effects;
    this.artifacts = authorities.artifacts;
    this.restarts = authorities.restarts;
    this.attempts = authorities.attempts;
    this.controls = authorities.controls;
    this.emissions = authorities.emissions;
    this.controlState = authorities.restarts.controlState.bind(authorities.restarts);
    const readers = createConversationRuntimeReaders(options);
    this.events = readers.events;
    this.operationOwnerState = authorities.operations.ownerState.bind(authorities.operations);
    this.rehydrate = readers.rehydrate;
    this.snapshot = readers.snapshot;
    Object.assign(
      this,
      createConversationRuntimeDelegates({
        options,
        authorities,
        operationId: (id) => this.live.get(id)?.operationId ?? null,
        id: (kind) => this.id(kind),
      }),
    );
  }
  onAppend(listener: (event: PublicStoredTraceEvent) => void): () => void {
    return this.notifier.subscribe(listener);
  }
  private correlation(
    manifest: ConversationManifest,
    operationId: string,
    attemptId = "coordinator",
  ): TraceCorrelation {
    return runtimeCorrelation(manifest, operationId, attemptId, this.id);
  }
  private policyContext(live: LiveConversation): ConversationContext {
    const operation = this.operations.get(live.manifest.conversation_id, live.operationId);
    if (!operation) throw new Error("operation authority missing");
    const correlation = this.correlation(live.manifest, live.operationId);
    return createRuntimePolicyContext({
      options: this.options,
      live,
      signal: operation.signal,
      correlation,
      writePolicy: (emission) => this.effects.writePolicy(correlation, emission),
      launchAttempt: (request, refs) => this.attempts.launch(live, operation, request, refs),
      createArtifact: (request) =>
        this.artifacts.create(live.manifest.conversation_id, correlation, request),
      updateArtifact: (request) =>
        this.artifacts.update(live.manifest.conversation_id, correlation, request),
    });
  }
  previewContext(
    manifest: ConversationManifest,
    bindings: readonly (MaterializedAgentBinding | PreviewAgentBinding)[],
  ): ConversationContext {
    return previewBindingPolicyContext(manifest, bindings, this.correlation(manifest, "dry-run"));
  }
  begin(
    manifest: ConversationManifest,
    bindings: MaterializedAgentBinding[],
    resumes: readonly PersistedResumeBinding[] = [],
    paused = false,
    transitionEpoch = 0,
    operationId = this.id("operation"),
    allowCancelReservation = false,
    sharedHandoff: string | null = null,
  ): string {
    if (this.live.has(manifest.conversation_id))
      throw new Error("conversation runtime already live");
    this.options.artifactStore.recordOperation(manifest.conversation_id, operationId);
    const operation = this.operations.create(
      manifest.conversation_id,
      operationId,
      allowCancelReservation,
    );
    this.emissions.open(manifest.conversation_id, operation.operationId, paused);
    this.operations.prepareJoinedCancellation(manifest.conversation_id, operation.operationId);
    this.live.set(
      manifest.conversation_id,
      createRuntimeLiveConversation({
        artifactStore: this.options.artifactStore,
        manifest,
        bindings,
        resumes,
        operationId: operation.operationId,
        sharedHandoff,
        transitionEpoch,
      }),
    );
    return operation.operationId;
  }
  context(id: string): Promise<ConversationContext> {
    const live = this.live.get(id);
    if (!live) throw new Error("conversation runtime is not live");
    return Promise.resolve(this.policyContext(live));
  }
  startRevisionBarrier(
    id: string,
    plan: RevisionPreparationPlanV1,
    authorityOperationId?: string,
  ): Promise<boolean> {
    const live = this.live.get(id);
    if (!live) throw new Error("revision start conversation is not live");
    const operation = this.operations.get(id, live.operationId);
    if (!operation) throw new Error("revision start operation authority is absent");
    return this.attempts.startRevisionBarrier(
      live,
      operation,
      plan,
      authorityOperationId ?? operation.operationId,
    );
  }
  finish(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    if (!this.emissions.finish(id, live.operationId)) return;
    if (this.live.get(id) === live) this.live.delete(id);
  }
  async abandon(id: string, reason: string): Promise<void> {
    const live = this.live.get(id);
    if (!live || !this.emissions.abandon(id, live.operationId)) return;
    await this.operations.release(id, live.operationId, reason);
    if (this.live.get(id) === live) this.live.delete(id);
  }
  async configure(id: string, activate = true, prepared = false): Promise<void> {
    const live = this.live.get(id);
    if (!live) throw new Error("conversation runtime is not live");
    const record = activate ? null : this.options.artifactStore.readRecord(id);
    if (!activate && !record) throw new Error("conversation not found");
    const records = activate
      ? []
      : await (this.options.traceStore.recoverConversation?.(id) ??
          this.options.traceStore.readConversation(id));
    const emissions = activate
      ? configurationEmissions(live.manifest, live.bindings)
      : [
          {
            emission: configurationEnvelope(
              record as NonNullable<typeof record>,
              records,
              this.options.artifactRegistry,
            ),
          },
        ];
    for (const item of emissions) {
      await this.effects.writePolicy(
        prepared
          ? preparedStartCorrelation(live.manifest, live.operationId, item)
          : { ...this.correlation(live.manifest, live.operationId, "control"), ...item.patch },
        item.emission,
      );
    }
  }
  async transition(
    id: string,
    lifecycle: ConversationTransitionLifecycleV1,
    health: ConversationHealth,
  ): Promise<void> {
    const live = this.live.get(id);
    if (!live) throw new Error("conversation runtime is not live");
    const epoch = live.transitionEpoch + 1;
    const operation = this.operations.get(id, live.operationId);
    if (!operation) throw new Error("operation authority missing");
    try {
      await this.operations.transition(id, live.operationId, lifecycle, epoch, async () => {
        if (lifecycle === CONVERSATION_TRANSITION_LIFECYCLE.ACTIVE && live.needsReconcile) {
          await this.attempts.reconcile(live, operation);
        }
        await this.controls.transition(id, lifecycle, health, epoch);
      });
    } catch (error) {
      if (!(error instanceof OperationTransitionReservedError)) {
        const durable = await this.restarts.controlState(id).catch(() => null);
        if (
          durable?.lifecycle === CONVERSATION_TRANSITION_LIFECYCLE.ACTIVE ||
          durable?.lifecycle === CONVERSATION_TRANSITION_LIFECYCLE.PAUSED
        ) {
          this.operations.adoptTransition(
            id,
            live.operationId,
            durable.lifecycle,
            durable.transitionEpoch,
          );
        }
      }
      throw error;
    }
    if (lifecycle === CONVERSATION_TRANSITION_LIFECYCLE.ACTIVE) live.needsReconcile = false;
  }
  async health(id: string, health: ConversationHealth): Promise<void> {
    const live = this.live.get(id);
    if (!live) throw new Error("conversation runtime is not live");
    const state = await this.restarts.controlState(id);
    if (
      !state ||
      (state.lifecycle !== CONVERSATION_TRANSITION_LIFECYCLE.ACTIVE &&
        state.lifecycle !== CONVERSATION_TRANSITION_LIFECYCLE.PAUSED)
    ) {
      throw new Error("conversation health authority missing");
    }
    const lifecycle = state.lifecycle;
    const epoch = Math.max(live.transitionEpoch, state.transitionEpoch) + 1;
    try {
      await this.operations.mutateState(id, live.operationId, epoch, () =>
        this.emissions
          .control(id, live.operationId, true, () =>
            this.controls.health(id, lifecycle, health, epoch),
          )
          .then(() => undefined),
      );
    } catch (error) {
      if (!(error instanceof OperationTransitionReservedError)) {
        const durable = await this.restarts.controlState(id).catch(() => null);
        if (durable) this.operations.adoptEpoch(id, live.operationId, durable.transitionEpoch);
      }
      throw error;
    }
  }
  // biome-ignore format: production file ceiling
  terminal(id: string, lifecycle: TerminalLifecycle, health: ConversationHealth, reason: string | null, finalScore: number | null, operationReason = "conversation terminal"): Promise<TerminalLifecycle> {
    const existing = this.terminalRuns.get(id);
    if (existing) return existing;
    const running = this.runTerminal(id, lifecycle, health, reason, finalScore, operationReason);
    this.terminalRuns.set(id, running);
    const clear = () => { if (this.terminalRuns.get(id) === running) this.terminalRuns.delete(id); };
    void running.then(clear, clear);
    return running;
  }
  private async runTerminal(
    id: string,
    lifecycle: TerminalLifecycle,
    health: ConversationHealth,
    reason: string | null,
    finalScore: number | null,
    operationReason = "conversation terminal",
  ): Promise<TerminalLifecycle> {
    const live = this.live.get(id);
    if (!live) throw new Error("conversation runtime is not live");
    let effective = lifecycle;
    const append = async (reserved: TerminalLifecycle) => {
      effective = reserved;
      const operation = this.operations.get(id, live.operationId);
      await operation?.drainEffects();
      await this.effects.drain(id);
      await this.controls.terminal(
        id,
        reserved,
        health,
        reserved === lifecycle ? reason : "completion superseded by pause",
        reserved === CONVERSATION_TERMINAL_LIFECYCLE.COMPLETED ? finalScore : null,
      );
    };
    try {
      effective = await this.emissions.terminal(id, live.operationId, lifecycle, append);
    } catch (error) {
      const records = await (this.options.traceStore.recoverConversation?.(id) ??
        this.options.traceStore.readConversation(id));
      const { hasState, winner } = terminalJournalState(records);
      if (winner) {
        this.emissions.releaseFailedTerminal(id, live.operationId, effective);
        effective = this.emissions.adoptTerminal(id, live.operationId, winner);
      } else if (
        error instanceof TraceLifecycleConflictError &&
        ((isConversationGracefulTerminalLifecycle(lifecycle) &&
          error.durableLifecycle === CONVERSATION_TRANSITION_LIFECYCLE.PAUSED) ||
          (lifecycle !== CONVERSATION_TERMINAL_LIFECYCLE.ABORTED &&
            error.durableLifecycle === CONVERSATION_TERMINAL_LIFECYCLE.ABORTED))
      ) {
        this.emissions.releaseFailedTerminal(id, live.operationId, effective);
        effective = await this.emissions.terminal(
          id,
          live.operationId,
          CONVERSATION_TERMINAL_LIFECYCLE.ABORTED,
          append,
        );
      } else if (hasState) {
        this.emissions.releaseFailedTerminal(id, live.operationId, effective);
        effective = await this.emissions.terminal(id, live.operationId, lifecycle, append);
      } else {
        this.emissions.releaseFailedTerminal(id, live.operationId, effective);
        throw error;
      }
    }
    await this.operations.settleAndTerminate(id, live.operationId, operationReason, effective);
    return effective;
  }
  async userMessage(
    id: string,
    request: MessageRequest,
    key: string,
    queueDelivery?: ConversationQueuedMessageDeliveryAuthorityV1,
  ): Promise<void> {
    const live = this.live.get(id);
    return publishRuntimeUserMessage({
      options: this.options,
      live,
      conversationId: id,
      request,
      messageKey: key,
      ...(queueDelivery ? { queueDelivery } : {}),
      append: () => this.controls.userMessage(id, request, key, queueDelivery?.publicEventId),
    });
  }
}
