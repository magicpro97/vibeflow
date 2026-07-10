import { describe, expect, test } from "bun:test";
import { prefillFromOpenedFile } from "../src/ui/src/lib/ask-prefill.js";

describe("prefillFromOpenedFile (#583 ask-prefill)", () => {
  test("path + line → { path, start: line, end: line }", () => {
    expect(prefillFromOpenedFile({ path: "src/cli.ts", line: 42 })).toEqual({
      path: "src/cli.ts",
      start: 42,
      end: 42,
    });
  });

  test("path, no line → start=end=1", () => {
    expect(prefillFromOpenedFile({ path: "README.md" })).toEqual({
      path: "README.md",
      start: 1,
      end: 1,
    });
  });

  test("path, line 0 → start=end=1 (guards validateAskForm's start>=1)", () => {
    expect(prefillFromOpenedFile({ path: "src/a.ts", line: 0 })).toEqual({
      path: "src/a.ts",
      start: 1,
      end: 1,
    });
  });

  test("null opened → null", () => {
    expect(prefillFromOpenedFile(null)).toBeNull();
  });

  test("opened with no path (line only) → null", () => {
    expect(prefillFromOpenedFile({ line: 10 })).toBeNull();
  });
});
