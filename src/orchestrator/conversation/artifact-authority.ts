import type { TraceCorrelation } from "../trace/types.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
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
  readonly artifacts: readonly { readonly artifact_id: string; readonly ref: string }[];
}

const MAX_ARTIFACT_ANCESTRY = 64;

export function hasArtifactUpdateAuthority(
  current: ArtifactUpdateAuthorityRecord,
  artifactId: string,
  previousRef: string,
  read: (conversationId: string) => ArtifactUpdateAuthorityRecord | null,
): boolean {
  const seen = new Set<string>();
  let expectedId = current.manifest.conversation_id;
  let record: ArtifactUpdateAuthorityRecord | null = current;
  let authorized = false;
  for (let depth = 0; record && depth < MAX_ARTIFACT_ANCESTRY; depth++) {
    if (record.manifest.conversation_id !== expectedId || seen.has(expectedId)) return false;
    seen.add(expectedId);
    authorized ||= record.artifacts.some(
      (artifact) => artifact.artifact_id === artifactId && artifact.ref === previousRef,
    );
    expectedId = record.manifest.parent_conversation_id ?? "";
    if (!expectedId) return authorized;
    record = read(expectedId);
  }
  return false;
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
          type: "artifact_created",
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
          type: "artifact_updated",
          payload: { ...result, artifact_type: captured.artifact_type },
        },
      }),
    );
  }
}
