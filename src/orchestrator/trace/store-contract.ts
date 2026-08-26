import type { ArtifactRegistry } from "./artifacts.js";
import type {
  InternalTraceStoreRecord,
  PublicStoredTraceEvent,
  StoredTraceEvent,
  TraceAppendInput,
  TraceCorrelation,
} from "./types.js";

export interface TraceStoreOptions {
  dir: string;
  artifactRegistry?: ArtifactRegistry;
  mirror?: { mirrorTrace(event: PublicStoredTraceEvent): void };
  now?: () => string;
  eventId?: () => string;
}

export interface TraceBatchAppend {
  correlation: TraceCorrelation;
  input: TraceAppendInput;
  native?: string | null;
}

export interface TraceRequestedEventAppendV1 {
  correlation: TraceCorrelation;
  input: TraceAppendInput;
  native: string | null;
  requested_event_id: string;
}

export interface TraceStore {
  readConversation(id: string): Promise<InternalTraceStoreRecord[]>;
  recoverConversation?(id: string): Promise<InternalTraceStoreRecord[]>;
  append(
    correlation: TraceCorrelation,
    input: TraceAppendInput,
    native?: string | null,
    expectedLastSeq?: number,
  ): Promise<StoredTraceEvent>;
  appendBatch?(
    entries: readonly TraceBatchAppend[],
    expectedLastSeq?: number,
  ): Promise<StoredTraceEvent[]>;
  bindRequestedEventAuthority?(validate: (input: TraceRequestedEventAppendV1) => void): void;
  appendRequestedEvent?(
    correlation: TraceCorrelation,
    input: TraceAppendInput,
    requestedEventId: string,
    native?: string | null,
    expectedLastSeq?: number,
  ): Promise<StoredTraceEvent>;
}
