import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import { handoffSourcePublicHeadDigest } from "./handoff-selection.js";
import type {
  PublicCompactionArtifactV1,
  PublicHandoffMessageV1,
  PublicHandoffResponseV1,
} from "./handoff-types.js";
import type { ConversationLineageReadV1, ValidatedLineageNodeV1 } from "./lineage-reader.js";

type PublicEvent = PublicHandoffMessageV1 | PublicHandoffResponseV1;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function key(node: { conversation_id: string; revision_id: string }): string {
  return `${node.conversation_id}\0${node.revision_id}`;
}

function selectedAncestry(
  lineage: ConversationLineageReadV1,
  parent: ValidatedLineageNodeV1,
): ValidatedLineageNodeV1[] {
  const byNode = new Map(lineage.nodes.map((node) => [key(node.node), node]));
  const output: ValidatedLineageNodeV1[] = [];
  let current: ValidatedLineageNodeV1 | undefined = parent;
  while (current) {
    output.push(current);
    current = current.parent ? byNode.get(key(current.parent)) : undefined;
  }
  return output.reverse();
}

export function validatePublicCompactionArtifact(value: unknown): PublicCompactionArtifactV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid public compaction artifact");
  const artifact = value as PublicCompactionArtifactV1;
  const { content_digest: _digest, ...preimage } = artifact;
  if (
    artifact.schema_version !== "1.0" ||
    artifact.profile !== "vf-public-compaction/1" ||
    !DIGEST.test(artifact.source_public_head_digest) ||
    !DIGEST.test(artifact.oversized_candidate_digest) ||
    !DIGEST.test(artifact.selection_plan_digest) ||
    !DIGEST.test(artifact.compaction_input_digest) ||
    (artifact.previous_compaction_digest !== null &&
      !DIGEST.test(artifact.previous_compaction_digest)) ||
    digestV1("VF-PUBLIC-COMPACTION-ARTIFACT\0v1\0", preimage) !== artifact.content_digest
  )
    throw new Error("invalid public compaction artifact binding");
  return structuredClone(artifact);
}

function prefixEvents(
  events: PublicEvent[],
  artifact: PublicCompactionArtifactV1,
  ordinal: number,
): PublicEvent[] {
  return events.filter(
    (event) =>
      event.revision_ordinal < ordinal ||
      (event.revision_ordinal === ordinal && event.public_seq <= artifact.source.last_seq),
  );
}

export function resolveActiveCompaction(input: {
  artifacts: ConversationArtifactStore;
  lineage: ConversationLineageReadV1;
  parent: ValidatedLineageNodeV1;
  public_events: PublicEvent[];
}): PublicCompactionArtifactV1 | null {
  let active: PublicCompactionArtifactV1 | null = null;
  for (const node of selectedAncestry(input.lineage, input.parent)) {
    for (const { stored_event: event } of node.source.journal_records) {
      if (
        event.event.type !== "artifact_created" ||
        event.event.payload.artifact_type !== "compaction"
      )
        continue;
      const bytes = input.artifacts.readArtifact(
        node.node.conversation_id,
        event.event.payload.artifact_id,
      );
      if (!bytes) throw new Error("compaction artifact bytes are absent");
      const buffer = Buffer.from(bytes);
      const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
      if (!canonicalJsonBytes(decoded).equals(buffer))
        throw new Error("compaction artifact bytes are non-canonical");
      const artifact = validatePublicCompactionArtifact(decoded);
      if (
        artifact.source.conversation_id !== node.node.conversation_id ||
        artifact.source.revision_id !== node.node.revision_id ||
        artifact.source.last_seq >= event.seq ||
        (artifact.previous_compaction_digest !== active?.content_digest &&
          !(artifact.previous_compaction_digest === null && active === null)) ||
        handoffSourcePublicHeadDigest(
          artifact.source,
          prefixEvents(input.public_events, artifact, node.node.revision_ordinal),
        ) !== artifact.source_public_head_digest
      )
        throw new Error("compaction artifact ancestry binding changed");
      active = artifact;
    }
  }
  return active;
}
