import { parseStrictJson } from "../../actions/strict-json.js";
import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import { CapabilityRuntimeError } from "../operations/errors.js";

interface CapabilityCursorV1 {
  schema_version: "1.0";
  source_watermark: string;
  normalized_query: string;
  offset: number;
  cursor_digest: string;
}

function cursorDigest(value: CapabilityCursorV1): string {
  const { cursor_digest: _, ...preimage } = value;
  return digestV1("VF-CAPABILITY-QUERY-CURSOR\0v1\0", preimage);
}

export function encodeCapabilityCursor(value: Omit<CapabilityCursorV1, "cursor_digest">): string {
  const cursor = { ...value, cursor_digest: "" };
  cursor.cursor_digest = cursorDigest(cursor);
  return Buffer.from(canonicalJsonBytes(cursor)).toString("base64url");
}

export function decodeCapabilityCursor(raw: string): CapabilityCursorV1 {
  let value: CapabilityCursorV1;
  try {
    value = parseStrictJson(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as unknown as CapabilityCursorV1;
  } catch {
    throw new CapabilityCursorErrorV1();
  }
  if (
    value.schema_version !== "1.0" ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    value.cursor_digest !== cursorDigest(value)
  )
    throw new CapabilityCursorErrorV1();
  return value;
}

export class CapabilityCursorErrorV1 extends CapabilityRuntimeError {
  constructor() {
    super("invalid capability cursor", "integrity-failure");
    this.name = "CapabilityCursorErrorV1";
  }
}

export class StaleCapabilityCursorErrorV1 extends CapabilityRuntimeError {
  constructor(
    readonly restart_cursor: string,
    readonly source_watermark: string,
  ) {
    super("stale capability cursor; restart pagination", "scope-base-stale");
    this.name = "StaleCapabilityCursorErrorV1";
  }
}
