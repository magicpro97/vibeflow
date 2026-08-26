import type { MaterializedAgentBinding } from "../../agents/binding.js";
import type { PublicStoredTraceEvent, TraceCorrelation } from "../trace/types.js";
import { reconcileActiveConversation } from "./active-reconciliation.js";
import { ConversationArtifactAuthority } from "./artifact-authority.js";
import type { PersistedResumeBinding } from "./artifact-store.js";
import { AttemptRuntime } from "./attempt-runtime.js";
import { ControlRuntime } from "./control-runtime.js";
import { ConversationEffectWriter } from "./effect-writer.js";
import { ConversationEmissionGate, type LiveConversation } from "./lifecycle-gate.js";
import { OperationRegistry } from "./operation-registry.js";
import { ConversationRestartRuntime } from "./restart-runtime.js";
import type { ConversationRuntimeOptions } from "./runtime.js";
import type { ConversationManifest } from "./types.js";

interface ConversationRuntimeAuthorityHost {
  id(kind: string): string;
  current(id: string): LiveConversation | undefined;
  notify(event: PublicStoredTraceEvent): void;
  correlation(
    manifest: ConversationManifest,
    operationId: string,
    attemptId: string,
  ): TraceCorrelation;
  manifest(id: string): ConversationManifest | null;
  begin(
    manifest: ConversationManifest,
    bindings: MaterializedAgentBinding[],
    resumes: readonly PersistedResumeBinding[],
    paused: boolean,
    transitionEpoch: number,
    operationId: string,
  ): string;
}

export interface ConversationRuntimeAuthorities {
  operations: OperationRegistry;
  emissions: ConversationEmissionGate;
  effects: ConversationEffectWriter;
  artifacts: ConversationArtifactAuthority;
  restarts: ConversationRestartRuntime;
  attempts: AttemptRuntime;
  controls: ControlRuntime;
}

/** Wires the runtime's mutually-referencing authorities in one canonical order. */
export function createConversationRuntimeAuthorities(
  options: ConversationRuntimeOptions,
  host: ConversationRuntimeAuthorityHost,
): ConversationRuntimeAuthorities {
  options.homeAuthorities?.revisionLanes.bindStartAuthority(options.sessionAdapter.startAuthority);
  const operations: OperationRegistry = new OperationRegistry({
    authority: options.artifactStore.operationAuthority(),
    onCancelled: (id, operationId) => emissions.adoptCancellation(id, operationId),
    onSettled: (id, operationId, lifecycle) => {
      emissions.adoptClosure(id, operationId);
      if (lifecycle) emissions.adoptTerminal(id, operationId, lifecycle);
    },
    onTransitionPrepare: (id, operationId, lifecycle): Promise<void> => {
      const gate: Promise<void> = emissions.prepareTransition(id, operationId, lifecycle);
      const drained = effects.drain(id);
      return Promise.all([gate, drained]).then(() => undefined);
    },
    onTransitionAdopt: (id, operationId, lifecycle, epoch) => {
      emissions.adoptTransition(id, operationId, lifecycle);
      const live = host.current(id);
      if (live?.operationId === operationId) live.transitionEpoch = epoch;
    },
    onEpochAdopt: (id, operationId, epoch) => {
      const live = host.current(id);
      if (live?.operationId === operationId) live.transitionEpoch = epoch;
    },
    onTransitionReject: (id, operationId, lifecycle, error) =>
      emissions.rejectTransition(id, operationId, lifecycle, error),
    onCancelPrepare: (id, operationId): Promise<void> => {
      const gate: Promise<void> = emissions.prepareCancellation(id, operationId);
      const drained = effects.drain(id);
      return Promise.all([gate, drained]).then(() => undefined);
    },
    onCancelRollback: (id, operationId) => emissions.rollbackCancellation(id, operationId),
  });
  const emissions: ConversationEmissionGate = new ConversationEmissionGate((id, operationId) =>
    operations.isCancelled(id, operationId),
  );
  const effects = new ConversationEffectWriter({
    traceStore: options.traceStore,
    artifactRegistry: options.artifactRegistry,
    emissions,
    notify: host.notify,
  });
  const artifacts = new ConversationArtifactAuthority({
    effects,
    store: options.artifactStore,
    id: host.id,
  });
  const restarts = new ConversationRestartRuntime({
    traceStore: options.traceStore,
    artifactRegistry: options.artifactRegistry,
    artifactStore: options.artifactStore,
    ...(options.homeAuthorities
      ? { reviewedActionAuthority: options.homeAuthorities.reviewedActionAuthority() }
      : {}),
    id: host.id,
    current: host.current,
    reconcileActive: (live) => reconcileActiveConversation(live, operations, emissions, attempts),
    begin: host.begin,
    rehydrateBinding: options.rehydrateBinding,
  });
  const attempts = new AttemptRuntime({
    id: host.id,
    sessionAdapter: options.sessionAdapter,
    artifactStore: options.artifactStore,
    correlation: host.correlation,
    append: (correlation, emission, native) => effects.writePolicy(correlation, emission, native),
    appendLifecycle: (correlation, emission, native) =>
      effects.writePolicy(correlation, emission, native).then(() => undefined),
    appendRuntime: (correlation, emission, native) => effects.write(correlation, emission, native),
    isOpen: (conversationId, operationId) => emissions.isOpen(conversationId, operationId),
    isRetained: (conversationId, operationId) => emissions.isRetained(conversationId, operationId),
    awaitOpen: (conversationId, operationId) => emissions.awaitOpen(conversationId, operationId),
    ...(options.homeAuthorities ? { revisionLanes: options.homeAuthorities.revisionLanes } : {}),
  });
  const controls = new ControlRuntime({
    operations,
    manifest: host.manifest,
    authority: (id) => {
      const live = host.current(id);
      return live ? { manifest: live.manifest, operationId: live.operationId } : null;
    },
    read: (id) => options.traceStore.readConversation(id),
    correlation: ({ manifest, operationId }, attemptId) =>
      host.correlation(manifest, operationId, attemptId),
    appendActive: (correlation, emission, requestedEventId) =>
      emissions.control(correlation.conversation_id, correlation.operation_id, false, () =>
        requestedEventId
          ? effects.writeRequestedEvent(correlation, emission, requestedEventId)
          : effects.write(correlation, emission),
      ),
    appendCancellation: (correlation, emission) => effects.write(correlation, emission),
    appendTransition: (correlation, emission) => effects.write(correlation, emission),
    appendTerminal: (correlation, inputs) => effects.writeBatch(correlation, inputs),
  });
  return { operations, emissions, effects, artifacts, restarts, attempts, controls };
}
