// Pure selection/render helpers for the private-range file preview.
// The panel fetches a repo file via guarded /api/file, renders numbered
// lines, and lets the user click to pick a start/end line — git-diff style.
// Everything testable lives here; the .vue stays thin.

export interface PrivateRangePreviewDraft {
  path: string;
  startLine: number | null;
  endLine: number | null;
}

export const PREVIEW_MAX_LINES = 2000;
export const PREVIEW_WINDOW_LINES = 500;

/** Clicking a line advances the selection: none → start, start → end (swap
 *  when clicked above start), complete → fresh start. */
export function selectRangeOnLine(
  draft: PrivateRangePreviewDraft,
  line: number,
): PrivateRangePreviewDraft {
  if (draft.startLine === null) return { ...draft, startLine: line, endLine: null };
  if (draft.endLine === null) {
    const start = draft.startLine;
    return line < start
      ? { ...draft, startLine: line, endLine: start }
      : { ...draft, endLine: line };
  }
  return { ...draft, startLine: line, endLine: null };
}

/** Visible window [from, to] clamped to the file and centered on the range
 *  when the file exceeds the window; empty when no lines. */
export function previewWindow(
  draft: PrivateRangePreviewDraft,
  lineCount: number,
): { from: number; to: number } {
  if (lineCount <= 0) return { from: 0, to: 0 };
  const last = Math.min(lineCount, PREVIEW_MAX_LINES);
  if (last <= PREVIEW_WINDOW_LINES) return { from: 1, to: last };
  const start = Math.max(1, draft.startLine ?? 1);
  const end = Math.min(start, Math.min(draft.endLine ?? last, last));
  const low = Math.max(1, Math.min(start, end) - Math.floor(PREVIEW_WINDOW_LINES / 2));
  const from = Math.min(low, last - PREVIEW_WINDOW_LINES + 1);
  return { from, to: from + PREVIEW_WINDOW_LINES - 1 };
}

/** True when `line` falls inside the staged selection. */
export function lineInRange(draft: PrivateRangePreviewDraft, line: number): boolean {
  if (draft.startLine === null) return false;
  if (draft.endLine === null) return line === draft.startLine;
  const low = Math.min(draft.startLine, draft.endLine);
  const high = Math.max(draft.startLine, draft.endLine);
  return line >= low && line <= high;
}

const PREVIEW_ERROR_MESSAGES: Record<string, string> = {
  forbidden: "File nằm ngoài workspace — chọn đường dẫn repo-relative (vd src/server.ts).",
  "not found": "Không tìm thấy file tại đường dẫn này.",
  "too large": "File quá lớn để xem trước (giới hạn 256 KB).",
  binary: "File nhị phân không thể xem trước.",
};

export function parseFilePreviewError(reason: string | undefined): string | null {
  if (!reason) return "Không thể đọc file.";
  return PREVIEW_ERROR_MESSAGES[reason] ?? `Không thể đọc file (${reason}).`;
}
