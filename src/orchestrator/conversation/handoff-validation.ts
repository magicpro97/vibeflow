import { canonicalJson, digestHex, digestV1 } from "../../durability/index.js";
import { contextHandoffContentDigest, contextHandoffPromptDigest } from "./handoff-selection.js";
import type {
  ContextHandoffV1,
  PublicArtifactReferenceV1,
  PublicEventRangeV1,
  PublicHandoffBindingV1,
  PublicHandoffMessageV1,
  PublicHandoffResponseV1,
} from "./handoff-types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ENGINES = new Set(["claude", "codex", "copilot", "opencode", "antigravity"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function assertOrderedEvents(
  events: Array<PublicHandoffMessageV1 | PublicHandoffResponseV1>,
): void {
  const seen = new Set<string>();
  let prior: PublicHandoffMessageV1 | PublicHandoffResponseV1 | undefined;
  for (const event of events) {
    if (
      !isRecord(event) ||
      !REFERENCE.test(event.event_id) ||
      !REFERENCE.test(event.conversation_id) ||
      !REFERENCE.test(event.revision_id) ||
      !Number.isSafeInteger(event.revision_ordinal) ||
      event.revision_ordinal < 0 ||
      !Number.isSafeInteger(event.public_seq) ||
      event.public_seq < 1 ||
      typeof event.text !== "string" ||
      event.text !== event.text.normalize("NFC") ||
      !DIGEST.test(event.redaction_manifest_digest) ||
      Number.isNaN(Date.parse(event.created_at)) ||
      seen.has(event.event_id)
    )
      throw new Error("invalid public handoff event");
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

function assertArtifact(value: PublicArtifactReferenceV1): void {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "artifact_id",
      "artifact_kind",
      "byte_length",
      "content_sha256",
      "media_type",
      "resolver",
    ]) ||
    !REFERENCE.test(value.artifact_id) ||
    !["conversation-artifact", "omitted-public-events"].includes(value.artifact_kind) ||
    typeof value.media_type !== "string" ||
    value.media_type.length === 0 ||
    !Number.isSafeInteger(value.byte_length) ||
    value.byte_length < 0 ||
    !SHA256.test(value.content_sha256) ||
    value.resolver !== "conversation-artifact-v1"
  )
    throw new Error("invalid public handoff artifact");
}

function assertBindings(bindings: PublicHandoffBindingV1[]): void {
  for (const [index, binding] of bindings.entries()) {
    if (
      !isRecord(binding) ||
      !exactKeys(binding, ["continuity", "engine", "model", "participant_id", "role_ref"]) ||
      !REFERENCE.test(binding.participant_id) ||
      !ENGINES.has(binding.engine) ||
      (binding.model !== null && !REFERENCE.test(binding.model)) ||
      !REFERENCE.test(binding.role_ref) ||
      !["retained", "added"].includes(binding.continuity) ||
      (index > 0 &&
        compareText(bindings[index - 1]?.participant_id ?? "", binding.participant_id) >= 0)
    )
      throw new Error("invalid public handoff binding");
  }
}

function assertOmittedRanges(
  ranges: PublicEventRangeV1[],
  artifacts: PublicArtifactReferenceV1[],
): void {
  const artifactIds = new Set<string>();
  let prior: PublicEventRangeV1 | undefined;
  for (const range of ranges) {
    if (
      !isRecord(range) ||
      !exactKeys(range, [
        "artifact",
        "canonical_events_sha256",
        "event_count",
        "first_event_id",
        "first_public_seq",
        "last_event_id",
        "last_public_seq",
        "revision_id",
        "revision_ordinal",
      ]) ||
      !REFERENCE.test(range.revision_id) ||
      !Number.isSafeInteger(range.revision_ordinal) ||
      range.revision_ordinal < 0 ||
      !Number.isSafeInteger(range.first_public_seq) ||
      !Number.isSafeInteger(range.last_public_seq) ||
      range.first_public_seq < 1 ||
      range.last_public_seq < range.first_public_seq ||
      !REFERENCE.test(range.first_event_id) ||
      !REFERENCE.test(range.last_event_id) ||
      !Number.isSafeInteger(range.event_count) ||
      range.event_count !== range.last_public_seq - range.first_public_seq + 1 ||
      !SHA256.test(range.canonical_events_sha256) ||
      artifactIds.has(range.artifact.artifact_id)
    )
      throw new Error("invalid omitted public event range");
    assertArtifact(range.artifact);
    if (
      range.artifact.artifact_kind !== "omitted-public-events" ||
      range.artifact.content_sha256 !== range.canonical_events_sha256 ||
      !artifacts.some((artifact) => canonicalJson(artifact) === canonicalJson(range.artifact)) ||
      (prior &&
        (range.revision_ordinal < prior.revision_ordinal ||
          (range.revision_ordinal === prior.revision_ordinal &&
            range.first_public_seq <= prior.last_public_seq + 1)))
    )
      throw new Error("omitted public event ranges are not maximal and ordered");
    artifactIds.add(range.artifact.artifact_id);
    prior = range;
  }
}

export function assertContextHandoffV1(value: unknown): asserts value is ContextHandoffV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "artifacts",
      "bindings",
      "compaction",
      "consensus",
      "digest",
      "handoff_id",
      "handoff_selection_digest",
      "policy",
      "projection_profile",
      "prompt_projection",
      "prompt_projection_digest",
      "schema_version",
      "source",
      "topic",
      "transcript",
    ]) ||
    value.schema_version !== "1.0" ||
    value.projection_profile !== "vf-public-handoff/1" ||
    typeof value.handoff_id !== "string" ||
    !/^vf-handoff-[0-9a-f]{64}$/.test(value.handoff_id) ||
    !DIGEST.test(value.digest as string) ||
    !DIGEST.test(value.handoff_selection_digest as string) ||
    !DIGEST.test(value.prompt_projection_digest as string) ||
    (value.topic !== null &&
      (typeof value.topic !== "string" || value.topic !== value.topic.normalize("NFC"))) ||
    !isRecord(value.source) ||
    !REFERENCE.test(value.source.conversation_id as string) ||
    !REFERENCE.test(value.source.revision_id as string) ||
    !Number.isSafeInteger(value.source.last_seq) ||
    (value.source.last_seq as number) < 0 ||
    !DIGEST.test(value.source.lock_digest as string) ||
    !Array.isArray(value.bindings) ||
    !Array.isArray(value.artifacts) ||
    !isRecord(value.transcript) ||
    !Array.isArray(value.transcript.user_messages) ||
    !Array.isArray(value.transcript.final_responses) ||
    !Array.isArray(value.transcript.omitted_public_ranges) ||
    !isRecord(value.prompt_projection)
  )
    throw new Error("invalid context handoff");
  const handoff = value as unknown as ContextHandoffV1;
  assertBindings(handoff.bindings);
  assertOrderedEvents(handoff.transcript.user_messages);
  assertOrderedEvents(handoff.transcript.final_responses);
  for (const artifact of handoff.artifacts) assertArtifact(artifact);
  assertOmittedRanges(handoff.transcript.omitted_public_ranges, handoff.artifacts);
  for (const [index, artifact] of handoff.artifacts.entries())
    if (
      index > 0 &&
      compareText(handoff.artifacts[index - 1]?.artifact_id ?? "", artifact.artifact_id) >= 0
    )
      throw new Error("public handoff artifacts are not ordered");
  const policy = handoff.policy;
  const { policy_id: _policyId, policy_digest: _policyDigest, ...policyPreimage } = policy;
  const policyDigest = digestV1("VF-PUBLIC-HANDOFF-POLICY\0v1\0", policyPreimage);
  if (
    policy.policy_digest !== policyDigest ||
    policy.policy_id !== `vf-handoff-policy-${digestHex(policyDigest)}` ||
    policy.source_conversation_lock_digest !== handoff.source.lock_digest
  )
    throw new Error("invalid public handoff policy digest");
  const projection = handoff.prompt_projection;
  if (
    projection.schema_version !== "1.0" ||
    projection.projection_profile !== "vf-public-handoff/1" ||
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
}
