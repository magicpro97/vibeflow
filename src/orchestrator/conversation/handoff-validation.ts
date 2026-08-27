import { assertPublicProjectionSafe } from "../../actions/public-safety.js";
import { isAgentEngine } from "../../core/agent-contract.js";
import { canonicalJson, digestHex } from "../../durability/index.js";
import {
  CONVERSATION_CONTEXT_HANDOFF_FIELDS,
  CONVERSATION_HANDOFF_CONTINUITIES,
  CONVERSATION_PUBLIC_HANDOFF_BINDING_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_PROJECTION_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_TRANSCRIPT_FIELDS,
  CONVERSATION_PUBLIC_PROFILE,
  CONVERSATION_PUBLIC_SCHEMA_VERSION,
} from "./conversation-public-wire-contract.js";
import { MAX_CONTEXT_HANDOFF_OBJECT_BYTES } from "./handoff-limits.js";
import {
  assertPromptArtifactSelectionsV1,
  assertPublicArtifactReferenceV1,
  assertPublicCompactionArtifactV1,
  assertPublicEventRangesV1,
  assertPublicHandoffConsensusV1,
  assertPublicHandoffEventV1,
  assertPublicHandoffPolicyV1,
  assertPublicHandoffSourceV1,
  compareHandoffText as compareText,
  hasExactHandoffKeys as exactKeys,
  isHandoffDigest,
  isHandoffReference,
  isHandoffRecord as isRecord,
} from "./handoff-nested-validation.js";
import { contextHandoffContentDigest, contextHandoffPromptDigest } from "./handoff-selection.js";
import type {
  ContextHandoffV1,
  PromptHandoffProjectionV1,
  PublicHandoffBindingV1,
  PublicHandoffMessageV1,
  PublicHandoffResponseV1,
} from "./handoff-types.js";

function assertOrderedEvents(
  events: Array<PublicHandoffMessageV1 | PublicHandoffResponseV1>,
  variant: "message" | "response",
  seen: Set<string>,
): void {
  let prior: PublicHandoffMessageV1 | PublicHandoffResponseV1 | undefined;
  for (const event of events) {
    assertPublicHandoffEventV1(event, variant);
    if (seen.has(event.event_id)) throw new Error("invalid public handoff event");
    if (
      prior &&
      (event.revision_ordinal < prior.revision_ordinal ||
        (event.revision_ordinal === prior.revision_ordinal &&
          (event.public_seq < prior.public_seq ||
            (event.public_seq === prior.public_seq &&
              compareText(event.event_id, prior.event_id) <= 0))))
    )
      throw new Error("public handoff events are not ordered");
    seen.add(event.event_id);
    prior = event;
  }
}

function assertBindings(bindings: PublicHandoffBindingV1[]): void {
  for (const [index, binding] of bindings.entries()) {
    if (
      !isRecord(binding) ||
      !exactKeys(binding, CONVERSATION_PUBLIC_HANDOFF_BINDING_FIELDS) ||
      !isHandoffReference(binding.participant_id) ||
      !isAgentEngine(binding.engine) ||
      (binding.model !== null && !isHandoffReference(binding.model)) ||
      !isHandoffReference(binding.role_ref) ||
      !CONVERSATION_HANDOFF_CONTINUITIES.includes(binding.continuity) ||
      (index > 0 &&
        compareText(bindings[index - 1]?.participant_id ?? "", binding.participant_id) >= 0)
    )
      throw new Error("invalid public handoff binding");
  }
}

function assertPublicHandoffTextSafety(handoff: ContextHandoffV1): void {
  assertPublicProjectionSafe(
    {
      topic: handoff.topic,
      policy: {
        public_summary: handoff.policy.public_summary,
        source_policy_value: handoff.policy.source_policy_value,
      },
      messages: handoff.transcript.user_messages.map(({ text }) => text),
      responses: handoff.transcript.final_responses.map(({ text }) => text),
      consensus_synthesis: handoff.consensus.synthesis,
      inline_artifact_text: handoff.prompt_projection.artifacts.map(
        ({ public_text }) => public_text,
      ),
      compaction_summary: handoff.compaction?.public_summary ?? null,
    },
    "$.handoff.public_text",
    { maxBytes: MAX_CONTEXT_HANDOFF_OBJECT_BYTES },
  );
}

function assertPromptHandoffTextSafety(projection: PromptHandoffProjectionV1): void {
  assertPublicProjectionSafe(
    {
      topic: projection.topic,
      policy: {
        public_summary: projection.policy.public_summary,
        source_policy_value: projection.policy.source_policy_value,
      },
      messages: projection.transcript.user_messages.map(({ text }) => text),
      responses: projection.transcript.final_responses.map(({ text }) => text),
      consensus_synthesis: projection.consensus.synthesis,
      inline_artifact_text: projection.artifacts.map(({ public_text }) => public_text),
      compaction_summary: projection.compaction?.public_summary ?? null,
    },
    "$.handoff.prompt_projection.public_text",
    { maxBytes: MAX_CONTEXT_HANDOFF_OBJECT_BYTES },
  );
}

export function assertPromptHandoffProjectionV1(
  value: unknown,
): asserts value is PromptHandoffProjectionV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, CONVERSATION_PUBLIC_HANDOFF_PROJECTION_FIELDS) ||
    value.schema_version !== CONVERSATION_PUBLIC_SCHEMA_VERSION ||
    value.projection_profile !== CONVERSATION_PUBLIC_PROFILE.HANDOFF ||
    (value.topic !== null &&
      (typeof value.topic !== "string" || value.topic !== value.topic.normalize("NFC"))) ||
    !isRecord(value.source) ||
    !isRecord(value.policy) ||
    !Array.isArray(value.bindings) ||
    !isRecord(value.transcript) ||
    !exactKeys(value.transcript, CONVERSATION_PUBLIC_HANDOFF_TRANSCRIPT_FIELDS) ||
    !Array.isArray(value.transcript.user_messages) ||
    !Array.isArray(value.transcript.final_responses) ||
    !Array.isArray(value.transcript.omitted_public_ranges) ||
    !isRecord(value.consensus) ||
    (value.compaction !== null && !isRecord(value.compaction)) ||
    !Array.isArray(value.artifacts)
  )
    throw new Error("invalid context handoff prompt projection");
  const projection = value as unknown as PromptHandoffProjectionV1;
  assertPublicHandoffSourceV1(projection.source);
  assertPublicHandoffPolicyV1(projection.policy, projection.source.lock_digest);
  assertBindings(projection.bindings);
  const eventIds = new Set<string>();
  assertOrderedEvents(projection.transcript.user_messages, "message", eventIds);
  assertOrderedEvents(projection.transcript.final_responses, "response", eventIds);
  assertPromptArtifactSelectionsV1(projection.artifacts);
  assertPublicEventRangesV1(
    projection.transcript.omitted_public_ranges,
    projection.artifacts.map(({ artifact }) => artifact),
  );
  if (projection.compaction !== null) assertPublicCompactionArtifactV1(projection.compaction);
  assertPublicHandoffConsensusV1(projection.consensus);
  assertPromptHandoffTextSafety(projection);
}

export function assertContextHandoffV1(value: unknown): asserts value is ContextHandoffV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, CONVERSATION_CONTEXT_HANDOFF_FIELDS) ||
    value.schema_version !== CONVERSATION_PUBLIC_SCHEMA_VERSION ||
    value.projection_profile !== CONVERSATION_PUBLIC_PROFILE.HANDOFF ||
    typeof value.handoff_id !== "string" ||
    !/^vf-handoff-[0-9a-f]{64}$/.test(value.handoff_id) ||
    !isHandoffDigest(value.digest) ||
    !isHandoffDigest(value.handoff_selection_digest) ||
    !isHandoffDigest(value.prompt_projection_digest) ||
    (value.topic !== null &&
      (typeof value.topic !== "string" || value.topic !== value.topic.normalize("NFC"))) ||
    !isRecord(value.source) ||
    !isRecord(value.policy) ||
    !Array.isArray(value.bindings) ||
    !Array.isArray(value.artifacts) ||
    !isRecord(value.transcript) ||
    !exactKeys(value.transcript, CONVERSATION_PUBLIC_HANDOFF_TRANSCRIPT_FIELDS) ||
    !Array.isArray(value.transcript.user_messages) ||
    !Array.isArray(value.transcript.final_responses) ||
    !Array.isArray(value.transcript.omitted_public_ranges) ||
    !isRecord(value.consensus) ||
    (value.compaction !== null && !isRecord(value.compaction)) ||
    !isRecord(value.prompt_projection) ||
    !exactKeys(value.prompt_projection, CONVERSATION_PUBLIC_HANDOFF_PROJECTION_FIELDS)
  )
    throw new Error("invalid context handoff");
  const handoff = value as unknown as ContextHandoffV1;
  assertPublicHandoffSourceV1(handoff.source);
  assertPublicHandoffPolicyV1(handoff.policy, handoff.source.lock_digest);
  assertPublicHandoffConsensusV1(handoff.consensus);
  if (handoff.compaction !== null) assertPublicCompactionArtifactV1(handoff.compaction);
  assertBindings(handoff.bindings);
  const eventIds = new Set<string>();
  assertOrderedEvents(handoff.transcript.user_messages, "message", eventIds);
  assertOrderedEvents(handoff.transcript.final_responses, "response", eventIds);
  for (const artifact of handoff.artifacts) assertPublicArtifactReferenceV1(artifact);
  assertPublicEventRangesV1(handoff.transcript.omitted_public_ranges, handoff.artifacts);
  for (const [index, artifact] of handoff.artifacts.entries())
    if (
      index > 0 &&
      compareText(handoff.artifacts[index - 1]?.artifact_id ?? "", artifact.artifact_id) >= 0
    )
      throw new Error("public handoff artifacts are not ordered");
  const projection = handoff.prompt_projection;
  assertPromptHandoffProjectionV1(projection);
  if (
    projection.schema_version !== CONVERSATION_PUBLIC_SCHEMA_VERSION ||
    projection.projection_profile !== CONVERSATION_PUBLIC_PROFILE.HANDOFF ||
    canonicalJson(projection.source) !== canonicalJson(handoff.source) ||
    projection.topic !== handoff.topic ||
    canonicalJson(projection.policy) !== canonicalJson(handoff.policy) ||
    canonicalJson(projection.bindings) !== canonicalJson(handoff.bindings) ||
    canonicalJson(projection.transcript) !== canonicalJson(handoff.transcript) ||
    canonicalJson(projection.compaction) !== canonicalJson(handoff.compaction) ||
    canonicalJson(projection.consensus) !== canonicalJson(handoff.consensus) ||
    canonicalJson(projection.artifacts.map((item) => item.artifact)) !==
      canonicalJson(handoff.artifacts) ||
    contextHandoffPromptDigest(projection) !== handoff.prompt_projection_digest
  )
    throw new Error("context handoff prompt projection mismatch");
  const { handoff_id: _handoffId, digest: _digest, ...contentPreimage } = handoff;
  const digest = contextHandoffContentDigest(contentPreimage);
  if (handoff.digest !== digest || handoff.handoff_id !== `vf-handoff-${digestHex(digest)}`)
    throw new Error("context handoff digest mismatch");
  assertPublicHandoffTextSafety(handoff);
}
