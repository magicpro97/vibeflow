import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "../../durability/index.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import { CONVERSATION_PUBLIC_SCHEMA_VERSION } from "./conversation-public-wire-contract.js";
import { validatePublicHandoffEventV1 } from "./handoff-nested-validation.js";
import type {
  PublicArtifactReferenceV1,
  PublicHandoffMessageV1,
  PublicHandoffResponseV1,
} from "./handoff-types.js";
import type { ResolvedConversationLineageV1 } from "./lineage-service.js";
import type { OversizedHandoffRejectedProjectionV1 } from "./oversized-handoff-store.js";

export type CompactionSourceEventV1 = PublicHandoffMessageV1 | PublicHandoffResponseV1;

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

function bytesFor(
  artifacts: ConversationArtifactStore,
  resolved: ResolvedConversationLineageV1,
  reference: PublicArtifactReferenceV1,
  omissionBytes?: (reference: PublicArtifactReferenceV1) => Uint8Array | null,
): Buffer {
  const matches = resolved.selected_nodes
    .map(({ node }) => artifacts.readArtifact(node.conversation_id, reference.artifact_id))
    .filter((bytes): bytes is Uint8Array => bytes !== null);
  const retained = omissionBytes?.(reference);
  if (retained) matches.push(retained);
  if (
    matches.length === 0 ||
    matches.some((bytes) => !Buffer.from(bytes).equals(Buffer.from(matches[0] as Uint8Array)))
  )
    throw new Error("omitted public artifact ancestry is ambiguous");
  const match = matches[0];
  if (!match) throw new Error("omitted public artifact ancestry is absent");
  return Buffer.from(match);
}

export function resolveCompactionSourceEvents(input: {
  artifacts: ConversationArtifactStore;
  resolved: ResolvedConversationLineageV1;
  rejected: OversizedHandoffRejectedProjectionV1;
  omissionBytes?(reference: PublicArtifactReferenceV1): Uint8Array | null;
}): CompactionSourceEventV1[] {
  const output: CompactionSourceEventV1[] = [];
  const artifactIds = new Set<string>();
  for (const range of input.rejected.prompt_projection.transcript.omitted_public_ranges) {
    if (artifactIds.has(range.artifact.artifact_id))
      throw new Error("duplicate omitted public artifact reference");
    artifactIds.add(range.artifact.artifact_id);
    const bytes = bytesFor(input.artifacts, input.resolved, range.artifact, input.omissionBytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (
      bytes.length !== range.artifact.byte_length ||
      hash !== range.artifact.content_sha256 ||
      hash !== range.canonical_events_sha256
    )
      throw new Error("omitted public artifact content binding changed");
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !plain(decoded) ||
      Reflect.ownKeys(decoded).length !== 2 ||
      decoded.schema_version !== CONVERSATION_PUBLIC_SCHEMA_VERSION ||
      !Array.isArray(decoded.events) ||
      !canonicalJsonBytes(decoded).equals(bytes)
    )
      throw new Error("invalid omitted public artifact bytes");
    const events = decoded.events.map(validatePublicHandoffEventV1);
    const first = events[0];
    const last = events.at(-1);
    if (
      events.length !== range.event_count ||
      first?.event_id !== range.first_event_id ||
      last?.event_id !== range.last_event_id ||
      first?.public_seq !== range.first_public_seq ||
      last?.public_seq !== range.last_public_seq ||
      events.some(
        (event, index) =>
          event.revision_id !== range.revision_id ||
          event.revision_ordinal !== range.revision_ordinal ||
          event.public_seq !== range.first_public_seq + index,
      )
    )
      throw new Error("omitted public range binding changed");
    output.push(...events);
  }
  const ids = output.map(({ event_id }) => event_id);
  if (new Set(ids).size !== ids.length) throw new Error("overlapping omitted public ranges");
  return output;
}
