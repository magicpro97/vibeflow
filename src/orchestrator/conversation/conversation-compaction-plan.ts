import type { OversizedHandoffCandidateV1, PublicCompactionInputV1 } from "../../actions/index.js";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../durability/index.js";
import {
  CONVERSATION_PUBLIC_ARTIFACT_DELIVERY,
  CONVERSATION_PUBLIC_PROFILE,
  CONVERSATION_PUBLIC_SCHEMA_VERSION,
} from "./conversation-public-wire-contract.js";
import { type PublicHandoffEventV1, buildOmittedPublicEventRanges } from "./handoff-omission.js";
import {
  contextHandoffPromptDigest,
  contextHandoffSharedPromptBytes,
} from "./handoff-selection.js";
import type {
  PromptHandoffProjectionV1,
  PublicArtifactReferenceV1,
  PublicCompactionArtifactV1,
  PublicEventRangeV1,
  PublicHandoffMessageV1,
  PublicHandoffResponseV1,
  PublicHandoffSourceV1,
} from "./handoff-types.js";
import type { OversizedHandoffRejectedProjectionV1 } from "./oversized-handoff-store.js";
import {
  REVISION_INTERACTION_CURSOR_MEDIA_TYPE,
  REVISION_QUOTE_GRAPH_MEDIA_TYPE,
} from "./revision-handoff-contract.js";

type PublicEvent = PublicHandoffEventV1;

export interface ContextCompactionPlanV1 {
  schema_version: "1.0";
  root_session_id: string;
  oversized_candidate_id: string;
  oversized_candidate_digest: string;
  source: PublicHandoffSourceV1;
  source_public_head_digest: string;
  selection_plan_digest: string;
  previous_compaction_digest: string | null;
  compaction_input_digest: string;
  proposed_prompt_projection_digest: string;
  proposed_compaction_artifact_digest: string;
  created_at: string;
  expires_at: string;
  plan_digest: string;
}

export interface ConstructedContextCompactionV1 {
  plan: ContextCompactionPlanV1;
  artifact: PublicCompactionArtifactV1;
  projection: PromptHandoffProjectionV1;
  artifact_id: string;
  artifact_bytes: Buffer;
  omitted: Array<{ range: PublicEventRangeV1; bytes: Buffer }>;
}

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function eventOrder(left: PublicEvent, right: PublicEvent): number {
  return (
    left.revision_ordinal - right.revision_ordinal ||
    left.public_seq - right.public_seq ||
    compare(left.event_id, right.event_id)
  );
}

function revisionContextArtifact(mediaType: string): boolean {
  return (
    mediaType === REVISION_QUOTE_GRAPH_MEDIA_TYPE ||
    mediaType === REVISION_INTERACTION_CURSOR_MEDIA_TYPE
  );
}

function candidateMatches(
  candidate: OversizedHandoffCandidateV1,
  rejected: OversizedHandoffRejectedProjectionV1,
): boolean {
  return (
    canonicalJsonBytes(candidate.source).equals(canonicalJsonBytes(rejected.source)) &&
    candidate.source_public_head_digest === rejected.source_public_head_digest &&
    candidate.selection_plan_digest === rejected.selection_plan_digest &&
    candidate.mandatory_projection_digest === rejected.mandatory_projection_digest &&
    candidate.prompt_budget_bytes === rejected.prompt_budget_bytes &&
    candidate.encoded_candidate_bytes === rejected.shared_prompt_byte_length
  );
}

export function constructContextCompaction(input: {
  root_session_id: string;
  candidate: OversizedHandoffCandidateV1;
  rejected: OversizedHandoffRejectedProjectionV1;
  compaction_input: PublicCompactionInputV1;
  created_at: string;
  projected_omitted_events?: PublicEvent[];
}): ConstructedContextCompactionV1 {
  if (!candidateMatches(input.candidate, input.rejected))
    throw new Error("oversized candidate and rejected projection disagree");
  if (Date.parse(input.created_at) >= Date.parse(input.candidate.expires_at))
    throw new Error("oversized handoff candidate expired");
  const sourceProjection = input.rejected.prompt_projection;
  const events = [
    ...sourceProjection.transcript.user_messages,
    ...sourceProjection.transcript.final_responses,
    ...(input.projected_omitted_events ?? []),
  ].sort(eventOrder);
  if (new Set(events.map(({ event_id }) => event_id)).size !== events.length)
    throw new Error("oversized projection has duplicate public event ids");
  const availableEvents = new Set(events.map(({ event_id }) => event_id));
  const retainedEvents = new Set(input.compaction_input.retained_event_ids);
  if ([...retainedEvents].some((id) => !availableEvents.has(id)))
    throw new Error("compaction retained event is outside the oversized candidate");
  const availableArtifacts = new Set(
    sourceProjection.artifacts.map(({ artifact }) => artifact.artifact_id),
  );
  if (input.compaction_input.retained_artifact_ids.some((id) => !availableArtifacts.has(id)))
    throw new Error("compaction retained artifact is outside the oversized candidate");
  if (
    sourceProjection.artifacts.filter(({ artifact }) =>
      revisionContextArtifact(artifact.media_type),
    ).length > 1
  )
    throw new Error("oversized projection has ambiguous revision context authority");
  const omitted = buildOmittedPublicEventRanges(events, retainedEvents);
  if (
    sourceProjection.transcript.omitted_public_ranges.length > 0 &&
    (input.projected_omitted_events?.length ?? 0) === 0
  )
    throw new Error("oversized projection omission authority is absent");
  const artifactPreimage = {
    schema_version: CONVERSATION_PUBLIC_SCHEMA_VERSION,
    profile: CONVERSATION_PUBLIC_PROFILE.COMPACTION,
    source: structuredClone(input.candidate.source),
    source_public_head_digest: input.candidate.source_public_head_digest,
    oversized_candidate_digest: input.candidate.candidate_digest,
    selection_plan_digest: input.candidate.selection_plan_digest,
    previous_compaction_digest: sourceProjection.compaction?.content_digest ?? null,
    compaction_input_digest: input.compaction_input.input_digest,
    public_summary: input.compaction_input.public_summary,
    retained_event_ids: [...input.compaction_input.retained_event_ids],
    retained_artifact_ids: [...input.compaction_input.retained_artifact_ids],
    omitted_public_ranges: omitted
      .map((item) => item.range)
      .sort(
        (left, right) =>
          left.revision_ordinal - right.revision_ordinal ||
          left.first_public_seq - right.first_public_seq ||
          compare(left.first_event_id, right.first_event_id),
      ),
    created_at: input.created_at,
  };
  const artifact: PublicCompactionArtifactV1 = {
    ...artifactPreimage,
    content_digest: digestV1("VF-PUBLIC-COMPACTION-ARTIFACT\0v1\0", artifactPreimage),
  };
  const projection: PromptHandoffProjectionV1 = {
    ...structuredClone(sourceProjection),
    transcript: {
      user_messages: events.filter(
        (event): event is PublicHandoffMessageV1 =>
          "author_public_id" in event && retainedEvents.has(event.event_id),
      ),
      final_responses: events.filter(
        (event): event is PublicHandoffResponseV1 =>
          "participant_id" in event && retainedEvents.has(event.event_id),
      ),
      omitted_public_ranges: structuredClone(artifact.omitted_public_ranges),
    },
    compaction: structuredClone(artifact),
    artifacts: [
      ...sourceProjection.artifacts.filter(
        ({ artifact: reference }) =>
          input.compaction_input.retained_artifact_ids.includes(reference.artifact_id) ||
          revisionContextArtifact(reference.media_type),
      ),
      ...omitted.map(({ range }) => ({
        artifact: structuredClone(range.artifact),
        delivery: CONVERSATION_PUBLIC_ARTIFACT_DELIVERY.RESOLVER,
        public_text: null,
      })),
    ].sort((left, right) => compare(left.artifact.artifact_id, right.artifact.artifact_id)),
  };
  const promptBytes = contextHandoffSharedPromptBytes(projection);
  if (promptBytes.length > input.candidate.prompt_budget_bytes)
    throw new Error("handoff_too_large");
  const planPreimage = {
    schema_version: "1.0" as const,
    root_session_id: input.root_session_id,
    oversized_candidate_id: input.candidate.candidate_id,
    oversized_candidate_digest: input.candidate.candidate_digest,
    source: structuredClone(input.candidate.source),
    source_public_head_digest: input.candidate.source_public_head_digest,
    selection_plan_digest: input.candidate.selection_plan_digest,
    previous_compaction_digest: artifact.previous_compaction_digest,
    compaction_input_digest: input.compaction_input.input_digest,
    proposed_prompt_projection_digest: contextHandoffPromptDigest(projection),
    proposed_compaction_artifact_digest: artifact.content_digest,
    created_at: input.created_at,
    expires_at: input.candidate.expires_at,
  };
  return {
    plan: {
      ...planPreimage,
      plan_digest: digestV1("VF-CONTEXT-COMPACTION-PLAN\0v1\0", planPreimage),
    },
    artifact,
    projection,
    artifact_id: `vf-compaction-${digestHex(artifact.content_digest)}`,
    artifact_bytes: canonicalJsonBytes(artifact),
    omitted,
  };
}
