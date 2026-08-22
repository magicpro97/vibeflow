import { randomBytes } from "node:crypto";
import {
  type EngineChunk,
  type EngineSessionAdapter,
  type OperationLifecycleState,
  createSpawnOptionsProjection,
} from "../../dispatch/session-types.js";
import type { PolicyEmission, StoredTraceEvent, TraceCorrelation } from "../trace/types.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import type { AttemptConversationAuthority } from "./attempt-runtime-types.js";
export type { AttemptConversationAuthority } from "./attempt-runtime-types.js";
import { assertAttemptEmission, snapshotRuntimeValue } from "./emission-authority.js";
import type { RegisteredOperation } from "./operation-registry.js";
import type {
  AttemptEmission,
  AttemptRef,
  ConversationManifest,
  PolicyAttempt,
  PolicyAttemptRequest,
} from "./types.js";

const MAX_CHUNKS = 4096;
const MAX_CHUNK_BYTES = 1024 * 1024;
interface AttemptRuntimeOptions {
  id(kind: string): string;
  sessionAdapter: EngineSessionAdapter;
  artifactStore: ConversationArtifactStore;
  correlation(manifest: ConversationManifest, operationId: string, id: string): TraceCorrelation;
  append(
    correlation: Readonly<TraceCorrelation>,
    emission: PolicyEmission,
    nativeSessionId?: string | null,
  ): Promise<StoredTraceEvent>;
  appendLifecycle(
    correlation: Readonly<TraceCorrelation>,
    emission: PolicyEmission,
    nativeSessionId?: string | null,
  ): Promise<void>;
  appendRuntime(
    correlation: Readonly<TraceCorrelation>,
    emission: PolicyEmission,
    nativeSessionId?: string | null,
  ): Promise<StoredTraceEvent>;
  isOpen(conversationId: string, operationId: string): boolean;
  isRetained(conversationId: string, operationId: string): boolean;
  awaitOpen(conversationId: string, operationId: string): Promise<void>;
}
export class AttemptRuntime {
  private readonly reconciliations = new WeakMap<
    AttemptConversationAuthority,
    Map<string, string | null>
  >();
  constructor(private readonly options: AttemptRuntimeOptions) {}
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
    const attemptId = this.options.id("attempt");
    const ref = reservedRef ?? (randomBytes(32).toString("base64url") as AttemptRef);
    const resolved = materialized.resolved;
    const roleName = resolved.role.spec.name;
    if (request.purpose === "evaluator" && roleName !== "brainstorm-evaluator") {
      throw new Error("evaluator attempt requires evaluator role");
    }
    if (request.purpose !== "evaluator" && roleName === "brainstorm-evaluator") {
      throw new Error("non-evaluator attempt cannot use evaluator role");
    }
    const isolatedHistory = request.purpose === "baseline" || request.purpose === "evaluator";
    const resumeOrdinal = ++live.resumeCounter.value;
    const resume = isolatedHistory ? undefined : live.resumeBindings.get(request.participantId);
    if (resume && resume.engine !== resolved.engine) throw new Error("resume engine mismatch");
    if (!isolatedHistory && materialized.spawn.sessionMode === "exact" && !resume) {
      throw new Error("exact session requires persisted resume authority");
    }
    const prompt =
      request.promptInput === live.manifest.task_text
        ? materialized.spawn.rendered_prompt
        : `${materialized.spawn.rendered_prompt.trimEnd()}\n\n## Policy Attempt\n\n${request.promptInput}\n`;
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
    const handle = this.options.sessionAdapter.start({
      attemptId,
      spawn,
      ...(resume ? { nativeSessionId: resume.nativeSessionId } : {}),
      signal: operation.signal,
      onChunk: receiveChunk,
      onLifecycle: (state) => {
        if (!this.options.isRetained(live.manifest.conversation_id, live.operationId)) return;
        enqueueCallback({ kind: "lifecycle", state });
      },
    });
    try {
      operation.addAttempt(handle);
    } catch (error) {
      void handle.terminate("attempt admission failed").catch(() => undefined);
      throw error;
    }
    refs.set(ref, attemptId);
    const completion = (async () => {
      try {
        const result = await handle.completion;
        const captured = handle.readResumeBinding();
        nativeId = captured?.nativeSessionId ?? nativeId;
        evidenceRef = handle.readEvidenceBinding()?.internalRef;
        while (callbackFlush || callbackQueue.length) {
          scheduleCallbacks();
          await callbackFlush;
        }
        await chain;
        if (chunkError) throw chunkError;
        if (
          captured &&
          !isolatedHistory &&
          operation.isLive() &&
          this.options.isRetained(live.manifest.conversation_id, live.operationId)
        ) {
          if (captured.attemptId !== attemptId) throw new Error("resume attempt identity mismatch");
          if (resumeOrdinal > (live.resumeOrdinals.get(request.participantId) ?? -1)) {
            this.options.artifactStore.recordResumeBinding(
              live.manifest.conversation_id,
              request.participantId,
              captured,
            );
            live.resumeBindings.set(request.participantId, {
              participant_id: request.participantId,
              ...captured,
            });
            live.resumeOrdinals.set(request.participantId, resumeOrdinal);
          }
        }
        return result;
      } finally {
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
    for (let index = 0; index < live.manifest.bindings.length; index++) {
      const participantId = live.manifest.bindings[index]?.participant_id ?? "";
      const binding = live.bindings[index];
      const resume = live.resumeBindings.get(participantId);
      if (!resume || !binding || resume.engine !== binding.resolved.engine) continue;
      if (reconciliations.get(participantId) === null) continue;
      const attemptId = reconciliations.get(participantId) ?? this.options.id("attempt");
      reconciliations.set(participantId, attemptId);
      if (operation.signal.aborted) throw new Error("resume operation is not live");
      const result = await this.options.sessionAdapter.reconcileHistory({
        engine: resume.engine,
        nativeSessionId: resume.nativeSessionId,
      });
      const resolved = binding.resolved;
      await this.options.appendRuntime(
        Object.freeze({
          ...this.options.correlation(live.manifest, live.operationId, attemptId),
          participant_id: participantId,
          role_ref: resolved.role.spec.name,
          role_resolved_hash: resolved.role.resolved_hash,
          skill_refs: resolved.skills.map((skill) => skill.ref),
          skill_resolved_hashes: resolved.skills.map((skill) => skill.resolved_hash),
          engine: resolved.engine,
          parent_attempt_id: resume.attemptId,
        }),
        {
          idempotency_key: `native-history:${participantId}:${attemptId}`,
          event: {
            type: "native_history_reconciled",
            payload: {
              public_session_ref: resume.nativeSessionId,
              status: result.status,
              imported_turn_count: result.imported_turn_count,
              imported_tool_count: result.imported_tool_count,
              provenance_refs: [],
              evidence_refs: [],
              completeness_reason: result.completeness_reason,
            },
          },
        },
        resume.nativeSessionId,
      );
      reconciliations.set(participantId, null);
    }
  }
}
