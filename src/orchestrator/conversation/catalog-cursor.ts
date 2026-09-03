import { createHmac, timingSafeEqual } from "node:crypto";
import { PUBLIC_ERROR_CODE } from "../../actions/public-error-contract.js";
import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import type {
  CatalogCursorBindingV1,
  CatalogCursorBoundaryV1,
  CatalogCursorPayloadV1,
  CatalogCursorValidationV1,
  LineageCursorBindingV1,
  LineageCursorPayloadV1,
  LineageCursorPositionAuthorityV1,
  LineageCursorValidationV1,
} from "./catalog-cursor-contract.js";
import {
  type ConversationCatalogQueryV1,
  normalizeConversationCatalogQuery,
} from "./catalog-types.js";
import {
  CONVERSATION_CATALOG_SCHEMA_VERSION,
  CONVERSATION_CURSOR_ERROR_CODE,
  CONVERSATION_CURSOR_KIND,
  CONVERSATION_CURSOR_SORT,
  CONVERSATION_CURSOR_VALIDATION_STATUS,
  type ConversationCursorErrorCode,
} from "./conversation-catalog-contract.js";
import {
  isBoundedLineageReference,
  isMillisecondIsoDate,
  isSafeCatalogIdentifier,
} from "./lineage-types.js";

export type {
  CatalogCursorBindingV1,
  CatalogCursorBoundaryV1,
  CatalogCursorPayloadV1,
  CatalogCursorValidationV1,
  LineageCursorBindingV1,
  LineageCursorPayloadV1,
  LineageCursorPositionAuthorityV1,
  LineageCursorValidationV1,
} from "./catalog-cursor-contract.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GENERATION = /^vf-catalog-generation-[0-9a-f]{64}$/;
const MAX_CURSOR_BYTES = 16 * 1024;

export class CatalogCursorError extends Error {
  readonly code: ConversationCursorErrorCode | typeof PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION;

  constructor(code: CatalogCursorError["code"], message: string) {
    super(message);
    this.name = "CatalogCursorError";
    this.code = code;
  }
}

const invalidCursor = (message: string): CatalogCursorError =>
  new CatalogCursorError(CONVERSATION_CURSOR_ERROR_CODE.INVALID_CURSOR, message);

export class StaleCatalogCursorError extends Error {
  readonly code = PUBLIC_ERROR_CODE.STALE_CATALOG_CURSOR;

  constructor(
    readonly restart_cursor: string,
    readonly catalog_generation: string,
  ) {
    super("catalog cursor is stale");
    this.name = "StaleCatalogCursorError";
  }
}

export class FutureLineageCursorError extends Error {
  readonly code = PUBLIC_ERROR_CODE.FUTURE_EVENT_CURSOR;

  constructor(
    readonly current_last_revision_ordinal: number,
    readonly current_last_public_sequence: number,
  ) {
    super("lineage cursor is ahead of the current lineage boundary");
    this.name = "FutureLineageCursorError";
  }
}

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
    throw invalidCursor("invalid catalog cursor boundary");
}

function assertCatalogPayload(value: unknown): asserts value is CatalogCursorPayloadV1 {
  if (
    plain(value) &&
    typeof value.schema_version === "string" &&
    value.schema_version !== CONVERSATION_CATALOG_SCHEMA_VERSION
  )
    throw new CatalogCursorError(
      PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION,
      "unsupported cursor schema version",
    );
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
    value.schema_version !== CONVERSATION_CATALOG_SCHEMA_VERSION ||
    value.kind !== CONVERSATION_CURSOR_KIND.CATALOG ||
    !isBoundedLineageReference(value.scope_id) ||
    !validDigest(value.query_digest) ||
    !validDigest(value.filter_digest) ||
    value.sort !== CONVERSATION_CURSOR_SORT.UPDATED_DESC_ROOT_DESC ||
    typeof value.catalog_generation !== "string" ||
    !GENERATION.test(value.catalog_generation) ||
    !validDigest(value.source_watermark) ||
    !validDigest(value.catalog_head_digest)
  )
    throw invalidCursor("invalid catalog cursor payload");
  if (value.last !== null) assertBoundary(value.last);
}

function assertLineagePayload(value: unknown): asserts value is LineageCursorPayloadV1 {
  if (
    plain(value) &&
    typeof value.schema_version === "string" &&
    value.schema_version !== CONVERSATION_CATALOG_SCHEMA_VERSION
  )
    throw new CatalogCursorError(
      PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION,
      "unsupported cursor schema version",
    );
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
    value.schema_version !== CONVERSATION_CATALOG_SCHEMA_VERSION ||
    value.kind !== CONVERSATION_CURSOR_KIND.LINEAGE ||
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
    throw invalidCursor("invalid lineage cursor payload");
}

export function catalogQueryDigest(value: ConversationCatalogQueryV1 = {}): string {
  return digestV1("VF-CONVERSATION-CATALOG-QUERY\0v1\0", {
    schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
    ...normalizeConversationCatalogQuery(value),
  });
}

function unsignedCatalog(binding: CatalogCursorBindingV1): CatalogCursorPayloadV1 {
  return {
    schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
    kind: CONVERSATION_CURSOR_KIND.CATALOG,
    ...structuredClone(binding),
  };
}

function unsignedLineage(binding: LineageCursorBindingV1): LineageCursorPayloadV1 {
  return {
    schema_version: CONVERSATION_CATALOG_SCHEMA_VERSION,
    kind: CONVERSATION_CURSOR_KIND.LINEAGE,
    ...structuredClone(binding),
  };
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
      throw invalidCursor("invalid cursor encoding");
    const pieces = cursor.split(".");
    if (pieces.length !== 2 || !pieces[0] || !pieces[1])
      throw invalidCursor("invalid cursor encoding");
    let bytes: Buffer;
    let signature: Buffer;
    try {
      bytes = Buffer.from(pieces[0], "base64url");
      signature = Buffer.from(pieces[1], "base64url");
    } catch {
      throw invalidCursor("invalid cursor encoding");
    }
    if (
      bytes.toString("base64url") !== pieces[0] ||
      signature.toString("base64url") !== pieces[1] ||
      bytes.length > MAX_CURSOR_BYTES ||
      signature.length !== 32
    )
      throw invalidCursor("invalid cursor encoding");
    const expected = createHmac("sha256", this.key).update(bytes).digest();
    if (!timingSafeEqual(expected, signature)) throw invalidCursor("invalid cursor signature");
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw invalidCursor("invalid cursor payload");
    }
    let canonical: Buffer;
    try {
      canonical = canonicalJsonBytes(decoded, { maxBytes: MAX_CURSOR_BYTES });
    } catch {
      throw invalidCursor("invalid cursor payload");
    }
    if (bytes.length !== canonical.length || !timingSafeEqual(bytes, canonical))
      throw invalidCursor("non-canonical cursor payload");
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
      throw new CatalogCursorError(
        CONVERSATION_CURSOR_ERROR_CODE.BINDING_MISMATCH,
        "catalog cursor request changed",
      );
    if (
      decoded.catalog_generation !== current.catalog_generation ||
      decoded.source_watermark !== current.source_watermark ||
      decoded.catalog_head_digest !== current.catalog_head_digest
    ) {
      return {
        status: CONVERSATION_CURSOR_VALIDATION_STATUS.STALE,
        code: PUBLIC_ERROR_CODE.STALE_CATALOG_CURSOR,
        restart_cursor: this.encodeCatalog({ ...current, last: null }),
        catalog_generation: current.catalog_generation,
      };
    }
    return {
      status: CONVERSATION_CURSOR_VALIDATION_STATUS.VALID,
      value: structuredClone(decoded.last),
    };
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
      throw new CatalogCursorError(
        CONVERSATION_CURSOR_ERROR_CODE.BINDING_MISMATCH,
        "lineage cursor request changed",
      );
    if (decoded.head_digest !== current.head_digest || decoded.head_epoch !== current.head_epoch) {
      return {
        status: CONVERSATION_CURSOR_VALIDATION_STATUS.STALE,
        code: PUBLIC_ERROR_CODE.STALE_LINEAGE_CURSOR,
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
      status: CONVERSATION_CURSOR_VALIDATION_STATUS.VALID,
      value: {
        last_revision_ordinal: decoded.last_revision_ordinal,
        last_public_sequence: decoded.last_public_sequence,
      },
    };
  }
}
