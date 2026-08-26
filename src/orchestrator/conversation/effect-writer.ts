import type { ArtifactRegistry } from "../trace/artifacts.js";
import { projectPublicStoredTrace } from "../trace/project.js";
import type { TraceBatchAppend, TraceStore } from "../trace/store.js";
import type {
  PolicyEmission,
  PublicStoredTraceEvent,
  StoredTraceEvent,
  TraceCorrelation,
} from "../trace/types.js";
import type { ArtifactPreparation } from "./artifact-store.js";
import { snapshotRuntimeValue } from "./emission-authority.js";
import type { ConversationEmissionGate } from "./lifecycle-gate.js";
import type { ArtifactCreateResult, ArtifactUpdateResult } from "./types.js";

interface EffectWriterOptions {
  traceStore: TraceStore;
  artifactRegistry: ArtifactRegistry;
  emissions: ConversationEmissionGate;
  notify(event: PublicStoredTraceEvent): void;
}

/** Private append/transaction authority owned by one ConversationRuntime. */
export class ConversationEffectWriter {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly options: EffectWriterOptions) {}

  private serial<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(conversationId) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(conversationId, settled);
    void settled.finally(() => {
      if (this.tails.get(conversationId) === settled) this.tails.delete(conversationId);
    });
    return result;
  }

  drain(conversationId: string): Promise<void> {
    return this.tails.get(conversationId) ?? Promise.resolve();
  }

  private notify(stored: StoredTraceEvent, nativeSessionId: string | null): void {
    this.options.notify(
      projectPublicStoredTrace(
        { stored_event: stored, native_session_id: nativeSessionId },
        {
          conversationId: stored.conversation_id,
          artifactRegistry: this.options.artifactRegistry,
        },
      ),
    );
  }

  write(
    correlation: Readonly<TraceCorrelation>,
    emission: PolicyEmission,
    nativeSessionId: string | null = null,
  ): Promise<StoredTraceEvent> {
    const capturedCorrelation = snapshotRuntimeValue(correlation);
    const capturedEmission = snapshotRuntimeValue(emission);
    return this.serial(capturedCorrelation.conversation_id, async () => {
      const stored = await this.options.traceStore.append(
        capturedCorrelation,
        capturedEmission,
        nativeSessionId,
      );
      this.notify(stored, nativeSessionId);
      return stored;
    });
  }

  writeRequestedEvent(
    correlation: Readonly<TraceCorrelation>,
    emission: PolicyEmission,
    requestedEventId: string,
  ): Promise<StoredTraceEvent> {
    const capturedCorrelation = snapshotRuntimeValue(correlation);
    const capturedEmission = snapshotRuntimeValue(emission);
    return this.serial(capturedCorrelation.conversation_id, async () => {
      const append = this.options.traceStore.appendRequestedEvent;
      if (!append) throw new Error("trace requested event append authority is absent");
      const stored = await append.call(
        this.options.traceStore,
        capturedCorrelation,
        capturedEmission,
        requestedEventId,
        null,
      );
      this.notify(stored, null);
      return stored;
    });
  }

  writeBatch(
    correlation: Readonly<TraceCorrelation>,
    emissions: readonly PolicyEmission[],
  ): Promise<StoredTraceEvent[]> {
    const capturedCorrelation = snapshotRuntimeValue(correlation);
    const capturedEmissions = snapshotRuntimeValue(emissions);
    return this.serial(capturedCorrelation.conversation_id, async () => {
      const entries: TraceBatchAppend[] = capturedEmissions.map((input) => ({
        correlation: capturedCorrelation,
        input,
        native: null,
      }));
      const stored: StoredTraceEvent[] = [];
      if (this.options.traceStore.appendBatch) {
        stored.push(...(await this.options.traceStore.appendBatch(entries)));
      } else {
        for (const { correlation: value, input, native } of entries) {
          stored.push(await this.options.traceStore.append(value, input, native));
        }
      }
      for (const event of stored) this.notify(event, null);
      return stored;
    });
  }

  writePolicy(
    correlation: Readonly<TraceCorrelation>,
    emission: PolicyEmission,
    nativeSessionId: string | null = null,
  ): Promise<StoredTraceEvent> {
    const capturedCorrelation = snapshotRuntimeValue(correlation);
    const capturedEmission = snapshotRuntimeValue(emission);
    if (
      !this.options.emissions.isOpen(
        capturedCorrelation.conversation_id,
        capturedCorrelation.operation_id,
      )
    ) {
      return this.options.emissions
        .awaitOpen(capturedCorrelation.conversation_id, capturedCorrelation.operation_id)
        .then(() => this.writePolicy(capturedCorrelation, capturedEmission, nativeSessionId));
    }
    return this.write(capturedCorrelation, capturedEmission, nativeSessionId);
  }

  artifact<T extends ArtifactCreateResult | ArtifactUpdateResult>(
    id: string,
    correlation: Readonly<TraceCorrelation>,
    prepare: () => ArtifactPreparation<T>,
    emission: (result: T) => PolicyEmission,
  ): Promise<T> {
    if (!this.options.emissions.isOpen(id, correlation.operation_id)) {
      return this.options.emissions
        .awaitOpen(id, correlation.operation_id)
        .then(() => this.artifact(id, correlation, prepare, emission));
    }
    return this.serial(id, async () => {
      const transaction = prepare();
      try {
        const stored = await this.options.traceStore.append(
          correlation,
          emission(transaction.result),
        );
        transaction.commit();
        this.notify(stored, null);
        return transaction.result;
      } catch (error) {
        transaction.rollback();
        throw error;
      }
    });
  }
}
