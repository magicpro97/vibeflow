import { PUBLIC_ERROR_CODE } from "../../actions/public-error-contract.js";
import { parsePublicApiErrorBody } from "../../actions/public-error-wire-validation.js";
import {
  CONVERSATION_STREAM_RECOVERY_OUTCOME,
  isConversationSseErrorCode,
} from "../../orchestrator/conversation/conversation-sse-contract.js";
import { CONVERSATION_STREAM_ERROR_MESSAGE } from "./conversation-stream-error-contract.js";

export function createConversationStreamAttemptGuard() {
  let recoverable = true;
  return {
    acceptTypedError(raw: string) {
      try {
        const payload = parsePublicApiErrorBody(JSON.parse(raw));
        if (!isConversationSseErrorCode(payload.code))
          throw new Error(CONVERSATION_STREAM_ERROR_MESSAGE.ERROR_CODE_INVALID);
        const fatal = payload.code === PUBLIC_ERROR_CODE.NOT_FOUND;
        if (fatal) recoverable = false;
        return { fatal, message: payload.message };
      } catch {
        return { fatal: false, message: CONVERSATION_STREAM_ERROR_MESSAGE.FAILED };
      }
    },
    canRecover: () => recoverable,
  };
}

export async function recoverConversationStreamAttempt(
  attempt: ReturnType<typeof createConversationStreamAttemptGuard>,
  renew: () => Promise<boolean>,
  reconnect: () => void,
) {
  if (!attempt.canRecover()) return CONVERSATION_STREAM_RECOVERY_OUTCOME.TERMINAL;
  if (await renew()) return CONVERSATION_STREAM_RECOVERY_OUTCOME.RENEWED;
  if (!attempt.canRecover()) return CONVERSATION_STREAM_RECOVERY_OUTCOME.TERMINAL;
  reconnect();
  return CONVERSATION_STREAM_RECOVERY_OUTCOME.RECONNECTING;
}
