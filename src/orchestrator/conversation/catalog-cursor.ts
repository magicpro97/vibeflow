import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import {
  type ConversationCatalogQueryV1,
  normalizeConversationCatalogQuery,
} from "./catalog-types.js";
import {
  isBoundedLineageReference,
  isMillisecondIsoDate,
  isSafeCatalogIdentifier,
} from "./lineage-types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GENERATION = /^vf-catalog-generation-[0-9a-f]{64}$/;
const MAX_CURSOR_BYTES = 16 * 1024;

export class CatalogCursorError extends Error {
  readonly code: "invalid_cursor" | "cursor_binding_mismatch" | "unsupported_schema_version";

  constructor(code: CatalogCursorError["code"], message: string) {
    super(message);
    this.name = "CatalogCursorError";
    this.code = code;
  }
}

export class StaleCatalogCursorError extends Error {
  readonly code = "stale_catalog_cursor" as const;

  constructor(
    readonly restart_cursor: string,
    readonly catalog_generation: string,
  ) {
    super("catalog cursor is stale");
    this.name = "StaleCatalogCursorError";
  }
}

export class FutureLineageCursorError extends Error {
  readonly code = "future_event_cursor" as const;

  constructor(
    readonly current_last_revision_ordinal: number,
    readonly current_last_public_sequence: number,
  ) {
    super("lineage cursor is ahead of the current lineage boundary");
    this.name = "FutureLineageCursorError";
  }
}

export interface CatalogCursorBoundaryV1 {
  sort_updated_at: string;
  root_session_id: string;
}

export interface CatalogCursorBindingV1 {
  scope_id: string;
  query_digest: string;
  filter_digest: string;
  sort: "updated-desc-root-desc";
  catalog_generation: string;
  source_watermark: string;
  catalog_head_digest: string;
  last: CatalogCursorBoundaryV1 | null;
}

export interface CatalogCursorPayloadV1 extends CatalogCursorBindingV1 {
  schema_version: "1.0";
  kind: "conversation-catalog";
}

export interface LineageCursorBindingV1 {
  scope_id: string;
  root_session_id: string;
  head_digest: string;
  head_epoch: number;
  last_revision_ordinal: number;
  last_public_sequence: number;
}

export type LineageCursorPositionAuthorityV1 = ReadonlyMap<number, number>;

export interface LineageCursorPayloadV1 extends LineageCursorBindingV1 {
  schema_version: "1.0";
  kind: "conversation-lineage";
}

export type CatalogCursorValidationV1 =
  | { status: "valid"; value: CatalogCursorBoundaryV1 | null }
  | {
      status: "stale";
      code: "stale_catalog_cursor";
      restart_cursor: string;
      catalog_generation: string;
    };

export type LineageCursorValidationV1 =
  | {
      status: "valid";
      value: { last_revision_ordinal: number; last_public_sequence: number };
    }
  | {
      status: "stale";
      code: "stale_lineage_cursor";
      restart_cursor: string;
      head_digest: string;
      head_epoch: number;
    };

const plain = (value: unknown): value is Record<string, unknown> =>
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

const validDigest = (value: unknown): value is string =>
  typeof value === "string" && DIGEST.test(value);

function assertBoundary(value: unknown): asserts value is CatalogCursorBoundaryV1 {
  if (
    !plain(value) ||
    !exact(value, ["root_session_id", "sort_updated_at"]) ||
    !isMillisecondIsoDate(value.sort_updated_at) ||
    !isSafeCatalogIdentifier(value.root_session_id)
  )
    throw new CatalogCursorError("invalid_cursor", "invalid catalog cursor boundary");
}

function assertCatalogPayload(value: unknown): asserts value is CatalogCursorPayloadV1 {
  if (plain(value) && typeof value.schema_version === "string" && value.schema_version !== "1.0")
    throw new CatalogCursorError("unsupported_schema_version", "unsupported cursor schema version");
  if (
    !plain(value) ||
    !exact(value, [
      "catalog_generation",
      "catalog_head_digest",
      "filter_digest",
      "kind",
      "last",
      "query_digest",
      "schema_version",
      "scope_id",
      "sort",
      "source_watermark",
    ]) ||
    value.schema_version !== "1.0" ||
    value.kind !== "conversation-catalog" ||
    !isBoundedLineageReference(value.scope_id) ||
    !validDigest(value.query_digest) ||
    !validDigest(value.filter_digest) ||
    value.sort !== "updated-desc-root-desc" ||
    typeof value.catalog_generation !== "string" ||
    !GENERATION.test(value.catalog_generation) ||
    !validDigest(value.source_watermark) ||
    !validDigest(value.catalog_head_digest)
  )
    throw new CatalogCursorError("invalid_cursor", "invalid catalog cursor payload");
  if (value.last !== null) assertBoundary(value.last);
}

function assertLineagePayload(value: unknown): asserts value is LineageCursorPayloadV1 {
  if (plain(value) && typeof value.schema_version === "string" && value.schema_version !== "1.0")
    throw new CatalogCursorError("unsupported_schema_version", "unsupported cursor schema version");
  if (
    !plain(value) ||
    !exact(value, [
      "head_digest",
      "head_epoch",
      "kind",
      "last_public_sequence",
      "last_revision_ordinal",
      "root_session_id",
      "schema_version",
      "scope_id",
    ]) ||
    value.schema_version !== "1.0" ||
    value.kind !== "conversation-lineage" ||
    !isBoundedLineageReference(value.scope_id) ||
    !isSafeCatalogIdentifier(value.root_session_id) ||
    !validDigest(value.head_digest) ||
    !Number.isSafeInteger(value.head_epoch) ||
    (value.head_epoch as number) < 0 ||
    !Number.isSafeInteger(value.last_revision_ordinal) ||
    (value.last_revision_ordinal as number) < 0 ||
    !Number.isSafeInteger(value.last_public_sequence) ||
    (value.last_public_sequence as number) < 0
  )
    throw new CatalogCursorError("invalid_cursor", "invalid lineage cursor payload");
}

export function catalogQueryDigest(value: ConversationCatalogQueryV1 = {}): string {
  return digestV1("VF-CONVERSATION-CATALOG-QUERY\0v1\0", {
    schema_version: "1.0",
    ...normalizeConversationCatalogQuery(value),
  });
}

function unsignedCatalog(binding: CatalogCursorBindingV1): CatalogCursorPayloadV1 {
  return { schema_version: "1.0", kind: "conversation-catalog", ...structuredClone(binding) };
}

function unsignedLineage(binding: LineageCursorBindingV1): LineageCursorPayloadV1 {
  return { schema_version: "1.0", kind: "conversation-lineage", ...structuredClone(binding) };
}

function assertLineagePositionAuthority(
  current: LineageCursorBindingV1,
  positions: LineageCursorPositionAuthorityV1,
): void {
  if (positions.size !== current.last_revision_ordinal + 1)
    throw new Error("invalid lineage cursor position authority");
  for (let ordinal = 0; ordinal <= current.last_revision_ordinal; ordinal += 1) {
    const bound = positions.get(ordinal);
    if (!Number.isSafeInteger(bound) || (bound as number) < 0)
      throw new Error("invalid lineage cursor position authority");
  }
  if (positions.get(current.last_revision_ordinal) !== current.last_public_sequence)
    throw new Error("lineage cursor boundary lacks exact position authority");
}

export class CatalogCursorCodec {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength < 32 || key.byteLength > 1024) throw new Error("invalid catalog cursor key");
    this.key = Buffer.from(key);
  }

  private encode(payload: CatalogCursorPayloadV1 | LineageCursorPayloadV1): string {
    const bytes = canonicalJsonBytes(payload, { maxBytes: MAX_CURSOR_BYTES });
    const signature = createHmac("sha256", this.key).update(bytes).digest();
    return `${bytes.toString("base64url")}.${signature.toString("base64url")}`;
  }

  private decode(cursor: string): unknown {
    if (
      typeof cursor !== "string" ||
      cursor.length < 3 ||
      Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES
    )
      throw new CatalogCursorError("invalid_cursor", "invalid cursor encoding");
    const pieces = cursor.split(".");
    if (pieces.length !== 2 || !pieces[0] || !pieces[1])
      throw new CatalogCursorError("invalid_cursor", "invalid cursor encoding");
    let bytes: Buffer;
    let signature: Buffer;
    try {
      bytes = Buffer.from(pieces[0], "base64url");
      signature = Buffer.from(pieces[1], "base64url");
    } catch {
      throw new CatalogCursorError("invalid_cursor", "invalid cursor encoding");
    }
    if (
      bytes.toString("base64url") !== pieces[0] ||
      signature.toString("base64url") !== pieces[1] ||
      bytes.length > MAX_CURSOR_BYTES ||
      signature.length !== 32
    )
      throw new CatalogCursorError("invalid_cursor", "invalid cursor encoding");
    const expected = createHmac("sha256", this.key).update(bytes).digest();
    if (!timingSafeEqual(expected, signature))
      throw new CatalogCursorError("invalid_cursor", "invalid cursor signature");
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new CatalogCursorError("invalid_cursor", "invalid cursor payload");
    }
    let canonical: Buffer;
    try {
      canonical = canonicalJsonBytes(decoded, { maxBytes: MAX_CURSOR_BYTES });
    } catch {
      throw new CatalogCursorError("invalid_cursor", "invalid cursor payload");
    }
    if (bytes.length !== canonical.length || !timingSafeEqual(bytes, canonical))
      throw new CatalogCursorError("invalid_cursor", "non-canonical cursor payload");
    return decoded;
  }

  encodeCatalog(binding: CatalogCursorBindingV1): string {
    const payload = unsignedCatalog(binding);
    assertCatalogPayload(payload);
    return this.encode(payload);
  }

  decodeCatalog(cursor: string): CatalogCursorPayloadV1 {
    const value = this.decode(cursor);
    assertCatalogPayload(value);
    return structuredClone(value);
  }

  validateCatalog(cursor: string, current: CatalogCursorBindingV1): CatalogCursorValidationV1 {
    const decoded = this.decodeCatalog(cursor);
    const requestBound =
      decoded.scope_id === current.scope_id &&
      decoded.query_digest === current.query_digest &&
      decoded.filter_digest === current.filter_digest &&
      decoded.sort === current.sort;
    if (!requestBound)
      throw new CatalogCursorError("cursor_binding_mismatch", "catalog cursor request changed");
    if (
      decoded.catalog_generation !== current.catalog_generation ||
      decoded.source_watermark !== current.source_watermark ||
      decoded.catalog_head_digest !== current.catalog_head_digest
    ) {
      return {
        status: "stale",
        code: "stale_catalog_cursor",
        restart_cursor: this.encodeCatalog({ ...current, last: null }),
        catalog_generation: current.catalog_generation,
      };
    }
    return { status: "valid", value: structuredClone(decoded.last) };
  }

  encodeLineage(binding: LineageCursorBindingV1): string {
    const payload = unsignedLineage(binding);
    assertLineagePayload(payload);
    return this.encode(payload);
  }

  decodeLineage(cursor: string): LineageCursorPayloadV1 {
    const value = this.decode(cursor);
    assertLineagePayload(value);
    return structuredClone(value);
  }

  validateLineage(
    cursor: string,
    current: LineageCursorBindingV1,
    positions: LineageCursorPositionAuthorityV1,
  ): LineageCursorValidationV1 {
    const decoded = this.decodeLineage(cursor);
    if (
      decoded.scope_id !== current.scope_id ||
      decoded.root_session_id !== current.root_session_id
    )
      throw new CatalogCursorError("cursor_binding_mismatch", "lineage cursor request changed");
    if (decoded.head_digest !== current.head_digest || decoded.head_epoch !== current.head_epoch) {
      return {
        status: "stale",
        code: "stale_lineage_cursor",
        restart_cursor: this.encodeLineage({
          ...current,
          last_revision_ordinal: 0,
          last_public_sequence: 0,
        }),
        head_digest: current.head_digest,
        head_epoch: current.head_epoch,
      };
    }
    assertLineagePositionAuthority(current, positions);
    const exactRevisionBound = positions.get(decoded.last_revision_ordinal);
    if (exactRevisionBound === undefined || decoded.last_public_sequence > exactRevisionBound)
      throw new FutureLineageCursorError(
        current.last_revision_ordinal,
        current.last_public_sequence,
      );
    return {
      status: "valid",
      value: {
        last_revision_ordinal: decoded.last_revision_ordinal,
        last_public_sequence: decoded.last_public_sequence,
      },
    };
  }
}
