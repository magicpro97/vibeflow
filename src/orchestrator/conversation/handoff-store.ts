import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../../durability/index.js";
import {
  CONVERSATION_HANDOFF_OPTIONAL_GROUP_FIELDS,
  CONVERSATION_HANDOFF_SELECTION_PLAN_FIELDS,
  CONVERSATION_PUBLIC_ARTIFACT_KIND,
  CONVERSATION_PUBLIC_OMITTED_EVENTS_PAYLOAD_FIELDS,
  CONVERSATION_PUBLIC_SCHEMA_VERSION,
} from "./conversation-public-wire-contract.js";
import { MAX_CANONICAL_HANDOFF_BYTES, MAX_CONTEXT_HANDOFF_OBJECT_BYTES } from "./handoff-limits.js";
import {
  assertPublicEventRangesV1,
  compareHandoffText,
  hasExactHandoffKeys,
  isHandoffDigest,
  isHandoffRecord,
  isHandoffReference,
  validatePublicHandoffEventV1,
} from "./handoff-nested-validation.js";
import type { OmittedPublicEventArtifactV1, PublicHandoffEventV1 } from "./handoff-omission.js";
import {
  handoffOptionalGroupDigest,
  handoffSelectionPlanDigest,
} from "./handoff-selection-plan.js";
import type {
  ContextHandoffV1,
  HandoffOptionalGroupV1,
  HandoffSelectionPlanV1,
} from "./handoff-types.js";
import { assertContextHandoffV1 } from "./handoff-validation.js";

const MAX_OMISSION_BYTES = 1024 * 1024;

function decodeCanonical<T>(bytes: Buffer, validate: (value: unknown) => void): T {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  validate(value);
  if (!canonicalJsonBytes(value, { maxBytes: MAX_CONTEXT_HANDOFF_OBJECT_BYTES }).equals(bytes))
    throw new Error("non-canonical handoff object");
  return structuredClone(value) as T;
}

function isSortedUniqueReferences(values: unknown): values is string[] {
  return (
    Array.isArray(values) &&
    values.every(
      (value, index) =>
        isHandoffReference(value) &&
        (index === 0 || compareHandoffText(values[index - 1] as string, value) < 0),
    )
  );
}

function assertSelectionPlan(value: unknown): asserts value is HandoffSelectionPlanV1 {
  if (
    !isHandoffRecord(value) ||
    !hasExactHandoffKeys(value, CONVERSATION_HANDOFF_SELECTION_PLAN_FIELDS) ||
    value.schema_version !== CONVERSATION_PUBLIC_SCHEMA_VERSION ||
    !isHandoffDigest(value.source_public_head_digest) ||
    (value.active_compaction_digest !== null && !isHandoffDigest(value.active_compaction_digest)) ||
    !Number.isSafeInteger(value.prompt_budget_bytes) ||
    (value.prompt_budget_bytes as number) < 1 ||
    (value.prompt_budget_bytes as number) > MAX_CANONICAL_HANDOFF_BYTES ||
    !isSortedUniqueReferences(value.mandatory_artifact_ids) ||
    !Array.isArray(value.optional_groups) ||
    !isHandoffDigest(value.selection_digest)
  )
    throw new Error("invalid handoff selection plan");
  const plan = value as unknown as HandoffSelectionPlanV1;
  const memberEventIds = new Set<string>();
  const memberArtifactIds = new Set(plan.mandatory_artifact_ids);
  let prior: HandoffOptionalGroupV1 | undefined;
  for (const group of plan.optional_groups) {
    if (
      !isHandoffRecord(group) ||
      !hasExactHandoffKeys(group, CONVERSATION_HANDOFF_OPTIONAL_GROUP_FIELDS) ||
      group.schema_version !== CONVERSATION_PUBLIC_SCHEMA_VERSION ||
      group.source_public_head_digest !== plan.source_public_head_digest ||
      typeof group.group_id !== "string" ||
      !/^vf-handoff-group-[0-9a-f]{64}$/.test(group.group_id) ||
      !Number.isSafeInteger(group.anchor_revision_ordinal) ||
      group.anchor_revision_ordinal < 0 ||
      !Number.isSafeInteger(group.anchor_public_seq) ||
      group.anchor_public_seq < 1 ||
      !isHandoffReference(group.anchor_event_id) ||
      !isSortedUniqueReferences(group.event_ids) ||
      !isSortedUniqueReferences(group.artifact_ids) ||
      !group.event_ids.includes(group.anchor_event_id) ||
      group.event_ids.some((eventId) => memberEventIds.has(eventId)) ||
      group.artifact_ids.some((artifactId) => memberArtifactIds.has(artifactId)) ||
      (prior !== undefined &&
        (group.anchor_revision_ordinal < prior.anchor_revision_ordinal ||
          (group.anchor_revision_ordinal === prior.anchor_revision_ordinal &&
            (group.anchor_public_seq < prior.anchor_public_seq ||
              (group.anchor_public_seq === prior.anchor_public_seq &&
                compareHandoffText(group.anchor_event_id, prior.anchor_event_id) <= 0)))))
    )
      throw new Error("invalid handoff optional group");
    const { group_id: _groupId, ...preimage } = group;
    if (group.group_id !== `vf-handoff-group-${digestHex(handoffOptionalGroupDigest(preimage))}`)
      throw new Error("invalid handoff optional group digest");
    for (const eventId of group.event_ids) memberEventIds.add(eventId);
    for (const artifactId of group.artifact_ids) memberArtifactIds.add(artifactId);
    prior = group;
  }
  const { selection_digest: _selectionDigest, ...preimage } = plan;
  if (plan.selection_digest !== handoffSelectionPlanDigest(preimage))
    throw new Error("invalid handoff selection plan digest");
}

function assertOmissionArtifact({
  range,
  bytes,
}: OmittedPublicEventArtifactV1): PublicHandoffEventV1[] {
  assertPublicEventRangesV1([range], [range.artifact]);
  const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !isHandoffRecord(decoded) ||
    !hasExactHandoffKeys(decoded, CONVERSATION_PUBLIC_OMITTED_EVENTS_PAYLOAD_FIELDS) ||
    decoded.schema_version !== CONVERSATION_PUBLIC_SCHEMA_VERSION ||
    !Array.isArray(decoded.events) ||
    decoded.events.length === 0
  )
    throw new Error("invalid handoff omission artifact");
  const events = decoded.events.map(validatePublicHandoffEventV1);
  const first = events[0];
  const last = events.at(-1);
  if (
    !first ||
    !last ||
    events.length !== range.event_count ||
    first.event_id !== range.first_event_id ||
    last.event_id !== range.last_event_id ||
    new Set(events.map(({ event_id }) => event_id)).size !== events.length ||
    events.some(
      (event, index) =>
        event.revision_id !== range.revision_id ||
        event.revision_ordinal !== range.revision_ordinal ||
        event.public_seq !== range.first_public_seq + index,
    ) ||
    range.artifact.byte_length !== bytes.byteLength ||
    createHash("sha256").update(bytes).digest("hex") !== range.canonical_events_sha256 ||
    !canonicalJsonBytes(decoded).equals(bytes)
  )
    throw new Error("invalid handoff omission artifact");
  return events;
}

export class ContextHandoffStore {
  private readonly objects: string;
  private readonly selections: string;
  private readonly omissions: string;
  private readonly lock: string;

  constructor(options: { artifactRoot: string }) {
    const root = resolve(options.artifactRoot);
    this.objects = ensurePrivateDirectory(join(root, "objects", "v1"));
    this.selections = ensurePrivateDirectory(join(root, "handoffs", "v1", "selections"));
    this.omissions = ensurePrivateDirectory(join(root, "handoffs", "v1", "omissions"));
    this.lock = join(root, "handoff.writer.lock");
  }

  private objectPath(digest: string): string {
    if (!isHandoffDigest(digest)) throw new Error("invalid handoff digest");
    return join(this.objects, `${digestHex(digest)}.json`);
  }

  writeOmissions(values: readonly OmittedPublicEventArtifactV1[]): void {
    const lock = acquireProcessLock(this.lock, { operation: "handoff-omission-write" });
    try {
      for (const omission of values) {
        assertOmissionArtifact(omission);
        const { range, bytes } = omission;
        const reference = range.artifact;
        if (
          reference.artifact_kind !== CONVERSATION_PUBLIC_ARTIFACT_KIND.OMITTED_EVENTS ||
          reference.byte_length !== bytes.byteLength ||
          reference.content_sha256 !== range.canonical_events_sha256 ||
          createHash("sha256").update(bytes).digest("hex") !== reference.content_sha256 ||
          !canonicalJsonBytes(JSON.parse(bytes.toString("utf8"))).equals(bytes)
        )
          throw new Error("invalid handoff omission artifact");
        createOrVerifyPrivateFile(join(this.omissions, `${reference.content_sha256}.json`), bytes, {
          lock,
          maxBytes: MAX_OMISSION_BYTES,
        });
      }
    } finally {
      lock.release();
    }
  }

  readOmission(contentSha256: string): Buffer | null {
    if (!/^[0-9a-f]{64}$/.test(contentSha256)) throw new Error("invalid handoff omission digest");
    return privateFileBytes(join(this.omissions, `${contentSha256}.json`), MAX_OMISSION_BYTES);
  }

  write(
    handoff: ContextHandoffV1,
    selection: HandoffSelectionPlanV1,
    omissions: readonly OmittedPublicEventArtifactV1[] = [],
  ): void {
    assertContextHandoffV1(handoff);
    assertSelectionPlan(selection);
    if (selection.selection_digest !== handoff.handoff_selection_digest)
      throw new Error("handoff selection closure mismatch");
    if (selection.active_compaction_digest !== (handoff.compaction?.content_digest ?? null))
      throw new Error("handoff active compaction closure mismatch");
    const compactionOmissions = new Set(
      handoff.compaction?.omitted_public_ranges.map(({ artifact }) => artifact.artifact_id) ?? [],
    );
    const responseIds = new Set(handoff.transcript.final_responses.map(({ event_id }) => event_id));
    for (const omission of omissions)
      if (!compactionOmissions.has(omission.range.artifact.artifact_id))
        for (const event of assertOmissionArtifact(omission))
          if ("participant_id" in event) responseIds.add(event.event_id);
    const groupAnchors = new Set(
      selection.optional_groups.map(({ anchor_event_id }) => anchor_event_id),
    );
    if (
      groupAnchors.size !== responseIds.size ||
      [...groupAnchors].some((eventId) => !responseIds.has(eventId))
    )
      throw new Error("handoff optional group response closure mismatch");
    for (const { range } of omissions)
      if (
        !handoff.transcript.omitted_public_ranges.some(
          (candidate) =>
            canonicalJsonBytes(candidate).equals(canonicalJsonBytes(range)) &&
            handoff.artifacts.some(({ artifact_id }) => artifact_id === range.artifact.artifact_id),
        )
      )
        throw new Error("handoff omission is outside the selected projection");
    this.writeOmissions(omissions);
    const lock = acquireProcessLock(this.lock, { operation: "handoff-write" });
    try {
      createOrVerifyPrivateFile(this.objectPath(handoff.digest), canonicalJsonBytes(handoff), {
        lock,
        maxBytes: MAX_CONTEXT_HANDOFF_OBJECT_BYTES,
      });
      createOrVerifyPrivateFile(
        join(this.selections, `${digestHex(selection.selection_digest)}.json`),
        canonicalJsonBytes(selection),
        { lock, maxBytes: MAX_CONTEXT_HANDOFF_OBJECT_BYTES },
      );
    } finally {
      lock.release();
    }
  }

  read(digest: string): ContextHandoffV1 | null {
    const bytes = privateFileBytes(this.objectPath(digest), MAX_CONTEXT_HANDOFF_OBJECT_BYTES);
    if (bytes === null) return null;
    const value = decodeCanonical<ContextHandoffV1>(bytes, assertContextHandoffV1);
    if (value.digest !== digest) throw new Error("handoff storage key mismatch");
    return value;
  }
}
