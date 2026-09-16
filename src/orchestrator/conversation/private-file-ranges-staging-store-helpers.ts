import { CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS } from "./conversation-private-context-broker-contract.js";
import {
  type PrivateFileRangesStageInputV1,
  isPrivateFileRangeRepoRelativePath,
} from "./private-file-ranges-staging-contract.js";

export function normalizePrivateFileRanges(
  ranges: PrivateFileRangesStageInputV1["ranges"],
): PrivateFileRangesStageInputV1["ranges"] {
  if (
    !Array.isArray(ranges) ||
    ranges.length < 1 ||
    ranges.length > CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRanges
  )
    throw new Error("invalid private file ranges aggregate");
  const sorted = [...ranges];
  for (const range of sorted) {
    if (
      typeof range !== "object" ||
      range === null ||
      typeof range.repo_relative_path !== "string" ||
      !isPrivateFileRangeRepoRelativePath(range.repo_relative_path) ||
      !Number.isSafeInteger(range.start_line) ||
      !Number.isSafeInteger(range.end_line) ||
      range.start_line < 1 ||
      range.end_line < range.start_line ||
      range.end_line - range.start_line + 1 >
        CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxFileRangeLines
    )
      throw new Error("invalid private file ranges aggregate");
  }
  sorted.sort((left, right) => {
    const leftRange = left as { repo_relative_path: string; start_line: number; end_line: number };
    const rightRange = right as {
      repo_relative_path: string;
      start_line: number;
      end_line: number;
    };
    return (
      Buffer.compare(
        Buffer.from(leftRange.repo_relative_path, "utf8"),
        Buffer.from(rightRange.repo_relative_path, "utf8"),
      ) ||
      leftRange.start_line - rightRange.start_line ||
      leftRange.end_line - rightRange.end_line
    );
  });
  const normalized: Array<PrivateFileRangesStageInputV1["ranges"][number]> = [];
  for (const range of sorted) {
    if (typeof range !== "object" || range === null)
      throw new Error("invalid private file ranges aggregate");
    const prior = normalized.at(-1);
    if (
      prior &&
      prior.repo_relative_path === range.repo_relative_path &&
      range.start_line <= prior.end_line + 1
    ) {
      const endLine = Math.max(prior.end_line, range.end_line);
      if (
        endLine - prior.start_line + 1 >
        CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxFileRangeLines
      )
        throw new Error("invalid private file ranges aggregate");
      normalized[normalized.length - 1] = { ...prior, end_line: endLine };
    } else normalized.push({ ...range });
  }
  const fileCount = new Set(normalized.map((range) => range.repo_relative_path)).size;
  const totalLines = normalized.reduce(
    (sum, range) => sum + range.end_line - range.start_line + 1,
    0,
  );
  if (
    fileCount > CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxFiles ||
    normalized.length > CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRanges ||
    totalLines > CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxTotalLines
  )
    throw new Error("invalid private file ranges aggregate");
  return normalized;
}
