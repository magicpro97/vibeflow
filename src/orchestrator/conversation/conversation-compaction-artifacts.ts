import type { ArtifactPreparation, ConversationArtifactStore } from "./artifact-store.js";
import type { ConstructedContextCompactionV1 } from "./conversation-compaction-plan.js";
import { CONVERSATION_ARTIFACT_TYPE } from "./conversation-public-wire-contract.js";

export interface PreparedConversationCompactionArtifactsV1 {
  preparations: ArtifactPreparation<never>[];
  omitted_refs: string[];
  compaction_ref: string;
}

/** Prepares the complete compaction artifact set without publishing its record. */
export function prepareConversationCompactionArtifacts(input: {
  artifacts: ConversationArtifactStore;
  conversation_id: string;
  proposal_id: string;
  construction: ConstructedContextCompactionV1;
}): PreparedConversationCompactionArtifactsV1 {
  const preparations: ArtifactPreparation<never>[] = [];
  const omittedRefs: string[] = [];
  try {
    input.construction.omitted.forEach((omitted, index) => {
      const preparation = input.artifacts.prepareCreateArtifact(
        input.conversation_id,
        omitted.range.artifact.artifact_id,
        {
          artifact_type: CONVERSATION_ARTIFACT_TYPE.TRANSCRIPT,
          content: omitted.bytes,
          idempotency_key: `compaction-omitted-${input.proposal_id.slice(-32)}-${index}`,
        },
      );
      preparations.push(preparation as ArtifactPreparation<never>);
      omittedRefs.push(preparation.result.ref);
    });
    const artifact = input.artifacts.prepareCreateArtifact(
      input.conversation_id,
      input.construction.artifact_id,
      {
        artifact_type: CONVERSATION_ARTIFACT_TYPE.COMPACTION,
        content: input.construction.artifact_bytes,
        idempotency_key: `compaction-artifact-${input.proposal_id.slice(-32)}`,
      },
    );
    preparations.push(artifact as ArtifactPreparation<never>);
    return {
      preparations,
      omitted_refs: omittedRefs,
      compaction_ref: artifact.result.ref,
    };
  } catch (error) {
    for (const prepared of preparations.reverse()) prepared.rollback();
    throw error;
  }
}

/** Verifies every committed content object against the canonical construction bytes. */
export function verifyConversationCompactionArtifacts(input: {
  artifacts: ConversationArtifactStore;
  conversation_id: string;
  construction: ConstructedContextCompactionV1;
  omitted_refs: readonly string[];
  compaction_ref: string;
}): void {
  input.construction.omitted.forEach((omitted, index) => {
    const bytes = input.artifacts.readArtifactRef(
      input.conversation_id,
      input.omitted_refs[index] ?? "",
    );
    if (!bytes || !Buffer.from(bytes).equals(omitted.bytes))
      throw new Error("context compaction omitted artifact changed");
  });
  const bytes = input.artifacts.readArtifactRef(input.conversation_id, input.compaction_ref);
  if (!bytes || !Buffer.from(bytes).equals(input.construction.artifact_bytes))
    throw new Error("context compaction artifact changed");
}
