import { expect, test } from "bun:test";
import {
  CONVERSATION_BASELINE_REASON,
  isConversationBaselineReason,
} from "../../src/orchestrator/conversation/conversation-baseline-contract.js";
import {
  CONVERSATION_COMMAND_TERMINAL_STATUS,
  isConversationCommandTerminalStatus,
} from "../../src/orchestrator/conversation/conversation-command-result-contract.js";
import {
  CONVERSATION_HUMAN_REACTION_REQUEST_MODE,
  isConversationHumanReactionRequestMode,
} from "../../src/orchestrator/conversation/conversation-interaction-contract.js";
import {
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND,
} from "../../src/orchestrator/conversation/conversation-message-queue-contract.js";
import { canonicalMessageRequest } from "../../src/orchestrator/conversation/conversation-message-request-authority.js";
import { serializeSseEmptyEvent } from "../../src/orchestrator/conversation/conversation-sse-contract.js";

test("closed conversation guards accept authority values and reject unknown values", () => {
  expect(isConversationBaselineReason(CONVERSATION_BASELINE_REASON.DISABLED)).toBeTrue();
  expect(isConversationBaselineReason("future-baseline-reason")).toBeFalse();
  expect(
    isConversationCommandTerminalStatus(CONVERSATION_COMMAND_TERMINAL_STATUS.COMPLETED),
  ).toBeTrue();
  expect(isConversationCommandTerminalStatus("accepted")).toBeFalse();
  expect(
    isConversationHumanReactionRequestMode(CONVERSATION_HUMAN_REACTION_REQUEST_MODE.TOGGLE_SELF),
  ).toBeTrue();
  expect(isConversationHumanReactionRequestMode("future-reaction-mode")).toBeFalse();
});

test("message request authority validates, freezes, and de-duplicates quote references", () => {
  const quote = {
    root_session_id: "root-session",
    conversation_id: "conversation",
    revision_id: "revision",
    target_event_id: "event-1",
    target_kind: CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND.USER_MESSAGE,
    content_digest: `sha256:${"a".repeat(64)}`,
    author_public_id: "human",
  };
  const request = { content: "follow up", quote_refs: [quote] };
  const canonical = canonicalMessageRequest(request);

  expect(canonical.quote_refs).toEqual([quote]);
  expect(Object.isFrozen(canonical.quote_refs)).toBeTrue();
  for (const quoteRefs of [
    {} as never,
    [] as never,
    Array.from({ length: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxQuotes + 1 }, () => quote),
  ]) {
    expect(() => canonicalMessageRequest({ content: "invalid", quote_refs: quoteRefs })).toThrow(
      "invalid quote reference count",
    );
  }
  expect(() =>
    canonicalMessageRequest({ content: "duplicate", quote_refs: [quote, { ...quote }] }),
  ).toThrow("duplicate quote reference");
});

test("empty SSE events retain framing, identifiers, and retry authority", () => {
  expect(serializeSseEmptyEvent("heartbeat", { id: "event-1", retryMilliseconds: 1_250 })).toBe(
    "id: event-1\nevent: heartbeat\ndata: \nretry: 1250\n\n",
  );
});
