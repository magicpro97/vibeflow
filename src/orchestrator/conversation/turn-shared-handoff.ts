import { canonicalJsonBytes } from "../../durability/index.js";
import { HANDOFF_PROMPT_PREFIX, MAX_CANONICAL_HANDOFF_BYTES } from "./handoff-limits.js";
import { isHandoffReference } from "./handoff-nested-validation.js";
import { contextHandoffSharedPromptBytes } from "./handoff-selection.js";
import type { PromptHandoffProjectionV1 } from "./handoff-types.js";
import { assertPromptHandoffProjectionV1 } from "./handoff-validation.js";

function parseCanonicalSharedHandoff(value: string): PromptHandoffProjectionV1 {
  if (
    !value.startsWith(HANDOFF_PROMPT_PREFIX) ||
    Buffer.byteLength(value, "utf8") > MAX_CANONICAL_HANDOFF_BYTES
  )
    throw new Error("shared handoff prompt authority is invalid");
  const body = Buffer.from(value.slice(HANDOFF_PROMPT_PREFIX.length), "utf8");
  let decoded: unknown;
  try {
    decoded = JSON.parse(body.toString("utf8"));
    assertPromptHandoffProjectionV1(decoded);
    if (
      !canonicalJsonBytes(decoded, {
        maxBytes: MAX_CANONICAL_HANDOFF_BYTES - Buffer.byteLength(HANDOFF_PROMPT_PREFIX, "utf8"),
      }).equals(body)
    )
      throw new Error("non-canonical shared handoff prompt");
  } catch {
    throw new Error("shared handoff prompt authority is invalid");
  }
  return decoded;
}

/**
 * Keeps shared user/peer provenance while recipient-owned responses remain in either
 * the exact native session or the bounded recipient-history projection, never both.
 */
export function recipientSafeSharedHandoff(value: string, recipientId: string): string {
  if (!isHandoffReference(recipientId))
    throw new Error("shared handoff recipient authority is invalid");
  const projection = parseCanonicalSharedHandoff(value);
  const peerResponses = projection.transcript.final_responses.filter(
    ({ participant_id }) => participant_id !== recipientId,
  );
  if (peerResponses.length === projection.transcript.final_responses.length) return value;
  const filtered: PromptHandoffProjectionV1 = {
    ...structuredClone(projection),
    transcript: {
      ...structuredClone(projection.transcript),
      final_responses: structuredClone(peerResponses),
    },
  };
  return contextHandoffSharedPromptBytes(filtered).toString("utf8");
}
