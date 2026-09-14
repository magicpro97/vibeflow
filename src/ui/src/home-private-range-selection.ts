import type { PrivateRangePreviewDraft } from "./home-private-range-preview.js";

export interface PrivateRangeSelectionRange {
  readonly repo_relative_path: string;
  readonly start_line: number;
  readonly end_line: number;
}

export interface PrivateRangeSelection {
  readonly files: readonly string[];
  readonly activeFile: string | null;
  readonly ranges: readonly PrivateRangeSelectionRange[];
}

export interface PrivateRangeSelectionLimits {
  readonly maxFiles: number;
  readonly maxRanges: number;
  readonly maxLinesPerRange: number;
  readonly maxTotalLines: number;
}

export const PRIVATE_RANGE_SELECTION_LIMITS: PrivateRangeSelectionLimits = Object.freeze({
  maxFiles: 16,
  maxRanges: 32,
  maxLinesPerRange: 200,
  maxTotalLines: 1_000,
});

export function createPrivateRangeSelection(): PrivateRangeSelection {
  return { files: [], activeFile: null, ranges: [] };
}

export function addFile(selection: PrivateRangeSelection, path: string): PrivateRangeSelection {
  if (selection.files.includes(path)) return { ...selection, activeFile: path };
  if (selection.files.length >= PRIVATE_RANGE_SELECTION_LIMITS.maxFiles)
    throw new Error("private range selection exceeds maximum file count");
  const files = [...selection.files, path];
  return { ...selection, files, activeFile: path };
}

export function removeFile(selection: PrivateRangeSelection, path: string): PrivateRangeSelection {
  if (!selection.files.includes(path)) return selection;
  const files = selection.files.filter((file) => file !== path);
  const ranges = selection.ranges.filter((range) => range.repo_relative_path !== path);
  const activeFile = selection.activeFile === path ? (files[0] ?? null) : selection.activeFile;
  return { files, activeFile, ranges };
}

export function selectActiveFile(
  selection: PrivateRangeSelection,
  path: string,
): PrivateRangeSelection {
  if (!selection.files.includes(path)) throw new Error("private range file is not selected");
  return { ...selection, activeFile: path };
}

function normalizeRange(
  path: string,
  range: Pick<PrivateRangePreviewDraft, "startLine" | "endLine">,
): PrivateRangeSelectionRange {
  if (
    range.startLine === null ||
    range.endLine === null ||
    !Number.isSafeInteger(range.startLine) ||
    !Number.isSafeInteger(range.endLine) ||
    range.startLine < 1 ||
    range.endLine < 1
  )
    throw new Error("private range lines must be positive safe integers");
  if (range.startLine > range.endLine) throw new Error("private range line order is invalid");
  const startLine = range.startLine;
  const endLine = range.endLine;
  if (endLine - startLine + 1 > PRIVATE_RANGE_SELECTION_LIMITS.maxLinesPerRange)
    throw new Error("private range must not exceed maximum lines per range");
  return { repo_relative_path: path, start_line: startLine, end_line: endLine };
}

function fileIndex(selection: PrivateRangeSelection, path: string): number {
  const index = selection.files.indexOf(path);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

export function mergeRanges(
  ranges: readonly PrivateRangeSelectionRange[],
): PrivateRangeSelectionRange[] {
  const grouped = new Map<string, PrivateRangeSelectionRange[]>();
  for (const range of ranges) {
    const current = grouped.get(range.repo_relative_path) ?? [];
    current.push({ ...range });
    grouped.set(range.repo_relative_path, current);
  }
  const merged: PrivateRangeSelectionRange[] = [];
  for (const [path, pathRanges] of grouped) {
    pathRanges.sort(
      (left, right) => left.start_line - right.start_line || left.end_line - right.end_line,
    );
    for (const range of pathRanges) {
      const previous = merged.at(-1);
      if (
        previous &&
        previous.repo_relative_path === path &&
        range.start_line <= previous.end_line + 1
      ) {
        const mergedEnd = Math.max(previous.end_line, range.end_line);
        if (mergedEnd - previous.start_line + 1 > PRIVATE_RANGE_SELECTION_LIMITS.maxLinesPerRange)
          throw new Error("private range must not exceed maximum lines per range");
        merged[merged.length - 1] = {
          ...previous,
          end_line: mergedEnd,
        };
      } else {
        merged.push({ ...range });
      }
    }
  }
  return merged;
}

function orderRanges(
  selection: PrivateRangeSelection,
  ranges: readonly PrivateRangeSelectionRange[],
): PrivateRangeSelectionRange[] {
  return [...ranges].sort(
    (left, right) =>
      fileIndex(selection, left.repo_relative_path) -
        fileIndex(selection, right.repo_relative_path) ||
      left.start_line - right.start_line ||
      left.end_line - right.end_line,
  );
}

function totalLines(ranges: readonly PrivateRangeSelectionRange[]): number {
  return ranges.reduce((total, range) => total + range.end_line - range.start_line + 1, 0);
}

export function commitRange(
  selection: PrivateRangeSelection,
  path: string,
  range: Pick<PrivateRangePreviewDraft, "startLine" | "endLine">,
): PrivateRangeSelection {
  if (!selection.files.includes(path)) throw new Error("private range file is not selected");
  const next = normalizeRange(path, range);
  const ranges = orderRanges(selection, mergeRanges([...selection.ranges, next]));
  if (ranges.length > PRIVATE_RANGE_SELECTION_LIMITS.maxRanges)
    throw new Error("private range selection exceeds maximum range count");
  if (totalLines(ranges) > PRIVATE_RANGE_SELECTION_LIMITS.maxTotalLines)
    throw new Error("private range selection exceeds maximum total lines");
  return { ...selection, activeFile: path, ranges };
}

export function removeRange(
  selection: PrivateRangeSelection,
  path: string,
  range: Pick<PrivateRangePreviewDraft, "startLine" | "endLine">,
): PrivateRangeSelection {
  const target = normalizeRange(path, range);
  const ranges = selection.ranges.filter(
    (candidate) =>
      candidate.repo_relative_path !== target.repo_relative_path ||
      candidate.start_line !== target.start_line ||
      candidate.end_line !== target.end_line,
  );
  return { ...selection, ranges };
}

export function clearSelection(_selection: PrivateRangeSelection): PrivateRangeSelection {
  return createPrivateRangeSelection();
}

export function selectionSummary(selection: PrivateRangeSelection): {
  files: number;
  ranges: number;
  lines: number;
} {
  return {
    files: selection.files.length,
    ranges: selection.ranges.length,
    lines: totalLines(selection.ranges),
  };
}

export function selectionRanges(selection: PrivateRangeSelection): PrivateRangeSelectionRange[] {
  return orderRanges(selection, mergeRanges(selection.ranges));
}
