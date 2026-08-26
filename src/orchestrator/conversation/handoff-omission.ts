import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "../../durability/index.js";
import type {
  PublicArtifactReferenceV1,
  PublicEventRangeV1,
  PublicHandoffMessageV1,
  PublicHandoffResponseV1,
} from "./handoff-types.js";

export type PublicHandoffEventV1 = PublicHandoffMessageV1 | PublicHandoffResponseV1;
export interface OmittedPublicEventArtifactV1 {
  range: PublicEventRangeV1;
  bytes: Buffer;
}

function eventOrder(left: PublicHandoffEventV1, right: PublicHandoffEventV1): number {
  return (
    left.revision_ordinal - right.revision_ordinal ||
    left.public_seq - right.public_seq ||
    Buffer.compare(Buffer.from(left.event_id), Buffer.from(right.event_id))
  );
}

function materializeRange(events: PublicHandoffEventV1[]): OmittedPublicEventArtifactV1 {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) throw new Error("empty omitted public event range");
  const bytes = canonicalJsonBytes({ schema_version: "1.0", events });
  const contentSha = createHash("sha256").update(bytes).digest("hex");
  const artifact: PublicArtifactReferenceV1 = {
    artifact_id: `vf-omitted-public-events-${contentSha}`,
    artifact_kind: "omitted-public-events",
    media_type: "application/vnd.vibeflow.public-events+json",
    byte_length: bytes.length,
    content_sha256: contentSha,
    resolver: "conversation-artifact-v1",
  };
  return {
    bytes,
    range: {
      revision_id: first.revision_id,
      revision_ordinal: first.revision_ordinal,
      first_public_seq: first.public_seq,
      last_public_seq: last.public_seq,
      first_event_id: first.event_id,
      last_event_id: last.event_id,
      event_count: events.length,
      canonical_events_sha256: contentSha,
      artifact,
    },
  };
}

/** Builds maximal contiguous ranges over the canonical public-event order. */
export function buildOmittedPublicEventRanges(
  events: readonly PublicHandoffEventV1[],
  retained: ReadonlySet<string>,
): OmittedPublicEventArtifactV1[] {
  const groups: PublicHandoffEventV1[][] = [];
  for (const event of [...structuredClone(events)].sort(eventOrder)) {
    if (retained.has(event.event_id)) continue;
    const current = groups.at(-1);
    const prior = current?.at(-1);
    if (
      !current ||
      !prior ||
      prior.revision_id !== event.revision_id ||
      prior.revision_ordinal !== event.revision_ordinal ||
      prior.public_seq + 1 !== event.public_seq
    )
      groups.push([event]);
    else current.push(event);
  }
  return groups.map(materializeRange);
}
