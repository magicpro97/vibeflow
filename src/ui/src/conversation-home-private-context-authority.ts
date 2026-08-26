import type { HomePrivateContextPresence } from "./conversation-home-private-context-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertHomePrivateContextPresence(
  value: unknown,
  expected: boolean,
): asserts value is HomePrivateContextPresence {
  if (!isRecord(value)) throw new Error("Private context returned an invalid public projection.");
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "private_context_present" ||
    keys[1] !== "schema_version" ||
    value.schema_version !== "1.0" ||
    value.private_context_present !== expected
  )
    throw new Error("Private context returned an invalid public projection.");
}
