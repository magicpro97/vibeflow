import { canonicalJsonBytes } from "../../durability/index.js";
import {
  CONVERSATION_PRIVATE_FILE_RANGE_PROMPT,
  type ConversationTurnPrivateContextKind,
} from "./turn-delivery-contract.js";

export const PRIVATE_FILE_RANGE_PROMPT_PREFIX = CONVERSATION_PRIVATE_FILE_RANGE_PROMPT.PREFIX;

export interface PrivateFileRangePromptEntryV1 {
  delivery_kind: ConversationTurnPrivateContextKind;
  message_public_seq: number | null;
  repo_relative_path: string;
  start_line: number;
  end_line: number;
  line_count: number;
  content: string;
}

export function privateFileRangeTurnContextPrompt(
  entries: readonly PrivateFileRangePromptEntryV1[],
  maxBytes: number,
): string | null {
  if (!entries.length) return null;
  const envelope = {
    schema_version: CONVERSATION_PRIVATE_FILE_RANGE_PROMPT.SCHEMA_VERSION,
    kind: CONVERSATION_PRIVATE_FILE_RANGE_PROMPT.KIND,
    entries: entries.map((entry) => structuredClone(entry)),
  };
  const body = canonicalJsonBytes(envelope, {
    maxBytes: maxBytes - Buffer.byteLength(PRIVATE_FILE_RANGE_PROMPT_PREFIX, "utf8"),
  });
  return `${PRIVATE_FILE_RANGE_PROMPT_PREFIX}${body.toString("utf8")}`;
}
