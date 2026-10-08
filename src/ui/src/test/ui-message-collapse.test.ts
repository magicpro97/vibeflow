// "bun:test" is imported dynamically (String(...)) so vue-tsc (src/ui build)
// never sees the module dependency — repo pattern, same as ui-use-home-engines.test.ts.
const { describe, expect, test } = await import(String("bun:test"));
import {
  COLLAPSE_MIN_CHARS,
  collapsePreview,
  shouldCollapseAnswer,
} from "../lib/message-collapse.js";

describe("message collapse", () => {
  test("collapses only long, complete, non-last assistant answers", () => {
    const long = "x".repeat(COLLAPSE_MIN_CHARS);
    expect(
      shouldCollapseAnswer({ kind: "assistant", complete: true, body: long, isLast: false }),
    ).toBe(true);
    expect(
      shouldCollapseAnswer({ kind: "assistant", complete: true, body: long, isLast: true }),
    ).toBe(false);
    expect(
      shouldCollapseAnswer({ kind: "assistant", complete: false, body: long, isLast: false }),
    ).toBe(false);
    expect(shouldCollapseAnswer({ kind: "user", complete: true, body: long, isLast: false })).toBe(
      false,
    );
    expect(
      shouldCollapseAnswer({ kind: "assistant", complete: true, body: "short", isLast: false }),
    ).toBe(false);
  });

  test("preview cuts on a word boundary and appends an ellipsis", () => {
    const body = `${"word ".repeat(120)}end`;
    const preview = collapsePreview(body);
    expect(preview.length).toBeLessThanOrEqual(401);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.includes("wo…")).toBe(false);
    expect(collapsePreview("tiny")).toBe("tiny");
  });
});
