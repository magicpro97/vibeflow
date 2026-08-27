import { canonicalJsonBytes } from "../../durability/index.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import {
  CONVERSATION_ARTIFACT_TYPE,
  CONVERSATION_TRACE_EVENT_KIND,
} from "./conversation-public-wire-contract.js";
import { assertPublicCompactionArtifactV1 } from "./handoff-nested-validation.js";
import { handoffSourcePublicHeadDigest } from "./handoff-selection.js";
import type {
  PublicCompactionArtifactV1,
  PublicHandoffMessageV1,
  PublicHandoffResponseV1,
} from "./handoff-types.js";
import type { ConversationLineageReadV1, ValidatedLineageNodeV1 } from "./lineage-reader.js";

type PublicEvent = PublicHandoffMessageV1 | PublicHandoffResponseV1;

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
  assertPublicCompactionArtifactV1(value);
  return structuredClone(value);
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
        event.event.type !== CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_CREATED ||
        event.event.payload.artifact_type !== CONVERSATION_ARTIFACT_TYPE.COMPACTION
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
