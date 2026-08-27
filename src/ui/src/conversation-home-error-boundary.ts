import {
  PUBLIC_API_ERROR_CORRELATION_MAX_BYTES,
  PUBLIC_API_ERROR_ENVELOPE_FIELDS,
  PUBLIC_API_ERROR_FIELDS,
  PUBLIC_API_ERROR_MAX_BYTES,
  PUBLIC_API_ERROR_MESSAGE_MAX_BYTES,
} from "../../actions/public-error-contract.js";
import { parsePublicApiError } from "../../actions/public-error-wire-validation.js";
import {
  hasExactWireFields,
  isBoundedJsonWireValue,
  isBoundedWireText,
  isPlainWireRecord,
} from "../../actions/public-wire-primitives.js";
import {
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  isConversationMessageQueuePublicErrorCode,
} from "../../orchestrator/conversation/conversation-message-queue-contract.js";
import {
  isConversationMessageQueueErrorDetails,
  isConversationMessageQueueErrorMessage,
  isConversationMessageQueueErrorSemantic,
} from "../../orchestrator/conversation/conversation-message-queue-error-contract.js";
import type { HomeApiErrorBody } from "./conversation-home-types.js";

export const HOME_API_ERROR_CONTRACT = Object.freeze({
  PUBLIC: "public",
  MESSAGE_QUEUE: "message-queue",
} as const);

export type HomeApiErrorContract =
  (typeof HOME_API_ERROR_CONTRACT)[keyof typeof HOME_API_ERROR_CONTRACT];

function parseQueueApiError(value: unknown): HomeApiErrorBody {
  if (
    !isPlainWireRecord(value) ||
    !hasExactWireFields(value, PUBLIC_API_ERROR_ENVELOPE_FIELDS) ||
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    !isPlainWireRecord(value.error) ||
    !hasExactWireFields(value.error, PUBLIC_API_ERROR_FIELDS)
  )
    throw new Error("invalid conversation message queue error envelope");
  const error = value.error;
  if (
    !isConversationMessageQueuePublicErrorCode(error.code) ||
    !isBoundedWireText(error.message, { maxBytes: PUBLIC_API_ERROR_MESSAGE_MAX_BYTES }) ||
    !isBoundedWireText(error.correlation_id, {
      maxBytes: PUBLIC_API_ERROR_CORRELATION_MAX_BYTES,
      ascii: true,
    }) ||
    !isConversationMessageQueueErrorMessage(error.code, error.message) ||
    !isConversationMessageQueueErrorSemantic(error.code, error.retryable, error.recovery_action) ||
    !isConversationMessageQueueErrorDetails(error.code, error.details) ||
    !isBoundedJsonWireValue(value, PUBLIC_API_ERROR_MAX_BYTES)
  )
    throw new Error("invalid conversation message queue error body");
  return structuredClone(error) as unknown as HomeApiErrorBody;
}

export function parseHomeApiError(
  value: unknown,
  contract: HomeApiErrorContract,
): HomeApiErrorBody {
  if (contract === HOME_API_ERROR_CONTRACT.PUBLIC) return parsePublicApiError(value).error;
  if (contract === HOME_API_ERROR_CONTRACT.MESSAGE_QUEUE) return parseQueueApiError(value);
  throw new Error("unsupported Home API error contract");
}
