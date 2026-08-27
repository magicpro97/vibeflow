import { digestV1 } from "../../durability/index.js";
import { sanitizePublicText } from "../trace/public-sanitize.js";
import {
  CONVERSATION_HEAD_STATUS,
  type ConversationHeadStatus,
  isConversationHeadStatus,
} from "./conversation-catalog-contract.js";

export const LINEAGE_SCHEMA_VERSION = "1.0" as const;
export const LINEAGE_LIMITS = Object.freeze({
  maxReferenceBytes: 4 * 1024,
  maxCandidates: 512,
  maxNodes: 4096,
  maxDepth: 512,
});

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const LINEAGE_ASSOCIATION_ID = /^vf-lineage-association-[0-9a-f]{64}$/;

export type ConversationSourceDiagnosticCodeV1 =
  | "invalid-source-root"
  | "invalid-manifest-filename"
  | "invalid-manifest"
  | "unsupported-schema-version"
  | "missing-journal"
  | "invalid-journal"
  | "manifest-journal-mismatch"
  | "invalid-parent-pair"
  | "unlinked-parent"
  | "unpaired-child-claim"
  | "duplicate-revision-id"
  | "lineage-cycle"
  | "zero-eligible-leaves"
  | "invalid-lineage-head"
  | "invalid-lineage-association"
  | "invalid-published-revision"
  | "lineage-too-large";

export interface ConversationSourceDiagnosticV1 {
  schema_version: typeof LINEAGE_SCHEMA_VERSION;
  code: ConversationSourceDiagnosticCodeV1;
  source_kind: "inventory" | "conversation-manifest" | "conversation-journal" | "lineage";
  record_id: string | null;
  message: string;
  read_only: true;
}

export interface LineageNodeIdentityV1 {
  conversation_id: string;
  revision_id: string;
  revision_ordinal: number;
}

export interface LineageHeadRecordV1 {
  schema_version: typeof LINEAGE_SCHEMA_VERSION;
  root_session_id: string;
  head_status: ConversationHeadStatus;
  active: LineageNodeIdentityV1 | null;
  candidate_heads: LineageNodeIdentityV1[];
  head_epoch: number;
  previous_head_digest: string | null;
  updated_by_operation_id: string | null;
  updated_at: string;
  content_digest: string;
}

export interface InitialLineageLeafV1 {
  node: LineageNodeIdentityV1;
  manifest_digest: string;
  ancestry_digest: string;
  updated_at: string;
}

export const isPlainLineageRecord = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
  Object.getOwnPropertySymbols(value).length === 0;

export const hasExactLineageKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

export const isLineageDigest = (value: unknown): value is string =>
  typeof value === "string" && DIGEST.test(value);

export const isBoundedLineageReference = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value, "utf8") <= LINEAGE_LIMITS.maxReferenceBytes &&
  !/\p{Cc}/u.test(value);

export const isSafeCatalogIdentifier = (value: unknown): value is string =>
  isBoundedLineageReference(value) && sanitizePublicText(value, undefined, []) === value;

export const isLineageAssociationId = (value: unknown): value is string =>
  typeof value === "string" && LINEAGE_ASSOCIATION_ID.test(value);

export const isMillisecondIsoDate = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export function compareLineageNodes(
  left: LineageNodeIdentityV1,
  right: LineageNodeIdentityV1,
): number {
  return (
    left.revision_ordinal - right.revision_ordinal ||
    Buffer.compare(Buffer.from(left.conversation_id), Buffer.from(right.conversation_id)) ||
    Buffer.compare(Buffer.from(left.revision_id), Buffer.from(right.revision_id))
  );
}

export function assertLineageNodeIdentityV1(
  value: unknown,
): asserts value is LineageNodeIdentityV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, ["conversation_id", "revision_id", "revision_ordinal"]) ||
    !isSafeCatalogIdentifier(value.conversation_id) ||
    !isSafeCatalogIdentifier(value.revision_id) ||
    !Number.isSafeInteger(value.revision_ordinal) ||
    (value.revision_ordinal as number) < 0 ||
    (value.revision_ordinal as number) > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("invalid lineage node identity");
  }
}

function headPreimage(record: Omit<LineageHeadRecordV1, "content_digest">) {
  return record;
}

export function lineageHeadDigest(record: Omit<LineageHeadRecordV1, "content_digest">): string {
  return digestV1("VF-LINEAGE-HEAD\0v1\0", headPreimage(record));
}

export function assertLineageHeadRecordV1(value: unknown): asserts value is LineageHeadRecordV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, [
      "active",
      "candidate_heads",
      "content_digest",
      "head_epoch",
      "head_status",
      "previous_head_digest",
      "root_session_id",
      "schema_version",
      "updated_at",
      "updated_by_operation_id",
    ]) ||
    value.schema_version !== LINEAGE_SCHEMA_VERSION ||
    !isSafeCatalogIdentifier(value.root_session_id) ||
    !isConversationHeadStatus(value.head_status) ||
    !Array.isArray(value.candidate_heads) ||
    value.candidate_heads.length > LINEAGE_LIMITS.maxCandidates ||
    !Number.isSafeInteger(value.head_epoch) ||
    (value.head_epoch as number) < 0 ||
    (value.previous_head_digest !== null &&
      (typeof value.previous_head_digest !== "string" ||
        !DIGEST.test(value.previous_head_digest))) ||
    (value.updated_by_operation_id !== null &&
      !isBoundedLineageReference(value.updated_by_operation_id)) ||
    !isMillisecondIsoDate(value.updated_at) ||
    typeof value.content_digest !== "string" ||
    !DIGEST.test(value.content_digest)
  ) {
    throw new Error("invalid lineage head");
  }
  if (value.active !== null) assertLineageNodeIdentityV1(value.active);
  for (const candidate of value.candidate_heads) assertLineageNodeIdentityV1(candidate);
  const candidates = value.candidate_heads as LineageNodeIdentityV1[];
  if (
    candidates.some((item, index) => {
      const previous = candidates[index - 1];
      return previous !== undefined && compareLineageNodes(previous, item) >= 0;
    })
  ) {
    throw new Error("invalid lineage head candidate order");
  }
  if (
    (value.head_status === CONVERSATION_HEAD_STATUS.COMMITTED &&
      (value.active === null || candidates.length !== 0)) ||
    (value.head_status === CONVERSATION_HEAD_STATUS.AMBIGUOUS &&
      (value.active !== null || candidates.length < 2)) ||
    (value.head_status === CONVERSATION_HEAD_STATUS.UNCLAIMED &&
      (value.active !== null || candidates.length !== 1)) ||
    (value.head_epoch === 0 &&
      (value.previous_head_digest !== null || value.updated_by_operation_id !== null)) ||
    ((value.head_epoch as number) > 0 &&
      (value.previous_head_digest === null || value.updated_by_operation_id === null)) ||
    (value.head_status !== CONVERSATION_HEAD_STATUS.COMMITTED && value.head_epoch !== 0)
  ) {
    throw new Error("invalid lineage head state");
  }
  const { content_digest: _digest, ...preimage } = value;
  if (
    lineageHeadDigest(preimage as Omit<LineageHeadRecordV1, "content_digest">) !==
    value.content_digest
  )
    throw new Error("invalid lineage head digest");
}

export function createInitialLineageHead(
  rootSessionId: string,
  leaves: readonly InitialLineageLeafV1[],
): LineageHeadRecordV1 {
  if (!isSafeCatalogIdentifier(rootSessionId)) throw new Error("invalid lineage root");
  if (!leaves.length || leaves.length > LINEAGE_LIMITS.maxCandidates)
    throw new Error("lineage has no eligible leaves");
  const sorted = [...leaves].sort((left, right) => compareLineageNodes(left.node, right.node));
  for (const leaf of sorted) {
    assertLineageNodeIdentityV1(leaf.node);
    if (!DIGEST.test(leaf.manifest_digest) || !DIGEST.test(leaf.ancestry_digest))
      throw new Error("invalid lineage leaf digest");
    if (!isMillisecondIsoDate(leaf.updated_at)) throw new Error("invalid lineage leaf timestamp");
  }
  if (
    sorted.some((item, index) => {
      const previous = sorted[index - 1];
      return previous !== undefined && compareLineageNodes(previous.node, item.node) === 0;
    })
  )
    throw new Error("duplicate lineage leaf");
  const first = sorted[0];
  if (!first) throw new Error("lineage has no eligible leaves");
  const committed = sorted.length === 1;
  const preimage: Omit<LineageHeadRecordV1, "content_digest"> = {
    schema_version: LINEAGE_SCHEMA_VERSION,
    root_session_id: rootSessionId,
    head_status: committed
      ? CONVERSATION_HEAD_STATUS.COMMITTED
      : CONVERSATION_HEAD_STATUS.AMBIGUOUS,
    active: committed ? structuredClone(first.node) : null,
    candidate_heads: committed ? [] : sorted.map((item) => structuredClone(item.node)),
    head_epoch: 0,
    previous_head_digest: null,
    updated_by_operation_id: null,
    updated_at: sorted.reduce(
      (maximum, item) => (item.updated_at > maximum ? item.updated_at : maximum),
      first.updated_at,
    ),
  };
  return { ...preimage, content_digest: lineageHeadDigest(preimage) };
}

export function diagnostic(
  code: ConversationSourceDiagnosticCodeV1,
  sourceKind: ConversationSourceDiagnosticV1["source_kind"],
  recordId: string | null,
  message: string,
): ConversationSourceDiagnosticV1 {
  return {
    schema_version: LINEAGE_SCHEMA_VERSION,
    code,
    source_kind: sourceKind,
    record_id: recordId !== null && isSafeCatalogIdentifier(recordId) ? recordId : null,
    message,
    read_only: true,
  };
}

export function compareConversationDiagnostics(
  left: ConversationSourceDiagnosticV1,
  right: ConversationSourceDiagnosticV1,
): number {
  const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  return (
    compare(left.code, right.code) ||
    compare(left.record_id ?? "", right.record_id ?? "") ||
    compare(left.message, right.message)
  );
}
