import type {
  ConversationHomeCreateWireRequestV1,
  ConversationPrivateRangeSelectionV1,
  DiscardConversationDraftPrivateContextRequestV1,
  DiscardConversationMessagePrivateContextRequestV1,
  PublicConversationPrivateContextPresenceV1,
  StageConversationDraftPrivateContextRequestV1,
  StageConversationMessagePrivateContextRequestV1,
} from "../../orchestrator/conversation/conversation-private-context-broker-wire.js";
import type { CONVERSATION_PRIVATE_CONTEXT_EXPECTED_PRESENT } from "../../orchestrator/conversation/conversation-private-context-broker-wire.js";

export type HomePrivateContextPresence = PublicConversationPrivateContextPresenceV1;
export type HomePrivateRangeSelectionRequest = ConversationPrivateRangeSelectionV1;
export type HomeStageMessagePrivateContextRequest = StageConversationMessagePrivateContextRequestV1;
export type HomeDiscardMessagePrivateContextRequest =
  DiscardConversationMessagePrivateContextRequestV1;
export type HomeStageDraftPrivateContextRequest = StageConversationDraftPrivateContextRequestV1;
export type HomeDiscardDraftPrivateContextRequest = DiscardConversationDraftPrivateContextRequestV1;
export type HomeConversationCreateRequest = ConversationHomeCreateWireRequestV1;

export interface HomePrivateContextCapture {
  readonly idempotency_key: string;
  readonly private_context_present: typeof CONVERSATION_PRIVATE_CONTEXT_EXPECTED_PRESENT;
  clearIfCurrent(): void;
  restoreIfVacant(): boolean;
  discardRetained(): Promise<boolean>;
}
