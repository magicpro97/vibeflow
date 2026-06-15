import { describe, expect, test } from "bun:test";
import { esc } from "../src/ui/escape.js";

describe("esc()", () => {
  test("escapes script tag", () => {
    expect(esc("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("escapes attribute-breaking quote", () => {
    expect(esc('" onmouseover="alert(1)')).toBe("&quot; onmouseover=&quot;alert(1)");
  });

  test("handles null and undefined", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
  });

  test("handles numbers and booleans", () => {
    expect(esc(42)).toBe("42");
    expect(esc(true)).toBe("true");
  });
});
