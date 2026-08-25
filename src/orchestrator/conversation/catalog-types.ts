import { ENGINES, type Engine } from "../../core/types.js";
import type { ConversationHealth, ConversationLifecycle } from "../trace/types.js";
import { isValidParticipantModel } from "../trace/validation.js";
import {
  assertListResponseInvariants,
  assertRevisionSummaryInvariants,
  assertSessionSummaryInvariants,
} from "./catalog-invariants.js";
export {
  projectPublicParticipantSummaries,
  safePublicRoleReference,
} from "./catalog-public.js";
import {
  type LineageNodeIdentityV1,
  assertLineageNodeIdentityV1,
  isBoundedLineageReference,
  isLineageAssociationId,
  isMillisecondIsoDate,
  isSafeCatalogIdentifier,
} from "./lineage-types.js";

export const CONVERSATION_CATALOG_SCHEMA_VERSION = "1.0" as const;
export const CONVERSATION_CATALOG_LIMITS = Object.freeze({
  maxPageSize: 100,
  maxQueryBytes: 256,
  maxTextBytes: 64 * 1024,
  maxParticipants: 64,
  maxAssociations: 512,
  maxCursorBytes: 16 * 1024,
});

export interface PublicParticipantSummaryV1 {
  participant_id: string;
  role_ref: string;
  engine: Engine;
  model: string | null;
}

export interface ConversationRevisionSummaryV1 {
  schema_version: typeof CONVERSATION_CATALOG_SCHEMA_VERSION;
  conversation_id: string;
  revision_id: string;
  revision_ordinal: number;
  parent_conversation_id: string | null;
  parent_revision_id: string | null;
  lineage_status: "verified" | "unverified";
  topic: string;
  policy: string;
  lifecycle: ConversationLifecycle;
  health: ConversationHealth;
  participants: PublicParticipantSummaryV1[];
  created_at: string;
  updated_at: string;
  last_seq: number;
  lock_digest: string;
}

export interface ConversationSessionSummaryV1 {
  schema_version: typeof CONVERSATION_CATALOG_SCHEMA_VERSION;
  root_session_id: string;
  head_status: "committed" | "ambiguous" | "unclaimed";
  root: ConversationRevisionSummaryV1;
  active_conversation_id: string | null;
  active_revision_id: string | null;
  active_revision_ordinal: number | null;
  revision_count: number;
  active: ConversationRevisionSummaryV1 | null;
  matched_revision: LineageNodeIdentityV1 | null;
  association_ids: string[];
  sort_updated_at: string;
  lineage_cursor: string;
}

export interface ConversationListResponseV1 {
  schema_version: typeof CONVERSATION_CATALOG_SCHEMA_VERSION;
  items: ConversationSessionSummaryV1[];
  next_cursor: string | null;
  catalog_generation: string;
  source_watermark: string;
  catalog_health: "ready" | "rebuilding" | "degraded";
}

export type PublicParticipantSummary = PublicParticipantSummaryV1;
export type ConversationRevisionSummary = ConversationRevisionSummaryV1;
export type ConversationSessionSummary = ConversationSessionSummaryV1;
export type ConversationListResponse = ConversationListResponseV1;

export interface ConversationCatalogSourceInventoryEntryV1 {
  source_kind:
    | "conversation-manifest"
    | "conversation-journal-head"
    | "lineage-head"
    | "lineage-association";
  root_session_id: string;
  record_id: string;
  record_digest: string;
}

export interface ConversationCatalogQueryV1 {
  query?: string;
  lifecycle?: ConversationLifecycle[];
  policy?: string[];
}

export interface NormalizedConversationCatalogQueryV1 {
  query: string;
  lifecycle: ConversationLifecycle[];
  policy: string[];
}

const LIFECYCLES: readonly ConversationLifecycle[] = [
  "INIT",
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "STOPPED",
  "FAILED",
  "ABORTED",
];
const HEALTH = new Set<ConversationHealth>(["healthy", "degraded"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GENERATION = /^vf-catalog-generation-[0-9a-f]{64}$/;

const isPlain = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
  Object.getOwnPropertySymbols(value).length === 0;

const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const hasUnsafeTextControl = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code !== 9 && code !== 10 && code !== 13 && (code < 32 || (code >= 127 && code <= 159));
  });

const boundedText = (
  value: unknown,
  max = CONVERSATION_CATALOG_LIMITS.maxTextBytes,
): value is string =>
  typeof value === "string" &&
  Buffer.byteLength(value, "utf8") <= max &&
  !hasUnsafeTextControl(value);

const nullableReference = (value: unknown): value is string | null =>
  value === null || isSafeCatalogIdentifier(value);

const sortedUnique = (values: readonly string[]): boolean =>
  values.every((item, index) => {
    const previous = values[index - 1];
    return previous === undefined || Buffer.compare(Buffer.from(previous), Buffer.from(item)) < 0;
  });

export function normalizeConversationCatalogQuery(
  value: ConversationCatalogQueryV1 = {},
): NormalizedConversationCatalogQueryV1 {
  if (
    !isPlain(value) ||
    Object.keys(value).some((key) => !["query", "lifecycle", "policy"].includes(key)) ||
    (value.query !== undefined && typeof value.query !== "string") ||
    (value.lifecycle !== undefined && !Array.isArray(value.lifecycle)) ||
    (value.policy !== undefined && !Array.isArray(value.policy))
  )
    throw new Error("invalid catalog query");
  const input = value as unknown as ConversationCatalogQueryV1;
  const query = (input.query ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (
    Buffer.byteLength(query, "utf8") > CONVERSATION_CATALOG_LIMITS.maxQueryBytes ||
    /\p{Cc}/u.test(query)
  )
    throw new Error("invalid catalog query");
  const lifecycle = [...new Set(input.lifecycle ?? [])].sort();
  if (lifecycle.some((item) => !LIFECYCLES.includes(item)))
    throw new Error("invalid lifecycle filter");
  if ((input.policy ?? []).some((item) => typeof item !== "string"))
    throw new Error("invalid policy filter");
  const policy = [...new Set(input.policy ?? [])].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  if (policy.length > 64 || policy.some((item) => !isBoundedLineageReference(item)))
    throw new Error("invalid policy filter");
  return { query, lifecycle, policy };
}

export function assertPublicParticipantSummaryV1(
  value: unknown,
): asserts value is PublicParticipantSummaryV1 {
  if (
    !isPlain(value) ||
    !exact(value, ["engine", "model", "participant_id", "role_ref"]) ||
    !isSafeCatalogIdentifier(value.participant_id) ||
    !isBoundedLineageReference(value.role_ref) ||
    !ENGINES.includes(value.engine as Engine) ||
    (value.model !== null && !isValidParticipantModel(value.model))
  )
    throw new Error("invalid public participant summary");
}

export function assertConversationCatalogSourceInventoryEntryV1(
  value: unknown,
): asserts value is ConversationCatalogSourceInventoryEntryV1 {
  if (
    !isPlain(value) ||
    !exact(value, ["record_digest", "record_id", "root_session_id", "source_kind"]) ||
    ![
      "conversation-manifest",
      "conversation-journal-head",
      "lineage-head",
      "lineage-association",
    ].includes(value.source_kind as string) ||
    !isSafeCatalogIdentifier(value.root_session_id) ||
    !isSafeCatalogIdentifier(value.record_id) ||
    typeof value.record_digest !== "string" ||
    !DIGEST.test(value.record_digest)
  )
    throw new Error("invalid conversation source inventory entry");
}

export function assertConversationRevisionSummaryV1(
  value: unknown,
): asserts value is ConversationRevisionSummaryV1 {
  if (
    !isPlain(value) ||
    !exact(value, [
      "conversation_id",
      "created_at",
      "health",
      "last_seq",
      "lifecycle",
      "lineage_status",
      "lock_digest",
      "parent_conversation_id",
      "parent_revision_id",
      "participants",
      "policy",
      "revision_id",
      "revision_ordinal",
      "schema_version",
      "topic",
      "updated_at",
    ]) ||
    value.schema_version !== CONVERSATION_CATALOG_SCHEMA_VERSION ||
    !isSafeCatalogIdentifier(value.conversation_id) ||
    !isSafeCatalogIdentifier(value.revision_id) ||
    !Number.isSafeInteger(value.revision_ordinal) ||
    (value.revision_ordinal as number) < 0 ||
    !nullableReference(value.parent_conversation_id) ||
    !nullableReference(value.parent_revision_id) ||
    !["verified", "unverified"].includes(value.lineage_status as string) ||
    !boundedText(value.topic) ||
    !isBoundedLineageReference(value.policy) ||
    !LIFECYCLES.includes(value.lifecycle as ConversationLifecycle) ||
    !HEALTH.has(value.health as ConversationHealth) ||
    !Array.isArray(value.participants) ||
    value.participants.length > CONVERSATION_CATALOG_LIMITS.maxParticipants ||
    !isMillisecondIsoDate(value.created_at) ||
    !isMillisecondIsoDate(value.updated_at) ||
    !Number.isSafeInteger(value.last_seq) ||
    (value.last_seq as number) < 0 ||
    typeof value.lock_digest !== "string" ||
    !DIGEST.test(value.lock_digest)
  )
    throw new Error("invalid conversation revision summary");
  for (const participant of value.participants) assertPublicParticipantSummaryV1(participant);
  if (
    (value.parent_conversation_id === null) !== (value.parent_revision_id === null) ||
    new Set(value.participants.map((item) => item.participant_id)).size !==
      value.participants.length
  )
    throw new Error("invalid conversation revision summary relationship");
  assertRevisionSummaryInvariants(value as unknown as ConversationRevisionSummaryV1);
}

export function assertConversationSessionSummaryV1(
  value: unknown,
): asserts value is ConversationSessionSummaryV1 {
  if (
    !isPlain(value) ||
    !exact(value, [
      "active",
      "active_conversation_id",
      "active_revision_id",
      "active_revision_ordinal",
      "association_ids",
      "head_status",
      "lineage_cursor",
      "matched_revision",
      "revision_count",
      "root",
      "root_session_id",
      "schema_version",
      "sort_updated_at",
    ]) ||
    value.schema_version !== CONVERSATION_CATALOG_SCHEMA_VERSION ||
    !isSafeCatalogIdentifier(value.root_session_id) ||
    !["committed", "ambiguous", "unclaimed"].includes(value.head_status as string) ||
    !nullableReference(value.active_conversation_id) ||
    !nullableReference(value.active_revision_id) ||
    (value.active_revision_ordinal !== null &&
      (!Number.isSafeInteger(value.active_revision_ordinal) ||
        (value.active_revision_ordinal as number) < 0)) ||
    !Number.isSafeInteger(value.revision_count) ||
    (value.revision_count as number) < 1 ||
    !Array.isArray(value.association_ids) ||
    value.association_ids.length > CONVERSATION_CATALOG_LIMITS.maxAssociations ||
    value.association_ids.some((item) => !isLineageAssociationId(item)) ||
    !sortedUnique(value.association_ids as string[]) ||
    !isMillisecondIsoDate(value.sort_updated_at) ||
    !boundedText(value.lineage_cursor, CONVERSATION_CATALOG_LIMITS.maxCursorBytes)
  )
    throw new Error("invalid conversation session summary");
  assertConversationRevisionSummaryV1(value.root);
  if (value.active !== null) assertConversationRevisionSummaryV1(value.active);
  if (value.matched_revision !== null) assertLineageNodeIdentityV1(value.matched_revision);
  const allNull =
    value.active === null &&
    value.active_conversation_id === null &&
    value.active_revision_id === null &&
    value.active_revision_ordinal === null;
  const allPresent =
    value.active !== null &&
    value.active_conversation_id === value.active.conversation_id &&
    value.active_revision_id === value.active.revision_id &&
    value.active_revision_ordinal === value.active.revision_ordinal;
  if (
    (value.head_status === "committed" && !allPresent) ||
    (value.head_status !== "committed" && !allNull)
  )
    throw new Error("invalid conversation session head projection");
  assertSessionSummaryInvariants(value as unknown as ConversationSessionSummaryV1);
}

export function assertConversationListResponseV1(
  value: unknown,
): asserts value is ConversationListResponseV1 {
  if (
    !isPlain(value) ||
    !exact(value, [
      "catalog_generation",
      "catalog_health",
      "items",
      "next_cursor",
      "schema_version",
      "source_watermark",
    ]) ||
    value.schema_version !== CONVERSATION_CATALOG_SCHEMA_VERSION ||
    !Array.isArray(value.items) ||
    value.items.length > CONVERSATION_CATALOG_LIMITS.maxPageSize ||
    (value.next_cursor !== null &&
      !boundedText(value.next_cursor, CONVERSATION_CATALOG_LIMITS.maxCursorBytes)) ||
    typeof value.catalog_generation !== "string" ||
    !GENERATION.test(value.catalog_generation) ||
    typeof value.source_watermark !== "string" ||
    !DIGEST.test(value.source_watermark) ||
    !["ready", "rebuilding", "degraded"].includes(value.catalog_health as string)
  )
    throw new Error("invalid conversation list response");
  for (const item of value.items) assertConversationSessionSummaryV1(item);
  assertListResponseInvariants(value as unknown as ConversationListResponseV1);
}
