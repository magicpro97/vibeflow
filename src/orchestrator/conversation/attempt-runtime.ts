import { randomBytes } from "node:crypto";
import {
  type EngineChunk,
  type OperationLifecycleState,
  createSpawnOptionsProjection,
} from "../../dispatch/session-types.js";
import type { PolicyEmission, TraceCorrelation } from "../trace/types.js";
import type { AttemptConversationAuthority } from "./attempt-runtime-types.js";
export type { AttemptConversationAuthority } from "./attempt-runtime-types.js";
import { reconcileAttemptHistory } from "./attempt-history-reconciliation.js";
import { publishAttemptResumeBinding } from "./attempt-resume-publication.js";
import type { AttemptRuntimeOptions } from "./attempt-runtime-options.js";
import { prepareInitialRevisionLane, startAndAdmitAttempt } from "./attempt-start-admission.js";
import { renderAttemptPrompt, resolveAttemptTurnPrompt } from "./attempt-turn-delivery.js";
import { publishAttemptTurnDelivery } from "./attempt-turn-publication.js";
import { assertAttemptEmission, snapshotRuntimeValue } from "./emission-authority.js";
import type { RevisionPreparationPlanV1 } from "./lineage-revision-operation.js";
import type { RegisteredOperation } from "./operation-registry.js";
import { startInitialRevisionLaneBarrier } from "./revision-initial-lane-runtime.js";
import type { AttemptEmission, AttemptRef, PolicyAttempt, PolicyAttemptRequest } from "./types.js";

const MAX_CHUNKS = 4096;
const MAX_CHUNK_BYTES = 1024 * 1024;
export class AttemptRuntime {
  private readonly reconciliations = new WeakMap<
    AttemptConversationAuthority,
    Map<string, string | null>
  >();
  constructor(private readonly options: AttemptRuntimeOptions) {}
  startRevisionBarrier(
    live: AttemptConversationAuthority,
    operation: RegisteredOperation,
    plan: RevisionPreparationPlanV1,
    authorityOperationId: string,
  ): Promise<boolean> {
    if (!this.options.revisionLanes) throw new Error("revision lane authority is absent");
    return startInitialRevisionLaneBarrier({
      options: this.options,
      authority: this.options.revisionLanes,
      live,
      operation,
      plan,
      authorityOperationId,
    });
  }
  launch(
    live: AttemptConversationAuthority,
    operation: RegisteredOperation,
    request: PolicyAttemptRequest,
    refs: Map<AttemptRef, string>,
  ): PolicyAttempt {
    if (
      !operation.isLive() ||
      !this.options.isRetained(live.manifest.conversation_id, live.operationId)
    ) {
      throw new Error("conversation emission authority is closed");
    }
    if (this.options.isOpen(live.manifest.conversation_id, live.operationId)) {
      return this.launchNow(live, operation, request, refs);
    }
    const ref = randomBytes(32).toString("base64url") as AttemptRef;
    let inner: PolicyAttempt | undefined;
    let listener: ((chunk: Readonly<EngineChunk>) => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const ready = this.options
      .awaitOpen(live.manifest.conversation_id, live.operationId)
      .then(() => {
        if (!operation.isLive()) throw new Error("operation is not live");
        inner = this.launchNow(live, operation, request, refs, ref);
        if (listener) unsubscribe = inner.onChunk(listener);
        return inner;
      });
    const completion = ready.then((attempt) => attempt.completion);
    void completion.catch(() => undefined);
    return Object.freeze({
      ref,
      completion,
      emit: (emission: AttemptEmission) => {
        const captured = snapshotRuntimeValue(emission);
        return ready.then((attempt) => attempt.emit(captured));
      },
      onChunk: (next: (chunk: Readonly<EngineChunk>) => void) => {
        if (listener) throw new Error("attempt chunk stream already consumed");
        listener = next;
        return () => {
          listener = undefined;
          unsubscribe?.();
        };
      },
    });
  }
  private launchNow(
    live: AttemptConversationAuthority,
    operation: RegisteredOperation,
    request: PolicyAttemptRequest,
    refs: Map<AttemptRef, string>,
    reservedRef?: AttemptRef,
  ): PolicyAttempt {
    if (
      !this.options.isOpen(live.manifest.conversation_id, live.operationId) ||
      !operation.isLive()
    ) {
      throw new Error("conversation emission authority is closed");
    }
    const materialized = live.bindings[request.bindingIndex];
    const manifestBinding = live.manifest.bindings[request.bindingIndex];
    if (!materialized || manifestBinding?.participant_id !== request.participantId) {
      throw new Error("attempt participant/binding mismatch");
    }
    const parentId = request.parent ? refs.get(request.parent) : undefined;
    if (request.parent && !parentId) throw new Error("attempt parent lacks runtime authority");
    let attemptId = this.options.id("attempt");
    const ref = reservedRef ?? (randomBytes(32).toString("base64url") as AttemptRef);
    const resolved = materialized.resolved;
    const roleName = resolved.role.spec.name;
    if (request.purpose === "evaluator" && roleName !== "brainstorm-evaluator") {
      throw new Error("evaluator attempt requires evaluator role");
    }
    if (request.purpose !== "evaluator" && roleName === "brainstorm-evaluator") {
      throw new Error("non-evaluator attempt cannot use evaluator role");
    }
    const revisionLane = prepareInitialRevisionLane(
      this.options.revisionLanes,
      live,
      request,
      materialized,
    );
    if (revisionLane) attemptId = revisionLane.attempt_key;
    const isolatedHistory = request.purpose === "baseline" || request.purpose === "evaluator";
    const resumeOrdinal = ++live.resumeCounter.value;
    const resume = isolatedHistory ? undefined : live.resumeBindings.get(request.participantId);
    if (resume && resume.engine !== resolved.engine) throw new Error("resume engine mismatch");
    if (!isolatedHistory && materialized.spawn.sessionMode === "exact" && !resume) {
      throw new Error("exact session requires persisted resume authority");
    }
    const deliveredPrompt = resolveAttemptTurnPrompt({
      request,
      resume,
      sharedHandoff: live.sharedHandoff,
      isolatedHistory,
    });
    const prompt = renderAttemptPrompt(
      materialized.spawn.rendered_prompt,
      live.manifest.task_text,
      deliveredPrompt,
      {
        purpose: request.purpose,
        proposeAction:
          request.purpose !== "baseline" &&
          request.purpose !== "evaluator" &&
          manifestBinding.input.roleRef !== "brainstorm-evaluator" &&
          manifestBinding.host_tools?.includes("propose_action") === true,
      },
    );
    const spawn = createSpawnOptionsProjection({
      ...materialized.spawn,
      sessionMode: isolatedHistory ? "fresh" : resume ? "exact" : materialized.spawn.sessionMode,
      rendered_prompt: prompt,
    });
    const base: TraceCorrelation = {
      ...this.options.correlation(live.manifest, live.operationId, attemptId),
      participant_id: request.participantId,
      role_ref: resolved.role.spec.name,
      role_resolved_hash: resolved.role.resolved_hash,
      skill_refs: resolved.skills.map((skill) => skill.ref),
      skill_resolved_hashes: resolved.skills.map((skill) => skill.resolved_hash),
      engine: resolved.engine,
      ...((parentId ?? resume?.attemptId)
        ? { parent_attempt_id: parentId ?? resume?.attemptId }
        : {}),
    };
    let chain: Promise<unknown> = Promise.resolve();
    let evidenceRef: string | undefined;
    let nativeId: string | null = resume?.nativeSessionId ?? null;
    let chunkBytes = 0;
    let chunkError: Error | undefined;
    let listener: ((chunk: Readonly<EngineChunk>) => void) | undefined;
    let consumerClaimed = false;
    let delivered = 0;
    let callbackFlush: Promise<void> | undefined;
    const chunks: Readonly<EngineChunk>[] = [];
    const callbackQueue: Array<
      { kind: "chunk"; index: number } | { kind: "lifecycle"; state: OperationLifecycleState }
    > = [];
    const correlated = (): TraceCorrelation =>
      Object.freeze({ ...base, ...(evidenceRef ? { evidence_refs: [evidenceRef] } : {}) });
    const append = (emission: AttemptEmission, native = nativeId) => {
      const captured = snapshotRuntimeValue(emission);
      assertAttemptEmission(captured, request.participantId, request.purpose);
      const admitted = this.options.isOpen(live.manifest.conversation_id, live.operationId);
      const next = chain.then(() =>
        admitted
          ? this.options.appendRuntime(correlated(), captured, native)
          : this.options.append(correlated(), captured, native),
      );
      chain = next;
      if (admitted) operation.trackEffect(next);
      return next;
    };
    const deliverChunks = (lastIndex = chunks.length - 1) => {
      if (!listener || !this.options.isOpen(live.manifest.conversation_id, live.operationId))
        return;
      while (delivered <= lastIndex) {
        const consumer = listener;
        if (!consumer) break;
        consumer(chunks[delivered++] as Readonly<EngineChunk>);
      }
    };
    const appendLifecycle = (state: OperationLifecycleState, admitted: boolean) => {
      const next = chain.then(async () => {
        await (admitted ? this.options.appendRuntime : this.options.appendLifecycle)(
          correlated(),
          {
            idempotency_key: `attempt:${attemptId}:lifecycle:${state}`,
            event: {
              type: "operation_lifecycle",
              payload: { operation_id: live.operationId, attempt_id: attemptId, state },
            },
          },
          nativeId,
        );
      });
      chain = next;
      if (admitted) operation.trackEffect(next);
      return next;
    };
    const scheduleCallbacks = () => {
      if (callbackFlush) return;
      const flush = this.options
        .awaitOpen(live.manifest.conversation_id, live.operationId)
        .then(() => {
          if (!this.options.isOpen(live.manifest.conversation_id, live.operationId)) return;
          const work = (async () => {
            while (callbackQueue.length) {
              if (!this.options.isRetained(live.manifest.conversation_id, live.operationId)) {
                callbackQueue.length = 0;
                break;
              }
              const callback = callbackQueue.shift();
              if (!callback) break;
              if (callback.kind === "lifecycle") await appendLifecycle(callback.state, true);
              else {
                try {
                  deliverChunks(callback.index);
                } catch (error) {
                  chunkError = error instanceof Error ? error : new Error("chunk listener failed");
                }
                await Promise.resolve();
                await chain;
              }
            }
          })();
          operation.trackEffect(work);
          return work;
        });
      callbackFlush = flush;
      const settled = () => {
        if (callbackFlush !== flush) return;
        callbackFlush = undefined;
        if (!this.options.isRetained(live.manifest.conversation_id, live.operationId)) {
          callbackQueue.length = 0;
        } else if (callbackQueue.length) scheduleCallbacks();
      };
      void flush.then(settled, settled);
    };
    const enqueueCallback = (callback: (typeof callbackQueue)[number]) => {
      if (callbackQueue.length >= MAX_CHUNKS) {
        chunkError = new Error("attempt callback stream exceeds runtime cap");
        return;
      }
      callbackQueue.push(callback);
      scheduleCallbacks();
    };
    const receiveChunk = (chunk: EngineChunk) => {
      if (!this.options.isRetained(live.manifest.conversation_id, live.operationId)) return;
      if (chunkError) return;
      chunkBytes += Buffer.byteLength(chunk.content, "utf8");
      if (chunks.length >= MAX_CHUNKS || chunkBytes > MAX_CHUNK_BYTES) {
        chunkError = new Error("attempt chunk stream exceeds runtime cap");
        return;
      }
      const snapshot = Object.freeze({ stream: chunk.stream, content: chunk.content });
      chunks.push(snapshot);
      enqueueCallback({ kind: "chunk", index: chunks.length - 1 });
    };
    const handle = startAndAdmitAttempt({
      adapter: this.options.sessionAdapter,
      operation,
      revisionLane,
      revisionLanes: this.options.revisionLanes,
      request: {
        attemptId,
        spawn,
        ...(resume ? { nativeSessionId: resume.nativeSessionId } : {}),
        signal: operation.signal,
        onChunk: receiveChunk,
        onLifecycle: (state) => {
          if (!this.options.isRetained(live.manifest.conversation_id, live.operationId)) return;
          enqueueCallback({ kind: "lifecycle", state });
        },
      },
    });
    refs.set(ref, attemptId);
    let revisionSettled = revisionLane === null || revisionLane === undefined;
    const completion = (async () => {
      try {
        const result = await handle.completion;
        const captured = handle.readResumeBinding();
        nativeId = captured?.nativeSessionId ?? nativeId;
        evidenceRef = handle.readEvidenceBinding()?.internalRef;
        if (revisionLane) {
          this.options.revisionLanes?.observe(revisionLane, handle, result, {
            artifacts: this.options.artifactStore,
            live,
            startAuthority: this.options.sessionAdapter.startAuthority,
          });
          revisionSettled = true;
        }
        while (callbackFlush || callbackQueue.length) {
          scheduleCallbacks();
          await callbackFlush;
        }
        await chain;
        if (chunkError) throw chunkError;
        if (!revisionLane)
          publishAttemptTurnDelivery({
            live,
            operation,
            store: this.options.artifactStore,
            participantId: request.participantId,
            attemptId,
            delivery: request.delivery?.receipt,
            capturedResume: captured !== undefined,
            retained: this.options.isRetained(live.manifest.conversation_id, live.operationId),
          });
        if (!revisionLane)
          publishAttemptResumeBinding({
            live,
            operation,
            store: this.options.artifactStore,
            participantId: request.participantId,
            attemptId,
            resumeOrdinal,
            captured,
            isolatedHistory,
            retained: this.options.isRetained(live.manifest.conversation_id, live.operationId),
            ...(request.delivery ? { delivery: request.delivery.receipt } : {}),
          });
        return result;
      } finally {
        if (revisionLane && !revisionSettled)
          this.options.revisionLanes?.effectUnknown(
            revisionLane,
            handle,
            this.options.sessionAdapter.startAuthority,
          );
        operation.removeAttempt(handle);
      }
    })();
    return Object.freeze({
      ref,
      completion,
      emit: append,
      onChunk: (next: (chunk: Readonly<EngineChunk>) => void) => {
        if (!this.options.isRetained(live.manifest.conversation_id, live.operationId)) {
          throw new Error("conversation emission authority is closed");
        }
        if (consumerClaimed) throw new Error("attempt chunk stream already consumed");
        consumerClaimed = true;
        listener = next;
        if (!callbackFlush && callbackQueue.length === 0) deliverChunks();
        else scheduleCallbacks();
        return () => {
          if (listener === next) listener = undefined;
        };
      },
    });
  }

  async reconcile(
    live: AttemptConversationAuthority,
    operation: RegisteredOperation,
  ): Promise<void> {
    const reconciliations = this.reconciliations.get(live) ?? new Map<string, string | null>();
    this.reconciliations.set(live, reconciliations);
    await reconcileAttemptHistory({ options: this.options, live, operation, reconciliations });
  }
}
