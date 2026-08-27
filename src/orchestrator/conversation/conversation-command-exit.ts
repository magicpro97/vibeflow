import type { PublicStoredTraceEvent } from "../trace/types.js";
import {
  CONVERSATION_COMMAND_RESULT_STATUS,
  CONVERSATION_COMMAND_SUCCESS_STATUS,
  type ConversationCommandResultStatus,
} from "./conversation-command-result-contract.js";
import { CONVERSATION_TRACE_EVENT_KIND } from "./conversation-public-wire-contract.js";

export type { ConversationCommandResultStatus } from "./conversation-command-result-contract.js";

export const CONVERSATION_EXIT = Object.freeze({
  ok: 0,
  validation: 1,
  engineStart: 2,
  transport: 3,
  failed: 4,
  aborted: 5,
});

const START_ERROR_HINTS = /no ready admitted engine|explicit_engine_unavailable|unsupported engine/;
const TRANSPORT_ERROR_HINTS = /conversation not found|configure failed|persistence failed/;
const VALIDATION_ERROR_HINTS =
  /invalid|unknown explicit|unsupported engine|missing --max-rounds|participant/;
const JSON_ERROR_CODES: Readonly<Record<number, string>> = Object.freeze({
  [CONVERSATION_EXIT.validation]: "validation_error",
  [CONVERSATION_EXIT.engineStart]: "engine_start_error",
  [CONVERSATION_EXIT.transport]: "transport_error",
  [CONVERSATION_EXIT.failed]: "conversation_failed",
  [CONVERSATION_EXIT.aborted]: "conversation_aborted",
});

export function classifyConversationError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (VALIDATION_ERROR_HINTS.test(lower)) return CONVERSATION_EXIT.validation;
  if (START_ERROR_HINTS.test(lower)) return CONVERSATION_EXIT.engineStart;
  if (TRANSPORT_ERROR_HINTS.test(lower)) return CONVERSATION_EXIT.transport;
  return CONVERSATION_EXIT.failed;
}

export function classifyConversationResult(
  status: ConversationCommandResultStatus,
  events: readonly PublicStoredTraceEvent[],
): number {
  if (
    status === CONVERSATION_COMMAND_SUCCESS_STATUS.COMPLETED ||
    status === CONVERSATION_COMMAND_SUCCESS_STATUS.ACCEPTED ||
    status === CONVERSATION_COMMAND_SUCCESS_STATUS.AWAITING_APPROVAL ||
    status === CONVERSATION_COMMAND_SUCCESS_STATUS.STOPPED
  )
    return CONVERSATION_EXIT.ok;
  if (status === CONVERSATION_COMMAND_RESULT_STATUS.ABORTED) return CONVERSATION_EXIT.aborted;
  const errorCodes = events.flatMap((event) =>
    event.event.type === CONVERSATION_TRACE_EVENT_KIND.ERROR && "code" in event.event.payload
      ? [String(event.event.payload.code).toLowerCase()]
      : [],
  );
  if (errorCodes.some((code) => code.includes("start") || code.includes("unavailable")))
    return CONVERSATION_EXIT.engineStart;
  if (errorCodes.some((code) => code.includes("transport"))) return CONVERSATION_EXIT.transport;
  return CONVERSATION_EXIT.failed;
}

export function conversationJsonErrorCode(exit: number): string {
  return JSON_ERROR_CODES[exit] ?? "conversation_failed";
}
