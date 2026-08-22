import { randomUUID } from "node:crypto";
import type { MaterializedAgentBinding, PreviewAgentBinding } from "../../agents/binding.js";
import type { EngineSessionAdapter } from "../../dispatch/session-types.js";
import type { ArtifactRegistry } from "../trace/artifacts.js";
import { TraceLifecycleConflictError, type TraceStore } from "../trace/store.js";
import type { PublicStoredTraceEvent, TraceCorrelation } from "../trace/types.js";
import type { ConversationArtifactStore, PersistedResumeBinding } from "./artifact-store.js";
import type { InternalApprovalResolution } from "./control-runtime.js";
import {
  assertCoordinatorEmission,
  policyContextView,
  previewBindingPolicyContext,
  snapshotMaterializedBindings,
  snapshotRuntimeValue,
} from "./emission-authority.js";
import { foldConversation } from "./fold.js";
import type { LiveConversation } from "./lifecycle-gate.js";
import { OperationTransitionReservedError } from "./operation-registry.js";
// biome-ignore format: production file ceiling
import {
  type ConversationPolicyRegistry, type RuntimeCreateRequest, type RuntimePreviewRequest, bindingAuthorities, configurationEmissions, conversationMessages, projectConversationEvents, rehydrateConversation, terminalJournalState,
} from "./policy-registry.js";
import { configurationEnvelope } from "./restart-authority.js";
import { ConversationRestoreOperationMismatchError } from "./restart-runtime.js";
import {
  type ConversationRuntimeAuthorities,
  createConversationRuntimeAuthorities,
} from "./runtime-authorities.js";
// biome-ignore format: production file ceiling
import type {
  ApprovalDecision, ArtifactCreateRequest, ArtifactUpdateRequest, AttemptRef, ConversationBinding, ConversationContext, ConversationCreateRequest, ConversationHealth, ConversationManifest, ConversationSnapshot, CoordinatorEmission, MessageRequest, OperationCancelCommand, OperationCancelResult, PolicyAttemptRequest, TerminalLifecycle,
} from "./types.js";
export interface ConversationRuntimeOptions {
  traceStore: TraceStore;
  artifactRegistry: ArtifactRegistry;
  artifactStore: ConversationArtifactStore;
  sessionAdapter: EngineSessionAdapter;
  policies: ConversationPolicyRegistry;
  id?: (kind: string) => string;
  now?: () => string;
  schedule?(task: () => void): void;
  resolveCreateRequest?(request: ConversationCreateRequest): Promise<RuntimeCreateRequest>;
  resolveDryRunRequest?(request: ConversationCreateRequest): Promise<RuntimePreviewRequest>;
  rehydrateBinding(
    binding: ConversationBinding,
    manifest: ConversationManifest,
  ): Promise<MaterializedAgentBinding>;
}
export { ConversationRestoreOperationMismatchError };
export class ConversationRuntime {
  private readonly id: (kind: string) => string;
  private readonly operations: ConversationRuntimeAuthorities["operations"];
  private readonly effects: ConversationRuntimeAuthorities["effects"];
  private readonly artifacts: ConversationRuntimeAuthorities["artifacts"];
  private readonly restarts: ConversationRuntimeAuthorities["restarts"];
  private readonly attempts: ConversationRuntimeAuthorities["attempts"];
  private readonly controls: ConversationRuntimeAuthorities["controls"];
  private readonly emissions: ConversationRuntimeAuthorities["emissions"];
  private readonly live = new Map<string, LiveConversation>();
  private readonly terminalRuns = new Map<string, Promise<TerminalLifecycle>>();
  private readonly listeners = new Set<(event: PublicStoredTraceEvent) => void>();
  constructor(private readonly options: ConversationRuntimeOptions) {
    this.id = options.id ?? (() => randomUUID());
    const authorities = createConversationRuntimeAuthorities(options, {
      id: (kind) => this.id(kind),
      current: (id) => this.live.get(id),
      notify: (event) => this.notify(event),
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
  }
  onAppend(listener: (event: PublicStoredTraceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  // biome-ignore format: production file ceiling
  private notify(event: PublicStoredTraceEvent): void {
    for (const listener of [...this.listeners]) { try { listener(event); } catch (error) { void error; } }
  }
  private correlation(
    manifest: ConversationManifest,
    operationId: string,
    attemptId = "coordinator",
  ): TraceCorrelation {
    return Object.freeze({
      workflow_id: manifest.workflow_id,
      conversation_id: manifest.conversation_id,
      revision_id: manifest.revision_id,
      run_id: manifest.run_id,
      turn_id: this.id("turn"),
      operation_id: operationId,
      attempt_id: attemptId,
    });
  }
  private policyContext(live: LiveConversation): ConversationContext {
    const operation = this.operations.get(live.manifest.conversation_id, live.operationId);
    if (!operation) throw new Error("operation authority missing");
    const correlation = this.correlation(live.manifest, live.operationId);
    const refs = new Map<AttemptRef, string>();
    return Object.freeze({
      correlation,
      ...policyContextView(live.manifest, live.bindings),
      signal: operation.signal,
      // biome-ignore format: production file ceiling
      messages: () => this.options.traceStore.readConversation(live.manifest.conversation_id).then(conversationMessages),
      emit: (emission: CoordinatorEmission) => {
        const captured = snapshotRuntimeValue(emission);
        assertCoordinatorEmission(captured, live.operationId);
        return this.effects.writePolicy(correlation, captured);
      },
      launchAttempt: (request: PolicyAttemptRequest) =>
        this.attempts.launch(live, operation, snapshotRuntimeValue(request), refs),
      createArtifact: (request: ArtifactCreateRequest) =>
        this.artifacts.create(live.manifest.conversation_id, correlation, request),
      updateArtifact: (request: ArtifactUpdateRequest) =>
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
  ): string {
    if (this.live.has(manifest.conversation_id))
      throw new Error("conversation runtime already live");
    const capturedBindings = snapshotMaterializedBindings(bindings);
    this.options.artifactStore.recordOperation(manifest.conversation_id, operationId);
    const operation = this.operations.create(
      manifest.conversation_id,
      operationId,
      allowCancelReservation,
    );
    this.emissions.open(manifest.conversation_id, operation.operationId, paused);
    this.operations.prepareJoinedCancellation(manifest.conversation_id, operation.operationId);
    this.live.set(manifest.conversation_id, {
      manifest,
      bindings: capturedBindings,
      operationId: operation.operationId,
      resumeBindings: new Map(resumes.map((resume) => [resume.participant_id, resume])),
      resumeOrdinals: new Map(),
      resumeCounter: { value: 0 },
      transitionEpoch,
      needsReconcile: false,
    });
    return operation.operationId;
  }
  context(id: string): Promise<ConversationContext> {
    const live = this.live.get(id);
    if (!live) throw new Error("conversation runtime is not live");
    return Promise.resolve(this.policyContext(live));
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
  async configure(id: string, activate = true): Promise<void> {
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
        { ...this.correlation(live.manifest, live.operationId, "control"), ...item.patch },
        item.emission,
      );
    }
  }
  async transition(
    id: string,
    lifecycle: "ACTIVE" | "PAUSED",
    health: ConversationHealth,
  ): Promise<void> {
    const live = this.live.get(id);
    if (!live) throw new Error("conversation runtime is not live");
    const epoch = live.transitionEpoch + 1;
    const operation = this.operations.get(id, live.operationId);
    if (!operation) throw new Error("operation authority missing");
    try {
      await this.operations.transition(id, live.operationId, lifecycle, epoch, async () => {
        if (lifecycle === "ACTIVE" && live.needsReconcile) {
          await this.attempts.reconcile(live, operation);
        }
        await this.controls.transition(id, lifecycle, health, epoch);
      });
    } catch (error) {
      if (!(error instanceof OperationTransitionReservedError)) {
        const durable = await this.restarts.controlState(id).catch(() => null);
        if (durable?.lifecycle === "ACTIVE" || durable?.lifecycle === "PAUSED") {
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
    if (lifecycle === "ACTIVE") live.needsReconcile = false;
  }
  async health(id: string, health: ConversationHealth): Promise<void> {
    const live = this.live.get(id);
    if (!live) throw new Error("conversation runtime is not live");
    const state = await this.restarts.controlState(id);
    if (!state || (state.lifecycle !== "ACTIVE" && state.lifecycle !== "PAUSED")) {
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
        reserved === "COMPLETED" ? finalScore : null,
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
        ((lifecycle === "COMPLETED" && error.durableLifecycle === "PAUSED") ||
          (lifecycle !== "ABORTED" && error.durableLifecycle === "ABORTED"))
      ) {
        this.emissions.releaseFailedTerminal(id, live.operationId, effective);
        effective = await this.emissions.terminal(id, live.operationId, "ABORTED", append);
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
  async userMessage(id: string, request: MessageRequest, key: string): Promise<void> {
    await this.controls.userMessage(id, request, key);
  }
  exists(id: string): boolean {
    return this.options.artifactStore.has(id);
  }
  manifest(id: string): ConversationManifest | null {
    return this.options.artifactStore.read(id);
  }
  operationId(id: string): string | null {
    return this.live.get(id)?.operationId ?? null;
  }
  async events(id: string, afterSeq: number): Promise<PublicStoredTraceEvent[] | null> {
    if (!this.exists(id)) return null;
    const records = this.options.traceStore.recoverConversation
      ? await this.options.traceStore.recoverConversation(id)
      : await this.options.traceStore.readConversation(id);
    return projectConversationEvents(records, id, this.options.artifactRegistry, afterSeq);
  }
  async snapshot(id: string): Promise<ConversationSnapshot | null> {
    const events = await this.events(id, 0);
    return events?.length ? foldConversation(events) : null;
  }
  async controlState(
    id: string,
  ): Promise<Pick<ConversationSnapshot, "lifecycle" | "health"> | null> {
    return this.restarts.controlState(id);
  }
  // biome-ignore format: production file ceiling
  async rehydrate(id: string) { return rehydrateConversation(id, this.options.artifactStore, this.options.rehydrateBinding); }
  async restore(id: string, requestedOperationId?: string): Promise<string> {
    return this.restarts.restore(id, requestedOperationId);
  }
  restoreControl(id: string, requestedOperationId?: string): Promise<string> {
    return this.restarts.restore(id, requestedOperationId, true);
  }
  prepareCancellation(command: OperationCancelCommand) {
    return this.restarts.prepareCancellation(command);
  }
  resolveApproval(
    id: string,
    decision: ApprovalDecision,
    allowFresh: boolean,
  ): Promise<InternalApprovalResolution> {
    return this.controls.resolveApproval(id, decision, allowFresh);
  }
  async cancelOperation(command: OperationCancelCommand): Promise<OperationCancelResult> {
    return this.controls.cancel(command);
  }
  operationCancelled(id: string, operationId: string): boolean {
    return this.operations.isCancelled(id, operationId);
  }
  retain(id: string, operationId: string): Promise<boolean> {
    return this.emissions.retain(id, operationId, () => this.operationCancelled(id, operationId));
  }
  persist(manifest: ConversationManifest, bindings: MaterializedAgentBinding[]): void {
    this.options.artifactStore.create(manifest, bindingAuthorities(manifest, bindings));
  }
  childRevision(id: string, key: string): string | undefined {
    return this.options.artifactStore.readRecord(id)?.child_revisions[key];
  }
  ids(kind: string): string {
    return this.id(kind);
  }
}
