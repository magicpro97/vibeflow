import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJsonBytes } from "../../durability/index.js";
import { CatalogCursorError } from "./catalog-cursor.js";
import type { LineageNodeIdentityV1 } from "./lineage-types.js";
import {
  assertLineageNodeIdentityV1,
  isLineageDigest,
  isSafeCatalogIdentifier,
} from "./lineage-types.js";

const MAX_CURSOR_BYTES = 16 * 1024;

export interface TimelineCursorTupleV1 {
  revision_ordinal: number;
  item_kind_order: 0 | 1 | 2;
  public_sequence: number;
  item_id: string;
}

interface TimelineCursorPayloadV1 {
  schema_version: "1.0";
  kind: "conversation-timeline";
  scope_id: string;
  root_session_id: string;
  head_digest: string;
  head_epoch: number;
  limit: number;
  last: TimelineCursorTupleV1 | null;
}

export interface TimelineCursorBindingV1 {
  scope_id: string;
  root_session_id: string;
  head: LineageNodeIdentityV1;
  head_digest: string;
  head_epoch: number;
  limit: number;
  last: TimelineCursorTupleV1 | null;
}

export class StaleTimelineCursorError extends Error {
  readonly code = "stale_timeline_cursor" as const;
  constructor(
    readonly restart_cursor: string,
    readonly head: LineageNodeIdentityV1,
    readonly head_digest: string,
    readonly head_epoch: number,
  ) {
    super("timeline cursor is stale");
    this.name = "StaleTimelineCursorError";
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

function assertTuple(value: unknown): asserts value is TimelineCursorTupleV1 {
  if (
    !plain(value) ||
    !exact(value, ["item_id", "item_kind_order", "public_sequence", "revision_ordinal"]) ||
    !Number.isSafeInteger(value.revision_ordinal) ||
    (value.revision_ordinal as number) < 0 ||
    ![0, 1, 2].includes(value.item_kind_order as number) ||
    !Number.isSafeInteger(value.public_sequence) ||
    (value.public_sequence as number) < 0 ||
    !isSafeCatalogIdentifier(value.item_id)
  )
    throw new CatalogCursorError("invalid_cursor", "invalid timeline cursor tuple");
}

function assertPayload(value: unknown): asserts value is TimelineCursorPayloadV1 {
  if (plain(value) && typeof value.schema_version === "string" && value.schema_version !== "1.0")
    throw new CatalogCursorError("unsupported_schema_version", "unsupported cursor schema version");
  if (
    !plain(value) ||
    !exact(value, [
      "head_digest",
      "head_epoch",
      "kind",
      "last",
      "limit",
      "root_session_id",
      "schema_version",
      "scope_id",
    ]) ||
    value.schema_version !== "1.0" ||
    value.kind !== "conversation-timeline" ||
    !isSafeCatalogIdentifier(value.scope_id) ||
    !isSafeCatalogIdentifier(value.root_session_id) ||
    !isLineageDigest(value.head_digest) ||
    !Number.isSafeInteger(value.head_epoch) ||
    (value.head_epoch as number) < 0 ||
    !Number.isSafeInteger(value.limit) ||
    (value.limit as number) < 1 ||
    (value.limit as number) > 100
  )
    throw new CatalogCursorError("invalid_cursor", "invalid timeline cursor payload");
  if (value.last !== null) assertTuple(value.last);
}

export class TimelineCursorCodec {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength < 32 || key.byteLength > 1024)
      throw new Error("invalid timeline cursor key");
    this.key = Buffer.from(key);
  }

  private encodePayload(payload: TimelineCursorPayloadV1): string {
    assertPayload(payload);
    const bytes = canonicalJsonBytes(payload, { maxBytes: MAX_CURSOR_BYTES });
    const signature = createHmac("sha256", this.key).update(bytes).digest();
    return `${bytes.toString("base64url")}.${signature.toString("base64url")}`;
  }

  encode(binding: TimelineCursorBindingV1): string {
    assertLineageNodeIdentityV1(binding.head);
    return this.encodePayload({
      schema_version: "1.0",
      kind: "conversation-timeline",
      scope_id: binding.scope_id,
      root_session_id: binding.root_session_id,
      head_digest: binding.head_digest,
      head_epoch: binding.head_epoch,
      limit: binding.limit,
      last: structuredClone(binding.last),
    });
  }

  private decode(cursor: string): TimelineCursorPayloadV1 {
    if (typeof cursor !== "string" || Buffer.byteLength(cursor) > MAX_CURSOR_BYTES)
      throw new CatalogCursorError("invalid_cursor", "invalid timeline cursor encoding");
    const pieces = cursor.split(".");
    if (pieces.length !== 2 || !pieces[0] || !pieces[1])
      throw new CatalogCursorError("invalid_cursor", "invalid timeline cursor encoding");
    let bytes: Buffer;
    let signature: Buffer;
    try {
      bytes = Buffer.from(pieces[0], "base64url");
      signature = Buffer.from(pieces[1], "base64url");
    } catch {
      throw new CatalogCursorError("invalid_cursor", "invalid timeline cursor encoding");
    }
    if (
      bytes.toString("base64url") !== pieces[0] ||
      signature.toString("base64url") !== pieces[1] ||
      signature.length !== 32 ||
      !timingSafeEqual(signature, createHmac("sha256", this.key).update(bytes).digest())
    )
      throw new CatalogCursorError("invalid_cursor", "invalid timeline cursor signature");
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const canonical = canonicalJsonBytes(value, { maxBytes: MAX_CURSOR_BYTES });
      if (canonical.length !== bytes.length || !timingSafeEqual(canonical, bytes))
        throw new Error("non-canonical cursor");
    } catch {
      throw new CatalogCursorError("invalid_cursor", "invalid timeline cursor payload");
    }
    assertPayload(value);
    return value;
  }

  validate(cursor: string, current: TimelineCursorBindingV1): TimelineCursorTupleV1 | null {
    const decoded = this.decode(cursor);
    if (
      decoded.scope_id !== current.scope_id ||
      decoded.root_session_id !== current.root_session_id ||
      decoded.limit !== current.limit
    )
      throw new CatalogCursorError("cursor_binding_mismatch", "timeline cursor request changed");
    if (decoded.head_digest !== current.head_digest || decoded.head_epoch !== current.head_epoch)
      throw new StaleTimelineCursorError(
        this.encode({ ...current, last: null }),
        structuredClone(current.head),
        current.head_digest,
        current.head_epoch,
      );
    return structuredClone(decoded.last);
  }
}
