const { describe, expect, test } = await import(String("bun:test"));
import {
  type PrivateRangePreviewDraft,
  lineInRange,
  parseFilePreviewError,
  previewWindow,
  selectRangeOnLine,
} from "../home-private-range-preview.js";

const draft = (
  startLine: number | null = null,
  endLine: number | null = null,
): PrivateRangePreviewDraft => ({
  path: "src/server.ts",
  startLine,
  endLine,
});

describe("private range preview selection", () => {
  test("first click sets start, second click sets end, below-start swaps", () => {
    expect(selectRangeOnLine(draft(), 10)).toEqual(draft(10));
    expect(selectRangeOnLine(draft(10), 20)).toEqual(draft(10, 20));
    expect(selectRangeOnLine(draft(10, 20), 5)).toEqual(draft(5));
    expect(selectRangeOnLine(draft(10), 3)).toEqual(draft(3, 10));
  });

  test("lineInRange respects single line and reversed ranges", () => {
    expect(lineInRange(draft(), 1)).toBe(false);
    expect(lineInRange(draft(5), 5)).toBe(true);
    expect(lineInRange(draft(5), 6)).toBe(false);
    expect(lineInRange(draft(5, 2), 4)).toBe(true);
    expect(lineInRange(draft(5, 2), 1)).toBe(false);
  });
});

describe("private range preview window", () => {
  test("small file shows everything", () => {
    expect(previewWindow(draft(), 42)).toEqual({ from: 1, to: 42 });
  });

  test("clamps to the preview line cap", () => {
    expect(previewWindow(draft(), 3000)).toEqual({ from: 1, to: 500 });
  });

  test("centers the window on the selection for large files", () => {
    const window = previewWindow(draft(900, 910), 2000);
    expect(window.from).toBeGreaterThan(1);
    expect(window.to - window.from + 1).toBe(500);
    expect(window.from).toBeLessThanOrEqual(900);
    expect(window.to).toBeGreaterThanOrEqual(910);
  });

  test("empty file yields no window", () => {
    expect(previewWindow(draft(), 0)).toEqual({ from: 0, to: 0 });
  });
});

describe("private range preview errors", () => {
  test("maps known reasons and falls back for unknown", () => {
    expect(parseFilePreviewError("not found")).toContain("Không tìm thấy");
    expect(parseFilePreviewError("forbidden")).toContain("repo-relative");
    expect(parseFilePreviewError("too large")).toContain("256 KB");
    expect(parseFilePreviewError("binary")).toContain("nhị phân");
    expect(parseFilePreviewError("whatever")).toContain("whatever");
    expect(parseFilePreviewError(undefined)).not.toBeNull();
  });
});
