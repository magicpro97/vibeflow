import { canonicalJsonBytes } from "../../durability/index.js";

export const PRIVATE_FILE_RANGE_PROMPT_PREFIX = "VF-PRIVATE-FILE-RANGES/1\n";

export interface PrivateFileRangePromptEntryV1 {
  delivery_kind: "conversation-create" | "user-message";
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
    schema_version: "1.0" as const,
    kind: "repo-file-ranges" as const,
    entries: entries.map((entry) => structuredClone(entry)),
  };
  const body = canonicalJsonBytes(envelope, {
    maxBytes: maxBytes - Buffer.byteLength(PRIVATE_FILE_RANGE_PROMPT_PREFIX, "utf8"),
  });
  return `${PRIVATE_FILE_RANGE_PROMPT_PREFIX}${body.toString("utf8")}`;
}
