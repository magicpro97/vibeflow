import type { TraceCorrelation } from "../trace/types.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import { CONVERSATION_TRACE_EVENT_KIND } from "./conversation-public-wire-contract.js";
import type { ConversationEffectWriter } from "./effect-writer.js";
import { assertPolicyIdempotencyKey, snapshotRuntimeValue } from "./emission-authority.js";
import type {
  ArtifactCreateRequest,
  ArtifactCreateResult,
  ArtifactUpdateRequest,
  ArtifactUpdateResult,
} from "./types.js";

interface ArtifactUpdateAuthorityRecord {
  readonly manifest: {
    readonly conversation_id: string;
    readonly parent_conversation_id: string | null;
  };
  readonly artifacts: readonly {
    readonly artifact_id: string;
    readonly ref: string;
    readonly previous_ref: string | null;
  }[];
}

const MAX_ARTIFACT_ANCESTRY = 64;

function artifactAncestry(
  current: ArtifactUpdateAuthorityRecord,
  read: (conversationId: string) => ArtifactUpdateAuthorityRecord | null,
): readonly ArtifactUpdateAuthorityRecord[] | null {
  const chain: ArtifactUpdateAuthorityRecord[] = [];
  const seen = new Set<string>();
  let expectedId = current.manifest.conversation_id;
  let record: ArtifactUpdateAuthorityRecord | null = current;
  while (record && chain.length < MAX_ARTIFACT_ANCESTRY) {
    if (record.manifest.conversation_id !== expectedId || seen.has(expectedId)) return null;
    seen.add(expectedId);
    chain.push(record);
    const parentId = record.manifest.parent_conversation_id;
    if (parentId === null) return chain;
    expectedId = parentId;
    record = read(parentId);
  }
  return null;
}

export function hasArtifactUpdateAuthority(
  current: ArtifactUpdateAuthorityRecord,
  artifactId: string,
  previousRef: string,
  read: (conversationId: string) => ArtifactUpdateAuthorityRecord | null,
): boolean {
  return Boolean(
    artifactAncestry(current, read)?.some((record) =>
      record.artifacts.some(
        (artifact) => artifact.artifact_id === artifactId && artifact.ref === previousRef,
      ),
    ),
  );
}

export function hasArtifactRecordAuthority(
  current: ArtifactUpdateAuthorityRecord,
  read: (conversationId: string) => ArtifactUpdateAuthorityRecord | null,
): boolean {
  const chain = artifactAncestry(current, read);
  if (!chain) return false;
  return chain.every((record, recordIndex) =>
    record.artifacts.every(
      (artifact, artifactIndex) =>
        artifact.previous_ref === null ||
        record.artifacts
          .slice(0, artifactIndex)
          .some(
            (prior) =>
              prior.artifact_id === artifact.artifact_id && prior.ref === artifact.previous_ref,
          ) ||
        chain
          .slice(recordIndex + 1)
          .some((ancestor) =>
            ancestor.artifacts.some(
              (prior) =>
                prior.artifact_id === artifact.artifact_id && prior.ref === artifact.previous_ref,
            ),
          ),
    ),
  );
}

interface ArtifactAuthorityOptions {
  effects: ConversationEffectWriter;
  store: ConversationArtifactStore;
  id(kind: string): string;
}

/** Validates policy keys before the durable artifact preparation side effect. */
export class ConversationArtifactAuthority {
  constructor(private readonly options: ArtifactAuthorityOptions) {}

  create(
    conversationId: string,
    correlation: TraceCorrelation,
    request: ArtifactCreateRequest,
  ): Promise<ArtifactCreateResult> {
    const captured = snapshotRuntimeValue(request);
    assertPolicyIdempotencyKey(captured.idempotency_key);
    return this.options.effects.artifact(
      conversationId,
      correlation,
      () =>
        this.options.store.prepareCreateArtifact(
          conversationId,
          this.options.id("artifact"),
          captured,
        ),
      (result) => ({
        idempotency_key: captured.idempotency_key,
        event: {
          type: CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_CREATED,
          payload: { ...result, artifact_type: captured.artifact_type },
        },
      }),
    );
  }

  update(
    conversationId: string,
    correlation: TraceCorrelation,
    request: ArtifactUpdateRequest,
  ): Promise<ArtifactUpdateResult> {
    const captured = snapshotRuntimeValue(request);
    assertPolicyIdempotencyKey(captured.idempotency_key);
    return this.options.effects.artifact(
      conversationId,
      correlation,
      () => this.options.store.prepareUpdateArtifact(conversationId, captured),
      (result) => ({
        idempotency_key: captured.idempotency_key,
        event: {
          type: CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_UPDATED,
          payload: { ...result, artifact_type: captured.artifact_type },
        },
      }),
    );
  }
}
