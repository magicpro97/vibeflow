import { timingSafeEqual } from "node:crypto";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../durability/index.js";
import {
  type ConversationCatalogSourceInventoryEntryV1,
  type ConversationSessionSummaryV1,
  assertConversationCatalogSourceInventoryEntryV1,
  assertConversationSessionSummaryV1,
} from "./catalog-types.js";
import { isLineageDigest, isMillisecondIsoDate, isSafeCatalogIdentifier } from "./lineage-types.js";

const GENERATION_ID = /^vf-catalog-generation-[0-9a-f]{64}$/;
export const MAX_CATALOG_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_CATALOG_DELTAS = 65_536;

export type ConversationCatalogDeltaCauseV1 =
  | "conversation-source-committed"
  | "lineage-head-committed"
  | "lineage-association-committed"
  | "projection-retry";

export interface ConversationCatalogDeltaV1 {
  schema_version: "1.0";
  sequence: number;
  previous_event_digest: string | null;
  root_session_id: string;
  cause: ConversationCatalogDeltaCauseV1;
  source_record: ConversationCatalogSourceInventoryEntryV1;
  source_inventory_digest: string;
  recorded_at: string;
  event_digest: string;
}

export interface ConversationCatalogGenerationV1 {
  schema_version: "1.0";
  generation_id: string;
  source_inventory_digest: string;
  source_watermark: string;
  starting_delta_sequence: number;
  applied_through_delta_sequence: number | null;
  rows: ConversationSessionSummaryV1[];
  created_at: string;
  content_digest: string;
}

export interface ConversationCatalogCurrentV1 {
  schema_version: "1.0";
  generation_id: string;
  generation_digest: string;
  source_watermark: string;
  applied_through_delta_sequence: number | null;
  updated_at: string;
  content_digest: string;
}

export interface PublishedConversationCatalogV1 {
  generation: ConversationCatalogGenerationV1;
  current: ConversationCatalogCurrentV1;
}

export class CatalogProjectionCorruptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CatalogProjectionCorruptError";
  }
}

const plain = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
  Object.getOwnPropertySymbols(value).length === 0;

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function sameCatalogCanonical(left: unknown, right: unknown): boolean {
  const a = canonicalJsonBytes(left);
  const b = canonicalJsonBytes(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function catalogDeltaDigest(
  value: Omit<ConversationCatalogDeltaV1, "event_digest">,
): string {
  return digestV1("VF-CONVERSATION-CATALOG-DELTA\0v1\0", value);
}

export function assertCatalogCausePair(
  delta: Pick<ConversationCatalogDeltaV1, "cause" | "source_record">,
): void {
  const kind = delta.source_record.source_kind;
  if (
    (delta.cause === "conversation-source-committed" &&
      kind !== "conversation-manifest" &&
      kind !== "conversation-journal-head") ||
    (delta.cause === "lineage-head-committed" && kind !== "lineage-head") ||
    (delta.cause === "lineage-association-committed" && kind !== "lineage-association")
  )
    throw new Error("catalog delta cause/source mismatch");
}

export function assertConversationCatalogDeltaV1(
  value: unknown,
): asserts value is ConversationCatalogDeltaV1 {
  if (
    !plain(value) ||
    !exact(value, [
      "cause",
      "event_digest",
      "previous_event_digest",
      "recorded_at",
      "root_session_id",
      "schema_version",
      "sequence",
      "source_inventory_digest",
      "source_record",
    ]) ||
    value.schema_version !== "1.0" ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    ![
      "conversation-source-committed",
      "lineage-head-committed",
      "lineage-association-committed",
      "projection-retry",
    ].includes(value.cause as string) ||
    !isSafeCatalogIdentifier(value.root_session_id) ||
    !isLineageDigest(value.source_inventory_digest) ||
    !isMillisecondIsoDate(value.recorded_at) ||
    !isLineageDigest(value.event_digest) ||
    (value.previous_event_digest !== null && !isLineageDigest(value.previous_event_digest))
  )
    throw new Error("invalid catalog delta");
  assertConversationCatalogSourceInventoryEntryV1(value.source_record);
  if (value.source_record.root_session_id !== value.root_session_id)
    throw new Error("catalog delta root mismatch");
  assertCatalogCausePair(value as unknown as ConversationCatalogDeltaV1);
  const { event_digest: _digest, ...preimage } = value;
  if (
    catalogDeltaDigest(preimage as Omit<ConversationCatalogDeltaV1, "event_digest">) !==
    value.event_digest
  )
    throw new Error("invalid catalog delta digest");
}

export function assertCatalogGeneration(
  value: unknown,
): asserts value is ConversationCatalogGenerationV1 {
  if (
    !plain(value) ||
    !exact(value, [
      "applied_through_delta_sequence",
      "content_digest",
      "created_at",
      "generation_id",
      "rows",
      "schema_version",
      "source_inventory_digest",
      "source_watermark",
      "starting_delta_sequence",
    ]) ||
    value.schema_version !== "1.0" ||
    typeof value.generation_id !== "string" ||
    !GENERATION_ID.test(value.generation_id) ||
    !isLineageDigest(value.source_inventory_digest) ||
    !isLineageDigest(value.source_watermark) ||
    !Number.isSafeInteger(value.starting_delta_sequence) ||
    (value.starting_delta_sequence as number) < 0 ||
    (value.applied_through_delta_sequence !== null &&
      (!Number.isSafeInteger(value.applied_through_delta_sequence) ||
        (value.applied_through_delta_sequence as number) <
          (value.starting_delta_sequence as number))) ||
    !Array.isArray(value.rows) ||
    !isMillisecondIsoDate(value.created_at) ||
    !isLineageDigest(value.content_digest)
  )
    throw new Error("invalid catalog generation");
  for (const row of value.rows) {
    assertConversationSessionSummaryV1(row);
    if (row.matched_revision !== null)
      throw new Error("stored catalog row contains a search match");
  }
  const { generation_id: _id, content_digest: _digest, ...preimage } = value;
  const expected = digestV1("VF-CONVERSATION-CATALOG-GENERATION\0v1\0", preimage);
  if (
    value.content_digest !== expected ||
    value.generation_id !== `vf-catalog-generation-${digestHex(expected)}`
  )
    throw new Error("invalid catalog generation digest");
}

export function assertCatalogCurrent(
  value: unknown,
): asserts value is ConversationCatalogCurrentV1 {
  if (
    !plain(value) ||
    !exact(value, [
      "applied_through_delta_sequence",
      "content_digest",
      "generation_digest",
      "generation_id",
      "schema_version",
      "source_watermark",
      "updated_at",
    ]) ||
    value.schema_version !== "1.0" ||
    typeof value.generation_id !== "string" ||
    !GENERATION_ID.test(value.generation_id) ||
    !isLineageDigest(value.generation_digest) ||
    !isLineageDigest(value.source_watermark) ||
    (value.applied_through_delta_sequence !== null &&
      (!Number.isSafeInteger(value.applied_through_delta_sequence) ||
        (value.applied_through_delta_sequence as number) < 0)) ||
    !isMillisecondIsoDate(value.updated_at) ||
    !isLineageDigest(value.content_digest)
  )
    throw new Error("invalid catalog current pointer");
  const { content_digest: _digest, ...preimage } = value;
  if (digestV1("VF-CONVERSATION-CATALOG-CURRENT\0v1\0", preimage) !== value.content_digest)
    throw new Error("invalid catalog current digest");
}

export function decodeCanonicalCatalog(
  bytes: Buffer,
  validator: (value: unknown) => void,
): unknown {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    validator(value);
    const canonical = canonicalJsonBytes(value, { maxBytes: MAX_CATALOG_FILE_BYTES });
    if (canonical.length !== bytes.length || !timingSafeEqual(canonical, bytes))
      throw new Error("non-canonical bytes");
  } catch (error) {
    throw new CatalogProjectionCorruptError("catalog projection is corrupt", { cause: error });
  }
  return value;
}
