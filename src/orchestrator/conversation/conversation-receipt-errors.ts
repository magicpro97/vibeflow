import type { ConversationReceiptActionKindV1 } from "./conversation-action-receipt-store.js";

export class ConversationReceiptCandidateUnavailableError extends Error {
  constructor(readonly action_type: ConversationReceiptActionKindV1) {
    super(`The durable ${action_type} candidate is unavailable or expired.`);
    this.name = "ConversationReceiptCandidateUnavailableError";
  }
}
