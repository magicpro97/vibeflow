import { queueExactKeys, queueRecord } from "./conversation-message-queue-validation.js";
import {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS,
  CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD,
  type ConversationPrivateRangesSelectionV2,
} from "./conversation-private-context-broker-contract.js";

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.normalize("NFC") === value &&
    Buffer.byteLength(value, "utf8") >=
      CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.minRepoRelativePathBytes &&
    Buffer.byteLength(value, "utf8") <=
      CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRepoRelativePathBytes &&
    !/[\\\0]/u.test(value) &&
    !value.startsWith("/") &&
    !value.startsWith("~") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function validRange(start: unknown, end: unknown): start is number {
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    (start as number) >= CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.minFileLine &&
    (end as number) >= (start as number) &&
    (end as number) - (start as number) + 1 <=
      CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxFileRangeLines
  );
}

export function assertConversationPrivateRangesV2(
  value: unknown,
): asserts value is ConversationPrivateRangesSelectionV2 {
  if (
    !queueRecord(value) ||
    !Array.isArray(value.ranges) ||
    value.ranges.length < 1 ||
    value.ranges.length > CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRanges
  )
    throw new Error("invalid private context ranges");

  const paths = new Set<string>();
  let previousPath: string | undefined;
  let previousStart = 0;
  let previousEnd = 0;
  let totalLines = 0;
  for (const candidate of value.ranges) {
    if (
      !queueRecord(candidate) ||
      !queueExactKeys(candidate, [
        CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD.REPO_RELATIVE_PATH,
        CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD.START_LINE,
        CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD.END_LINE,
      ]) ||
      !validPath(candidate.repo_relative_path) ||
      !validRange(candidate.start_line, candidate.end_line)
    )
      throw new Error("invalid private context range");

    const path = candidate.repo_relative_path;
    const start = candidate.start_line as number;
    const end = candidate.end_line as number;
    paths.add(path);
    if (previousPath !== undefined) {
      const pathOrder = bytewise(previousPath, path);
      if (
        pathOrder > 0 ||
        (pathOrder === 0 &&
          (start < previousStart || (start === previousStart && end <= previousEnd)))
      )
        throw new Error("private context ranges are not canonical");
      if (pathOrder === 0 && start <= previousEnd)
        throw new Error("private context ranges overlap");
    }
    previousPath = path;
    previousStart = start;
    previousEnd = end;
    totalLines += end - start + 1;
  }
  if (
    paths.size > CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxFiles ||
    totalLines > CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxTotalLines
  )
    throw new Error("invalid private context range aggregate");
}

export function assertConversationPrivateRangesSelectionV2(
  value: unknown,
): asserts value is ConversationPrivateRangesSelectionV2 {
  if (
    !queueRecord(value) ||
    !queueExactKeys(value, CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.RANGES_SELECTION)
  )
    throw new Error("invalid private context ranges selection");
  assertConversationPrivateRangesV2(value);
}
