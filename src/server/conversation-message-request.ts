import { assertPublicQuoteReferenceV1 } from "../orchestrator/conversation/conversation-interaction-validation.js";
import { assertPrivateFileRangeHandoffBindingV1 } from "../orchestrator/conversation/private-file-range-staging-store.js";
import type { MessageRequest } from "../orchestrator/conversation/types.js";

const TEXT_LIMIT = 32 * 1024;
const SHORT_LIMIT = 256;
const PARTICIPANT_LIMIT = 64;

type JsonObject = Record<string, unknown>;

function exactKeys(value: JsonObject, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function boundedString(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= limit
  );
}

export function decodeConversationMessageRequest(body: JsonObject): MessageRequest | null {
  if (!exactKeys(body, ["content", "target_participants", "quote_refs", "private_file_range"]))
    return null;
  if (!boundedString(body.content, TEXT_LIMIT)) return null;
  const targets = body.target_participants;
  if (targets !== undefined && targets !== "all") {
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > PARTICIPANT_LIMIT)
      return null;
    if (
      targets.some((target) => !boundedString(target, SHORT_LIMIT)) ||
      new Set(targets).size !== targets.length
    )
      return null;
  }
  let quoteRefs: MessageRequest["quote_refs"];
  let privateFileRange: MessageRequest["private_file_range"];
  if (body.quote_refs !== undefined) {
    if (!Array.isArray(body.quote_refs) || body.quote_refs.length < 1 || body.quote_refs.length > 8)
      return null;
    quoteRefs = [];
    try {
      for (const quote of body.quote_refs) {
        assertPublicQuoteReferenceV1(quote);
        quoteRefs.push(structuredClone(quote));
      }
    } catch {
      return null;
    }
    if (
      new Set(quoteRefs.map((quote) => `${quote.target_event_id}\0${quote.content_digest}`))
        .size !== quoteRefs.length
    )
      return null;
  }
  if (body.private_file_range !== undefined) {
    try {
      assertPrivateFileRangeHandoffBindingV1(body.private_file_range);
      privateFileRange = structuredClone(body.private_file_range);
    } catch {
      return null;
    }
  }
  return {
    content: body.content,
    ...(targets === undefined ? {} : { target_participants: targets as string[] | "all" }),
    ...(quoteRefs ? { quote_refs: quoteRefs } : {}),
    ...(privateFileRange ? { private_file_range: privateFileRange } : {}),
  };
}
