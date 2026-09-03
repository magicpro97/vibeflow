import {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
} from "../../orchestrator/conversation/conversation-private-context-broker-wire.js";
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
  const expectedKeys = [...CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.PUBLIC_PRESENCE].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    value.schema_version !== CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION ||
    value.private_context_present !== expected
  )
    throw new Error("Private context returned an invalid public projection.");
}
