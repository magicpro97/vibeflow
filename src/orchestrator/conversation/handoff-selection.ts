import { createHash } from "node:crypto";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../durability/index.js";
import { HANDOFF_PROMPT_PREFIX, MAX_CANONICAL_HANDOFF_BYTES } from "./handoff-limits.js";
import {
  type OmittedPublicEventArtifactV1,
  buildOmittedPublicEventRanges,
} from "./handoff-omission.js";
import type {
  ContextHandoffV1,
  HandoffSelectionPlanV1,
  PromptArtifactSelectionV1,
  PromptHandoffProjectionV1,
  PublicArtifactReferenceV1,
  PublicCompactionArtifactV1,
  PublicHandoffBindingV1,
  PublicHandoffMessageV1,
  PublicHandoffResponseV1,
  PublicHandoffSourceV1,
} from "./handoff-types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface BuildContextHandoffInputV1 {
  source: PublicHandoffSourceV1;
  topic: string | null;
  policy_value: string;
  bindings: PublicHandoffBindingV1[];
  user_messages: PublicHandoffMessageV1[];
  final_responses: PublicHandoffResponseV1[];
  artifacts: Array<PromptArtifactSelectionV1 | PublicArtifactReferenceV1>;
  /** Internal selections that remain mandatory across an approved public compaction. */
  mandatory_artifacts?: Array<PromptArtifactSelectionV1 | PublicArtifactReferenceV1>;
  consensus: { score: number | null; synthesis: string | null };
  prompt_budget_bytes: number;
  active_compaction?: PublicCompactionArtifactV1 | null;
}

export interface BuiltContextHandoffV1 {
  input: BuildContextHandoffInputV1;
  handoff: ContextHandoffV1;
  selection_plan: HandoffSelectionPlanV1;
  shared_prompt_bytes: Buffer;
  omitted_public_event_artifacts: OmittedPublicEventArtifactV1[];
}

export class HandoffTooLargeError extends Error {
  constructor(
    readonly projection: PromptHandoffProjectionV1,
    readonly selection_plan: HandoffSelectionPlanV1,
    readonly shared_prompt_bytes: Buffer,
    readonly omitted_public_event_artifacts: OmittedPublicEventArtifactV1[],
  ) {
    super("handoff_too_large");
    this.name = "HandoffTooLargeError";
  }
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function eventOrder(
  left: { revision_ordinal: number; public_seq: number; event_id: string },
  right: { revision_ordinal: number; public_seq: number; event_id: string },
): number {
  return (
    left.revision_ordinal - right.revision_ordinal ||
    left.public_seq - right.public_seq ||
    compareText(left.event_id, right.event_id)
  );
}

export function handoffSourcePublicHeadDigest(
  source: PublicHandoffSourceV1,
  publicEvents: Array<PublicHandoffMessageV1 | PublicHandoffResponseV1>,
): string {
  return digestV1("VF-HANDOFF-SOURCE-PUBLIC-HEAD\0v1\0", {
    schema_version: "1.0",
    source: structuredClone(source),
    public_events: structuredClone(publicEvents).sort(eventOrder),
  });
}

function lengthPrefixedDigest(domain: string, bytes: Uint8Array): string {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  const hash = createHash("sha256");
  hash.update(Buffer.from(domain, "utf8"));
  hash.update(length);
  hash.update(bytes);
  return `sha256:${hash.digest("hex")}`;
}

export function contextHandoffSharedPromptBytes(projection: PromptHandoffProjectionV1): Buffer {
  const prefix = Buffer.from(HANDOFF_PROMPT_PREFIX, "utf8");
  return Buffer.concat([
    prefix,
    canonicalJsonBytes(projection, {
      maxBytes: MAX_CANONICAL_HANDOFF_BYTES - prefix.byteLength,
    }),
  ]);
}

/** Bounded rejection encoder used only to materialize an exact +1 overflow candidate. */
export function contextHandoffRejectedPromptBytes(projection: PromptHandoffProjectionV1): Buffer {
  const prefix = Buffer.from(HANDOFF_PROMPT_PREFIX, "utf8");
  return Buffer.concat([
    prefix,
    canonicalJsonBytes(projection, { maxBytes: MAX_CANONICAL_HANDOFF_BYTES }),
  ]);
}

export function contextHandoffPromptDigest(projection: PromptHandoffProjectionV1): string {
  return lengthPrefixedDigest(
    "VF-CONTEXT-HANDOFF-PROMPT\0v1\0",
    contextHandoffRejectedPromptBytes(projection),
  );
}

export function contextHandoffContentDigest(
  handoff: Omit<ContextHandoffV1, "handoff_id" | "digest">,
): string {
  return lengthPrefixedDigest(
    "VF-CONTEXT-HANDOFF-CONTENT\0v1\0",
    canonicalJsonBytes(handoff, { maxBytes: 16 * 1024 * 1024 }),
  );
}

function normalizeText(value: string | null): string | null {
  return value === null ? null : value.normalize("NFC");
}

function asSelection(
  value: PromptArtifactSelectionV1 | PublicArtifactReferenceV1,
): PromptArtifactSelectionV1 {
  if ("artifact" in value) return structuredClone(value);
  return {
    artifact: structuredClone(value),
    delivery: "conversation-artifact-resolver",
    public_text: null,
  };
}

function uniqueSorted<T extends { event_id: string; revision_ordinal: number; public_seq: number }>(
  values: T[],
): T[] {
  const sorted = structuredClone(values).sort(eventOrder);
  for (let index = 1; index < sorted.length; index += 1)
    if (sorted[index - 1]?.event_id === sorted[index]?.event_id)
      throw new Error("duplicate public handoff event id");
  return sorted;
}

function buildPolicy(source: PublicHandoffSourceV1, policyValue: string) {
  const preimage = {
    public_summary: policyValue.normalize("NFC"),
    source_policy_value: policyValue.normalize("NFC"),
    source_conversation_lock_digest: source.lock_digest,
    projector_version: "vf-public-projector/1" as const,
    rules_digest: digestV1("VF-PUBLIC-HANDOFF-RULES\0v1\0", {
      schema_version: "1.0",
      projector_version: "vf-public-projector/1",
    }),
  };
  const policy_digest = digestV1("VF-PUBLIC-HANDOFF-POLICY\0v1\0", preimage);
  return {
    policy_id: `vf-handoff-policy-${digestHex(policy_digest)}`,
    ...preimage,
    policy_digest,
  };
}

export function buildContextHandoff(raw: BuildContextHandoffInputV1): BuiltContextHandoffV1 {
  if (
    !Number.isSafeInteger(raw.prompt_budget_bytes) ||
    raw.prompt_budget_bytes < 1 ||
    raw.prompt_budget_bytes > MAX_CANONICAL_HANDOFF_BYTES
  )
    throw new Error("invalid handoff prompt budget");
  if (!DIGEST.test(raw.source.lock_digest)) throw new Error("invalid handoff source lock");
  const input = structuredClone(raw);
  input.topic = normalizeText(input.topic);
  input.policy_value = input.policy_value.normalize("NFC");
  input.bindings = input.bindings
    .map((binding) => ({
      ...binding,
      role_ref: binding.role_ref.normalize("NFC"),
      model: normalizeText(binding.model),
    }))
    .sort((left, right) => compareText(left.participant_id, right.participant_id));
  input.user_messages = uniqueSorted(
    input.user_messages.map((event) => ({ ...event, text: event.text.normalize("NFC") })),
  );
  input.final_responses = uniqueSorted(
    input.final_responses.map((event) => ({ ...event, text: event.text.normalize("NFC") })),
  );
  const mandatoryArtifactSelections = (input.mandatory_artifacts ?? [])
    .map(asSelection)
    .sort((left, right) => compareText(left.artifact.artifact_id, right.artifact.artifact_id));
  let artifactSelections = input.artifacts
    .map(asSelection)
    .sort((left, right) => compareText(left.artifact.artifact_id, right.artifact.artifact_id));
  const publicEvents = [...input.user_messages, ...input.final_responses].sort(eventOrder);
  const compaction = input.active_compaction ?? null;
  const compactionOrdinal = compaction
    ? publicEvents.find(
        (event) =>
          event.conversation_id === compaction.source.conversation_id &&
          event.revision_id === compaction.source.revision_id,
      )?.revision_ordinal
    : undefined;
  if (compaction && compactionOrdinal === undefined)
    throw new Error("active compaction source is outside the handoff inventory");
  const retainedByCompaction = new Set(compaction?.retained_event_ids ?? []);
  const afterCompaction = (event: PublicHandoffMessageV1 | PublicHandoffResponseV1) =>
    compactionOrdinal !== undefined &&
    (event.revision_ordinal > compactionOrdinal ||
      (event.revision_ordinal === compactionOrdinal &&
        event.public_seq > (compaction?.source.last_seq ?? -1)));
  if (compaction) {
    input.user_messages = input.user_messages.filter(
      (event) => afterCompaction(event) || retainedByCompaction.has(event.event_id),
    );
    input.final_responses = input.final_responses.filter(
      (event) => afterCompaction(event) || retainedByCompaction.has(event.event_id),
    );
    const retainedArtifacts = new Set(compaction.retained_artifact_ids);
    artifactSelections = artifactSelections.filter(({ artifact }) =>
      retainedArtifacts.has(artifact.artifact_id),
    );
  }
  const source_public_head_digest = handoffSourcePublicHeadDigest(input.source, publicEvents);
  const optional_groups = input.final_responses.map((event) => {
    const preimage = {
      schema_version: "1.0" as const,
      source_public_head_digest,
      anchor_revision_ordinal: event.revision_ordinal,
      anchor_public_seq: event.public_seq,
      anchor_event_id: event.event_id,
      event_ids: [event.event_id],
      artifact_ids: [] as string[],
    };
    return {
      group_id: `vf-handoff-group-${digestHex(
        digestV1("VF-HANDOFF-OPTIONAL-GROUP\0v1\0", preimage),
      )}`,
      ...preimage,
    };
  });
  const policy = buildPolicy(input.source, input.policy_value);
  let retainedResponses = [...input.final_responses];
  let projection: PromptHandoffProjectionV1;
  let bytes: Buffer;
  let selection_plan: HandoffSelectionPlanV1;
  let omitted_public_event_artifacts: OmittedPublicEventArtifactV1[];
  let retrySelection = true;
  do {
    const retainedIds = new Set([
      ...input.user_messages.map(({ event_id }) => event_id),
      ...retainedResponses.map(({ event_id }) => event_id),
    ]);
    omitted_public_event_artifacts = buildOmittedPublicEventRanges(
      input.final_responses,
      retainedIds,
    );
    const omissionSelections: PromptArtifactSelectionV1[] = omitted_public_event_artifacts.map(
      ({ range }) => ({
        artifact: structuredClone(range.artifact),
        delivery: "conversation-artifact-resolver",
        public_text: null,
      }),
    );
    const byArtifactId = new Map<string, PromptArtifactSelectionV1>();
    for (const selection of [
      ...mandatoryArtifactSelections,
      ...artifactSelections,
      ...(compaction?.omitted_public_ranges ?? []).map(({ artifact }) => ({
        artifact: structuredClone(artifact),
        delivery: "conversation-artifact-resolver" as const,
        public_text: null,
      })),
      ...omissionSelections,
    ]) {
      const prior = byArtifactId.get(selection.artifact.artifact_id);
      if (prior && !canonicalJsonBytes(prior).equals(canonicalJsonBytes(selection)))
        throw new Error("conflicting public handoff artifact id");
      byArtifactId.set(selection.artifact.artifact_id, selection);
    }
    const projectedArtifacts = [...byArtifactId.values()].sort((left, right) =>
      compareText(left.artifact.artifact_id, right.artifact.artifact_id),
    );
    const planPreimage = {
      schema_version: "1.0" as const,
      source_public_head_digest,
      active_compaction_digest: compaction?.content_digest ?? null,
      prompt_budget_bytes: input.prompt_budget_bytes,
      mandatory_artifact_ids: projectedArtifacts.map(({ artifact }) => artifact.artifact_id),
      optional_groups,
    };
    selection_plan = {
      ...planPreimage,
      selection_digest: digestV1("VF-HANDOFF-SELECTION-PLAN\0v1\0", planPreimage),
    };
    projection = {
      schema_version: "1.0",
      projection_profile: "vf-public-handoff/1",
      source: structuredClone(input.source),
      topic: input.topic,
      policy,
      bindings: structuredClone(input.bindings),
      transcript: {
        user_messages: structuredClone(input.user_messages),
        final_responses: structuredClone(retainedResponses),
        omitted_public_ranges: [
          ...structuredClone(compaction?.omitted_public_ranges ?? []),
          ...omitted_public_event_artifacts.map(({ range }) => structuredClone(range)),
        ].sort(
          (left, right) =>
            left.revision_ordinal - right.revision_ordinal ||
            left.first_public_seq - right.first_public_seq ||
            compareText(left.first_event_id, right.first_event_id),
        ),
      },
      compaction: structuredClone(compaction),
      consensus: {
        score: input.consensus.score,
        synthesis: normalizeText(input.consensus.synthesis),
      },
      artifacts: structuredClone(projectedArtifacts),
    };
    try {
      bytes = contextHandoffSharedPromptBytes(projection);
    } catch {
      bytes = contextHandoffRejectedPromptBytes(projection);
    }
    if (bytes.byteLength <= input.prompt_budget_bytes) retrySelection = false;
    else if (retainedResponses.length === 0)
      throw new HandoffTooLargeError(
        structuredClone(projection),
        structuredClone(selection_plan),
        Buffer.from(bytes),
        omitted_public_event_artifacts.map(({ range, bytes: artifactBytes }) => ({
          range: structuredClone(range),
          bytes: Buffer.from(artifactBytes),
        })),
      );
    else retainedResponses = retainedResponses.slice(1);
  } while (retrySelection);
  const prompt_projection_digest = contextHandoffPromptDigest(projection);
  const withoutIdentity: Omit<ContextHandoffV1, "handoff_id" | "digest"> = {
    schema_version: "1.0",
    projection_profile: "vf-public-handoff/1",
    source: structuredClone(projection.source),
    topic: projection.topic,
    policy: structuredClone(projection.policy),
    bindings: structuredClone(projection.bindings),
    transcript: structuredClone(projection.transcript),
    compaction: structuredClone(projection.compaction),
    consensus: structuredClone(projection.consensus),
    artifacts: projection.artifacts.map((item) => structuredClone(item.artifact)),
    handoff_selection_digest: selection_plan.selection_digest,
    prompt_projection: structuredClone(projection),
    prompt_projection_digest,
  };
  const digest = contextHandoffContentDigest(withoutIdentity);
  const handoff: ContextHandoffV1 = {
    ...withoutIdentity,
    handoff_id: `vf-handoff-${digestHex(digest)}`,
    digest,
  };
  return {
    input,
    handoff,
    selection_plan,
    shared_prompt_bytes: bytes,
    omitted_public_event_artifacts,
  };
}
