import { ENGINES, type Engine } from "../../core/types.js";
import { isSafeNativeSessionId } from "../../dispatch/public-redaction.js";
import type { InternalResumeBinding } from "../../dispatch/session-types.js";

export interface PersistedResumeBinding extends InternalResumeBinding {
  participant_id: string;
  delivery_public_seq?: number;
  delivery_digest?: string;
  delivery_interaction_sequence?: number;
  delivery_interaction_digest?: string;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REF_BYTES = 4096;

function ref(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= REF_BYTES &&
    !/\p{Cc}/u.test(value)
  );
}

export function assertPersistedResumeBinding(
  value: unknown,
): asserts value is PersistedResumeBinding {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid manifest");
  const row = value as Record<string, unknown>;
  const observed = Object.keys(row).sort();
  const hasDelivery =
    Object.hasOwn(row, "delivery_public_seq") || Object.hasOwn(row, "delivery_digest");
  const hasInteraction =
    Object.hasOwn(row, "delivery_interaction_sequence") ||
    Object.hasOwn(row, "delivery_interaction_digest");
  const expected = (
    hasDelivery
      ? [
          "attemptId",
          "delivery_digest",
          ...(hasInteraction
            ? ["delivery_interaction_digest", "delivery_interaction_sequence"]
            : []),
          "delivery_public_seq",
          "engine",
          "nativeSessionId",
          "participant_id",
        ]
      : ["attemptId", "engine", "nativeSessionId", "participant_id"]
  ).sort();
  if (
    observed.length !== expected.length ||
    observed.some((key, index) => key !== expected[index]) ||
    !ref(row.participant_id) ||
    !ref(row.attemptId) ||
    !ENGINES.includes(row.engine as Engine) ||
    typeof row.nativeSessionId !== "string" ||
    !isSafeNativeSessionId(row.engine as Engine, row.nativeSessionId) ||
    (hasDelivery &&
      (!Number.isSafeInteger(row.delivery_public_seq) ||
        (row.delivery_public_seq as number) < 0 ||
        typeof row.delivery_digest !== "string" ||
        !DIGEST.test(row.delivery_digest) ||
        (hasInteraction &&
          (!Number.isSafeInteger(row.delivery_interaction_sequence) ||
            (row.delivery_interaction_sequence as number) < 0 ||
            typeof row.delivery_interaction_digest !== "string" ||
            !DIGEST.test(row.delivery_interaction_digest)))))
  )
    throw new Error("invalid manifest");
}
