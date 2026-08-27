import { createHash } from "node:crypto";
import type { InternalTraceStoreRecord } from "../trace/types.js";
import { assertPublicQuoteReferenceV1 } from "./conversation-interaction-validation.js";
import {
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
} from "./conversation-message-queue-contract.js";
import { CONVERSATION_TRACE_EVENT_KIND } from "./conversation-public-wire-contract.js";
import { assertPrivateFileRangeHandoffBindingV1 } from "./private-file-range-staging-store.js";
import type { MessageRequest } from "./types.js";

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function privateFileRangeAuthority(request: MessageRequest) {
  const privateFileRange = request.private_file_range;
  if (!privateFileRange) return undefined;
  assertPrivateFileRangeHandoffBindingV1(privateFileRange);
  return structuredClone(privateFileRange);
}

export const canonicalMessageRequest = (request: MessageRequest): MessageRequest => {
  if (
    typeof request.content !== "string" ||
    !request.content.trim() ||
    Buffer.byteLength(request.content, "utf8") > CONVERSATION_MESSAGE_QUEUE_LIMITS.maxContentBytes
  )
    throw new Error("invalid message content");
  const targets = request.target_participants;
  if (targets !== undefined && targets !== CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL) {
    if (
      !Array.isArray(targets) ||
      !targets.length ||
      targets.length > CONVERSATION_MESSAGE_QUEUE_LIMITS.maxTargets ||
      targets.some(
        (target) =>
          typeof target !== "string" ||
          !target ||
          Buffer.byteLength(target, "utf8") > CONVERSATION_MESSAGE_QUEUE_LIMITS.maxReferenceBytes,
      )
    )
      throw new Error("invalid target participants");
  }
  const quoteRefs = request.quote_refs;
  if (quoteRefs !== undefined) {
    if (
      !Array.isArray(quoteRefs) ||
      quoteRefs.length < 1 ||
      quoteRefs.length > CONVERSATION_MESSAGE_QUEUE_LIMITS.maxQuotes
    )
      throw new Error("invalid quote reference count");
    const seen = new Set<string>();
    for (const quote of quoteRefs) {
      assertPublicQuoteReferenceV1(quote);
      const key = `${quote.target_event_id}\0${quote.content_digest}`;
      if (seen.has(key)) throw new Error("duplicate quote reference");
      seen.add(key);
    }
  }
  const privateFileRange = privateFileRangeAuthority(request);
  return Object.freeze({
    content: request.content,
    target_participants:
      !targets || targets === CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL
        ? CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL
        : Object.freeze([...new Set(targets)].sort()),
    ...(quoteRefs ? { quote_refs: Object.freeze(structuredClone(quoteRefs)) } : {}),
    ...(privateFileRange ? { private_file_range: privateFileRange } : {}),
  }) as MessageRequest;
};

export const messageRevisionKey = (request: MessageRequest): string =>
  digest(
    (() => {
      const canonical = canonicalMessageRequest(request);
      return {
        content: canonical.content,
        target_participants: canonical.target_participants,
        quote_refs: canonical.quote_refs ?? [],
        private_file_range: canonical.private_file_range ?? null,
      };
    })(),
  );

export const conversationMessages = (
  records: readonly InternalTraceStoreRecord[],
): readonly MessageRequest[] =>
  Object.freeze(
    records
      .filter(
        ({ stored_event: stored }) =>
          stored.event.type === CONVERSATION_TRACE_EVENT_KIND.USER_MESSAGE,
      )
      .map(({ stored_event: stored }) =>
        canonicalMessageRequest(stored.event.payload as MessageRequest),
      ),
  );
