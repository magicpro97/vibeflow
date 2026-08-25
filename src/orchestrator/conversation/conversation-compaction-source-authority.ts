import { createHash } from "node:crypto";
import type { OversizedHandoffCandidateV1 } from "../../actions/index.js";
import { digestV1 } from "../../durability/index.js";
import { conversationLockDigest } from "./catalog-lock.js";
import type { constructContextCompaction } from "./conversation-compaction-plan.js";
import type { ResolvedConversationLineageV1 } from "./lineage-service.js";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Reconstructs the exact pre-compaction manifest while tolerating only this plan's objects. */
export function compactionSourceAuthorityMatches(input: {
  proposalId: string;
  candidate: OversizedHandoffCandidateV1;
  construction: ReturnType<typeof constructContextCompaction>;
  resolved: ResolvedConversationLineageV1;
}): boolean {
  const suffix = input.proposalId.slice(-32);
  const expected = new Map(
    input.construction.omitted.map((omitted, index) => [
      `compaction-omitted-${suffix}-${index}`,
      {
        artifact_id: omitted.range.artifact.artifact_id,
        artifact_type: "transcript",
        content_hash: sha(omitted.bytes),
      },
    ]),
  );
  expected.set(`compaction-artifact-${suffix}`, {
    artifact_id: input.construction.artifact_id,
    artifact_type: "compaction",
    content_hash: sha(input.construction.artifact_bytes),
  });
  const matchedRefs = new Set<string>();
  const retained = input.resolved.requested.source.manifest_record.artifacts.filter((entry) => {
    const planned = expected.get(entry.idempotency_key);
    if (!planned) {
      if (
        entry.idempotency_key.startsWith(`compaction-omitted-${suffix}-`) ||
        entry.idempotency_key === `compaction-artifact-${suffix}`
      )
        throw new Error("context compaction artifact closure changed");
      return true;
    }
    if (
      entry.artifact_id !== planned.artifact_id ||
      entry.artifact_type !== planned.artifact_type ||
      entry.content_hash !== planned.content_hash ||
      entry.previous_ref !== null ||
      matchedRefs.has(entry.ref)
    )
      throw new Error("context compaction artifact closure changed");
    matchedRefs.add(entry.ref);
    return false;
  });
  const reservations = Object.fromEntries(
    Object.entries(input.resolved.requested.source.manifest_record.artifact_reservations).filter(
      ([ref]) => !matchedRefs.has(ref),
    ),
  );
  const record = {
    ...input.resolved.requested.source.manifest_record,
    artifacts: retained,
    artifact_reservations: reservations,
  };
  const source = {
    ...input.resolved.requested.source,
    manifest_record: record,
    manifest_digest: digestV1("VF-CONVERSATION-MANIFEST-RECORD\0v1\0", record),
  };
  return (
    source.journal_head.last_seq === input.candidate.source.last_seq &&
    source.manifest.revision_id === input.candidate.source.revision_id &&
    conversationLockDigest(
      input.resolved.lineage.root_session_id,
      source,
      input.resolved.revision_claim_epoch,
    ) === input.candidate.source.lock_digest
  );
}
