import { createHash } from "node:crypto";
import { ACTION_PREVIEW_PROJECTOR_VERSION } from "../../actions/public-action-contract.js";
import { assertPublicProjectionSafe } from "../../actions/public-safety.js";
import { canonicalJson, digestHex, digestV1 } from "../../durability/index.js";
import {
  CONVERSATION_PUBLIC_ARTIFACT_DELIVERY,
  CONVERSATION_PUBLIC_ARTIFACT_KIND,
  CONVERSATION_PUBLIC_ARTIFACT_REFERENCE_FIELDS,
  CONVERSATION_PUBLIC_ARTIFACT_RESOLVER,
  CONVERSATION_PUBLIC_COMPACTION_ARTIFACT_FIELDS,
  CONVERSATION_PUBLIC_COMPACTION_SUMMARY_MAX_BYTES,
  CONVERSATION_PUBLIC_COMPACTION_SUMMARY_MAX_CANONICAL_JSON_BYTES,
  CONVERSATION_PUBLIC_EVENT_RANGE_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_CONSENSUS_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_MESSAGE_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_POLICY_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_RESPONSE_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_SOURCE_FIELDS,
  CONVERSATION_PUBLIC_OMITTED_EVENTS_ARTIFACT_ID_PREFIX,
  CONVERSATION_PUBLIC_OMITTED_EVENTS_MEDIA_TYPE,
  CONVERSATION_PUBLIC_PROFILE,
  CONVERSATION_PUBLIC_PROMPT_ARTIFACT_SELECTION_FIELDS,
  CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUSES,
  CONVERSATION_PUBLIC_SCHEMA_VERSION,
  isConversationNonnegativeSafeInteger,
  isConversationNullableScore,
  isConversationPositiveSafeInteger,
} from "./conversation-public-wire-contract.js";
import { MAX_CANONICAL_HANDOFF_BYTES } from "./handoff-limits.js";
import type {
  PromptArtifactSelectionV1,
  PublicArtifactReferenceV1,
  PublicCompactionArtifactV1,
  PublicEventRangeV1,
  PublicHandoffConsensusV1,
  PublicHandoffMessageV1,
  PublicHandoffPolicyV1,
  PublicHandoffResponseV1,
  PublicHandoffSourceV1,
} from "./handoff-types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export const isHandoffDigest = (value: unknown): value is string =>
  typeof value === "string" && DIGEST.test(value);

export const isHandoffReference = (value: unknown): value is string =>
  typeof value === "string" && REFERENCE.test(value);

export function isHandoffRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasExactHandoffKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function compareHandoffText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export function isCanonicalHandoffTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export function assertPublicHandoffEventV1(
  value: unknown,
  variant: "message" | "response",
): asserts value is PublicHandoffMessageV1 | PublicHandoffResponseV1 {
  if (
    !isHandoffRecord(value) ||
    !hasExactHandoffKeys(
      value,
      variant === "message"
        ? CONVERSATION_PUBLIC_HANDOFF_MESSAGE_FIELDS
        : CONVERSATION_PUBLIC_HANDOFF_RESPONSE_FIELDS,
    ) ||
    !isHandoffReference(value.event_id) ||
    !isHandoffReference(value.conversation_id) ||
    !isHandoffReference(value.revision_id) ||
    !isConversationNonnegativeSafeInteger(value.revision_ordinal) ||
    !isConversationPositiveSafeInteger(value.public_seq) ||
    typeof value.text !== "string" ||
    value.text !== value.text.normalize("NFC") ||
    !isCanonicalHandoffTimestamp(value.created_at) ||
    !isHandoffDigest(value.redaction_manifest_digest) ||
    (variant === "message" && !isHandoffReference(value.author_public_id)) ||
    (variant === "response" &&
      (!isHandoffReference(value.participant_id) ||
        !isHandoffReference(value.role_ref) ||
        !CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUSES.includes(
          value.terminal_status as PublicHandoffResponseV1["terminal_status"],
        )))
  )
    throw new Error("invalid public handoff event");
  try {
    assertPublicProjectionSafe(value.text, "$.public_handoff_event.text", {
      maxBytes: MAX_CANONICAL_HANDOFF_BYTES,
    });
  } catch {
    throw new Error("invalid public handoff event");
  }
}

export function validatePublicHandoffEventV1(
  value: unknown,
): PublicHandoffMessageV1 | PublicHandoffResponseV1 {
  if (!isHandoffRecord(value)) throw new Error("invalid public handoff event");
  const message = Object.hasOwn(value, "author_public_id");
  const response = Object.hasOwn(value, "participant_id");
  if (message === response) throw new Error("ambiguous public handoff event");
  assertPublicHandoffEventV1(value, message ? "message" : "response");
  return structuredClone(value);
}

function sortedReferences(value: unknown, max = Number.POSITIVE_INFINITY): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every(
      (item, index) =>
        isHandoffReference(item) &&
        (index === 0 || compareHandoffText(value[index - 1] as string, item) < 0),
    )
  );
}

export function assertPublicHandoffSourceV1(
  value: unknown,
): asserts value is PublicHandoffSourceV1 {
  if (
    !isHandoffRecord(value) ||
    !hasExactHandoffKeys(value, CONVERSATION_PUBLIC_HANDOFF_SOURCE_FIELDS) ||
    !isHandoffReference(value.conversation_id) ||
    !isHandoffReference(value.revision_id) ||
    !Number.isSafeInteger(value.last_seq) ||
    (value.last_seq as number) < 0 ||
    !isHandoffDigest(value.lock_digest)
  )
    throw new Error("invalid public handoff source");
}

export function assertPublicArtifactReferenceV1(
  value: unknown,
): asserts value is PublicArtifactReferenceV1 {
  if (
    !isHandoffRecord(value) ||
    !hasExactHandoffKeys(value, CONVERSATION_PUBLIC_ARTIFACT_REFERENCE_FIELDS) ||
    !isHandoffReference(value.artifact_id) ||
    !Object.values(CONVERSATION_PUBLIC_ARTIFACT_KIND).includes(
      value.artifact_kind as PublicArtifactReferenceV1["artifact_kind"],
    ) ||
    typeof value.media_type !== "string" ||
    value.media_type.length === 0 ||
    value.media_type !== value.media_type.normalize("NFC") ||
    !Number.isSafeInteger(value.byte_length) ||
    (value.byte_length as number) < 0 ||
    typeof value.content_sha256 !== "string" ||
    !SHA256.test(value.content_sha256) ||
    value.resolver !== CONVERSATION_PUBLIC_ARTIFACT_RESOLVER.CONVERSATION
  )
    throw new Error("invalid public handoff artifact");
}

export function assertPublicEventRangesV1(
  ranges: unknown,
  artifacts: readonly PublicArtifactReferenceV1[],
): asserts ranges is PublicEventRangeV1[] {
  if (!Array.isArray(ranges)) throw new Error("invalid omitted public event ranges");
  const artifactIds = new Set<string>();
  let prior: PublicEventRangeV1 | undefined;
  for (const candidate of ranges) {
    if (!isHandoffRecord(candidate) || !isHandoffRecord(candidate.artifact))
      throw new Error("invalid omitted public event range");
    const range = candidate as unknown as PublicEventRangeV1;
    if (
      !hasExactHandoffKeys(candidate, CONVERSATION_PUBLIC_EVENT_RANGE_FIELDS) ||
      !isHandoffReference(range.revision_id) ||
      !Number.isSafeInteger(range.revision_ordinal) ||
      range.revision_ordinal < 0 ||
      !Number.isSafeInteger(range.first_public_seq) ||
      !Number.isSafeInteger(range.last_public_seq) ||
      range.first_public_seq < 1 ||
      range.last_public_seq < range.first_public_seq ||
      !isHandoffReference(range.first_event_id) ||
      !isHandoffReference(range.last_event_id) ||
      !Number.isSafeInteger(range.event_count) ||
      range.event_count !== range.last_public_seq - range.first_public_seq + 1 ||
      typeof range.canonical_events_sha256 !== "string" ||
      !SHA256.test(range.canonical_events_sha256) ||
      artifactIds.has(range.artifact.artifact_id)
    )
      throw new Error("invalid omitted public event range");
    assertPublicArtifactReferenceV1(range.artifact);
    if (
      range.artifact.artifact_id !==
        `${CONVERSATION_PUBLIC_OMITTED_EVENTS_ARTIFACT_ID_PREFIX}${range.canonical_events_sha256}` ||
      range.artifact.artifact_kind !== CONVERSATION_PUBLIC_ARTIFACT_KIND.OMITTED_EVENTS ||
      range.artifact.media_type !== CONVERSATION_PUBLIC_OMITTED_EVENTS_MEDIA_TYPE ||
      range.artifact.content_sha256 !== range.canonical_events_sha256 ||
      !artifacts.some((artifact) => canonicalJson(artifact) === canonicalJson(range.artifact)) ||
      (prior !== undefined &&
        (range.revision_ordinal < prior.revision_ordinal ||
          (range.revision_ordinal === prior.revision_ordinal &&
            range.first_public_seq <= prior.last_public_seq + 1)))
    )
      throw new Error("omitted public event ranges are not maximal and ordered");
    artifactIds.add(range.artifact.artifact_id);
    prior = range;
  }
}

export function assertPublicHandoffPolicyV1(
  value: unknown,
  sourceLockDigest: string,
): asserts value is PublicHandoffPolicyV1 {
  if (
    !isHandoffRecord(value) ||
    !hasExactHandoffKeys(value, CONVERSATION_PUBLIC_HANDOFF_POLICY_FIELDS)
  )
    throw new Error("invalid public handoff policy");
  const policy = value as unknown as PublicHandoffPolicyV1;
  const rulesDigest = digestV1("VF-PUBLIC-HANDOFF-RULES\0v1\0", {
    schema_version: CONVERSATION_PUBLIC_SCHEMA_VERSION,
    projector_version: ACTION_PREVIEW_PROJECTOR_VERSION,
  });
  const { policy_id: _policyId, policy_digest: _policyDigest, ...preimage } = policy;
  const policyDigest = digestV1("VF-PUBLIC-HANDOFF-POLICY\0v1\0", preimage);
  if (
    typeof policy.public_summary !== "string" ||
    policy.public_summary !== policy.public_summary.normalize("NFC") ||
    typeof policy.source_policy_value !== "string" ||
    policy.source_policy_value !== policy.source_policy_value.normalize("NFC") ||
    policy.source_conversation_lock_digest !== sourceLockDigest ||
    policy.projector_version !== ACTION_PREVIEW_PROJECTOR_VERSION ||
    policy.rules_digest !== rulesDigest ||
    policy.policy_digest !== policyDigest ||
    policy.policy_id !== `vf-handoff-policy-${digestHex(policyDigest)}`
  )
    throw new Error("invalid public handoff policy digest");
}

export function assertPublicHandoffConsensusV1(
  value: unknown,
): asserts value is PublicHandoffConsensusV1 {
  if (
    !isHandoffRecord(value) ||
    !hasExactHandoffKeys(value, CONVERSATION_PUBLIC_HANDOFF_CONSENSUS_FIELDS) ||
    !isConversationNullableScore(value.score) ||
    (value.synthesis !== null &&
      (typeof value.synthesis !== "string" || value.synthesis !== value.synthesis.normalize("NFC")))
  )
    throw new Error("invalid public handoff consensus");
}

export function assertPromptArtifactSelectionsV1(
  value: unknown,
): asserts value is PromptArtifactSelectionV1[] {
  if (!Array.isArray(value)) throw new Error("invalid public handoff artifact selections");
  let priorId: string | undefined;
  for (const candidate of value) {
    if (
      !isHandoffRecord(candidate) ||
      !hasExactHandoffKeys(candidate, CONVERSATION_PUBLIC_PROMPT_ARTIFACT_SELECTION_FIELDS)
    )
      throw new Error("invalid public handoff artifact selection");
    const selection = candidate as unknown as PromptArtifactSelectionV1;
    assertPublicArtifactReferenceV1(selection.artifact);
    if (
      (selection.delivery === CONVERSATION_PUBLIC_ARTIFACT_DELIVERY.INLINE_PUBLIC_TEXT &&
        (typeof selection.public_text !== "string" ||
          selection.public_text !== selection.public_text.normalize("NFC") ||
          Buffer.byteLength(selection.public_text) !== selection.artifact.byte_length ||
          createHash("sha256").update(selection.public_text).digest("hex") !==
            selection.artifact.content_sha256)) ||
      (selection.delivery === CONVERSATION_PUBLIC_ARTIFACT_DELIVERY.RESOLVER &&
        selection.public_text !== null) ||
      !Object.values(CONVERSATION_PUBLIC_ARTIFACT_DELIVERY).includes(selection.delivery) ||
      (priorId !== undefined && compareHandoffText(priorId, selection.artifact.artifact_id) >= 0)
    )
      throw new Error("invalid public handoff artifact delivery");
    priorId = selection.artifact.artifact_id;
  }
}

export function assertPublicCompactionArtifactV1(
  value: unknown,
): asserts value is PublicCompactionArtifactV1 {
  if (
    !isHandoffRecord(value) ||
    !hasExactHandoffKeys(value, CONVERSATION_PUBLIC_COMPACTION_ARTIFACT_FIELDS)
  )
    throw new Error("invalid public compaction artifact");
  const artifact = value as unknown as PublicCompactionArtifactV1;
  assertPublicHandoffSourceV1(artifact.source);
  if (!Array.isArray(artifact.omitted_public_ranges))
    throw new Error("invalid public compaction ranges");
  assertPublicEventRangesV1(
    artifact.omitted_public_ranges,
    artifact.omitted_public_ranges.map((range) => range.artifact),
  );
  const { content_digest: _contentDigest, ...preimage } = artifact;
  if (
    artifact.schema_version !== CONVERSATION_PUBLIC_SCHEMA_VERSION ||
    artifact.profile !== CONVERSATION_PUBLIC_PROFILE.COMPACTION ||
    !isHandoffDigest(artifact.source_public_head_digest) ||
    !isHandoffDigest(artifact.oversized_candidate_digest) ||
    !isHandoffDigest(artifact.selection_plan_digest) ||
    !isHandoffDigest(artifact.compaction_input_digest) ||
    (artifact.previous_compaction_digest !== null &&
      !isHandoffDigest(artifact.previous_compaction_digest)) ||
    typeof artifact.public_summary !== "string" ||
    artifact.public_summary.length === 0 ||
    Buffer.byteLength(artifact.public_summary, "utf8") >
      CONVERSATION_PUBLIC_COMPACTION_SUMMARY_MAX_BYTES ||
    artifact.public_summary !== artifact.public_summary.normalize("NFC") ||
    !sortedReferences(artifact.retained_event_ids, 256) ||
    !sortedReferences(artifact.retained_artifact_ids, 256) ||
    !isCanonicalHandoffTimestamp(artifact.created_at) ||
    artifact.content_digest !== digestV1("VF-PUBLIC-COMPACTION-ARTIFACT\0v1\0", preimage)
  )
    throw new Error("invalid public compaction artifact binding");
  assertPublicProjectionSafe(artifact.public_summary, "$.public_summary", {
    maxBytes: CONVERSATION_PUBLIC_COMPACTION_SUMMARY_MAX_CANONICAL_JSON_BYTES,
  });
}
