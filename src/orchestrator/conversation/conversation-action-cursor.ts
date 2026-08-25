import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJsonBytes } from "../../durability/index.js";

const MAX_BYTES = 16 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface ConversationActionCursorTupleV1 {
  created_at: string;
  proposal_id: string;
}

export type ConversationActionCursorBindingV1 =
  | {
      kind: "pending-actions";
      conversation_id: string;
      authority_watermark: string;
      limit: number;
      last: ConversationActionCursorTupleV1 | null;
    }
  | {
      kind: "anchored-actions";
      conversation_id: string;
      revision_id: string;
      origin_event_id: string | null;
      proposal_set_watermark: string;
      limit: number;
      last: ConversationActionCursorTupleV1 | null;
    };

type Payload = ConversationActionCursorBindingV1 & { schema_version: "1.0" };

export class ConversationActionCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationActionCursorError";
  }
}

export class StaleConversationActionCursorError extends Error {
  constructor(
    readonly code: "stale_pending_proposal_cursor" | "stale_action_projection_cursor",
    readonly restart_cursor: string,
    readonly watermark: string,
  ) {
    super("conversation action cursor is stale");
    this.name = "StaleConversationActionCursorError";
  }
}

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertTuple(value: unknown): asserts value is ConversationActionCursorTupleV1 {
  if (
    !plain(value) ||
    !exact(value, ["created_at", "proposal_id"]) ||
    typeof value.created_at !== "string" ||
    Number.isNaN(Date.parse(value.created_at)) ||
    typeof value.proposal_id !== "string" ||
    !/^vf-proposal-[0-9a-f]{64}$/.test(value.proposal_id)
  )
    throw new ConversationActionCursorError("invalid action cursor tuple");
}

function assertCommon(value: Record<string, unknown>): void {
  if (
    value.schema_version !== "1.0" ||
    typeof value.conversation_id !== "string" ||
    !SAFE.test(value.conversation_id) ||
    !Number.isSafeInteger(value.limit) ||
    (value.limit as number) < 1 ||
    (value.limit as number) > 100
  )
    throw new ConversationActionCursorError("invalid action cursor payload");
  if (value.last !== null) assertTuple(value.last);
}

function assertPayload(value: unknown): asserts value is Payload {
  if (!plain(value)) throw new ConversationActionCursorError("invalid action cursor payload");
  if (value.kind === "pending-actions") {
    if (
      !exact(value, [
        "authority_watermark",
        "conversation_id",
        "kind",
        "last",
        "limit",
        "schema_version",
      ]) ||
      typeof value.authority_watermark !== "string" ||
      !DIGEST.test(value.authority_watermark)
    )
      throw new ConversationActionCursorError("invalid pending cursor payload");
  } else if (value.kind === "anchored-actions") {
    if (
      !exact(value, [
        "conversation_id",
        "kind",
        "last",
        "limit",
        "origin_event_id",
        "proposal_set_watermark",
        "revision_id",
        "schema_version",
      ]) ||
      typeof value.revision_id !== "string" ||
      !SAFE.test(value.revision_id) ||
      (value.origin_event_id !== null &&
        (typeof value.origin_event_id !== "string" || !SAFE.test(value.origin_event_id))) ||
      typeof value.proposal_set_watermark !== "string" ||
      !DIGEST.test(value.proposal_set_watermark)
    )
      throw new ConversationActionCursorError("invalid anchored cursor payload");
  } else throw new ConversationActionCursorError("invalid action cursor kind");
  assertCommon(value);
}

export class ConversationActionCursorCodec {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength < 32 || key.byteLength > 1024) throw new Error("invalid action cursor key");
    this.key = Buffer.from(key);
  }

  encode(binding: ConversationActionCursorBindingV1): string {
    const payload = { schema_version: "1.0" as const, ...structuredClone(binding) };
    assertPayload(payload);
    const bytes = canonicalJsonBytes(payload, { maxBytes: MAX_BYTES });
    return `${bytes.toString("base64url")}.${createHmac("sha256", this.key).update(bytes).digest("base64url")}`;
  }

  decode(cursor: string): Payload {
    const [body, signature, extra] = cursor.split(".");
    if (!body || !signature || extra || Buffer.byteLength(cursor) > MAX_BYTES)
      throw new ConversationActionCursorError("invalid action cursor encoding");
    const bytes = Buffer.from(body, "base64url");
    const observed = Buffer.from(signature, "base64url");
    const expected = createHmac("sha256", this.key).update(bytes).digest();
    if (
      bytes.toString("base64url") !== body ||
      observed.toString("base64url") !== signature ||
      observed.length !== expected.length ||
      !timingSafeEqual(observed, expected)
    )
      throw new ConversationActionCursorError("invalid action cursor signature");
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new ConversationActionCursorError("invalid action cursor JSON");
    }
    assertPayload(value);
    if (!canonicalJsonBytes(value, { maxBytes: MAX_BYTES }).equals(bytes))
      throw new ConversationActionCursorError("non-canonical action cursor");
    return structuredClone(value);
  }

  validate(cursor: string, current: ConversationActionCursorBindingV1) {
    const value = this.decode(cursor);
    const sameQuery =
      value.kind === current.kind &&
      value.conversation_id === current.conversation_id &&
      value.limit === current.limit &&
      (value.kind === "pending-actions" ||
        (current.kind === "anchored-actions" &&
          value.revision_id === current.revision_id &&
          value.origin_event_id === current.origin_event_id));
    if (!sameQuery) throw new ConversationActionCursorError("action cursor query changed");
    const stale =
      value.kind === "pending-actions" && current.kind === "pending-actions"
        ? value.authority_watermark !== current.authority_watermark
        : value.kind === "anchored-actions" && current.kind === "anchored-actions"
          ? value.proposal_set_watermark !== current.proposal_set_watermark
          : true;
    if (stale) {
      const pending = current.kind === "pending-actions";
      throw new StaleConversationActionCursorError(
        pending ? "stale_pending_proposal_cursor" : "stale_action_projection_cursor",
        this.encode({ ...current, last: null }),
        pending ? current.authority_watermark : current.proposal_set_watermark,
      );
    }
    return structuredClone(value.last);
  }
}
